//! The heart of the engine: applying commands and rendering a quantum.
//!
//! `Engine` owns neither the output buffers nor the exchange area — it is
//! handed slices. Ownership of that memory sits in the C-ABI layer (§5.2):
//! that is where addresses must stay stable between calls, and that is where
//! all the `unsafe` lives. What remains here is pure DSP, testable with plain
//! `cargo test` on the native target and able to render anywhere — including
//! into the offline render buffer at M3.
//!
//! The rules of §3.10 apply from the first line: no allocation in `process`,
//! feedback state is flushed below a threshold, the module has a `reset`,
//! behaviour is deterministic.

use crate::commands::Command;
use crate::ring::CommandBlock;
use crate::transport::Transport;

/// Telemetry words, in the order the worklet copies them into the SAB (§6.2).
///
/// `underrun_count` is deliberately absent: the engine cannot notice a missed
/// `process` call at all — only the worklet observes that, and it writes that
/// counter into the SAB directly.
pub const TELEMETRY_WORDS: usize = 4;
pub const TELEMETRY_TRANSPORT_LO: usize = 0;
pub const TELEMETRY_TRANSPORT_HI: usize = 1;
/// Peak levels sit in these words as `f32` bits (`f32::to_bits`).
/// On the JS side the same bytes are read through a `Float32Array` view.
pub const TELEMETRY_PEAK_L: usize = 2;
pub const TELEMETRY_PEAK_R: usize = 3;

/// Denormal flush threshold (§3.10, rule 1).
const DENORMAL_THRESHOLD: f32 = 1e-20;

/// Flush denormals to zero. WASM has no FPU-level flush-to-zero, so decaying
/// tails have to be cut off by hand — otherwise CPU climbs during silence.
#[inline(always)]
fn fz(x: f32) -> f32 {
    if x.abs() < DENORMAL_THRESHOLD { 0.0 } else { x }
}

/// Click frequency on a beat and on the first beat of a bar.
const CLICK_HZ: f32 = 1000.0;
const CLICK_ACCENT_HZ: f32 = 1600.0;
/// Decay time constant of the click.
const CLICK_DECAY_SECONDS: f32 = 0.008;
/// Level below which the voice counts as finished and switches off.
/// −80 dB is inaudible, and an exact zero gives real silence between clicks.
const CLICK_GATE: f32 = 1e-4;
const CLICK_GAIN: f32 = 0.25;

/// Accent every fourth beat. Bar length is fixed at M0: time signatures are
/// M2 work, and without an accent you cannot tell a steady metronome from a
/// drifting one by ear.
const BEATS_PER_BAR: i64 = 4;

/// How far a peak reading falls per second. A meter needs ballistics: the UI
/// reads telemetry in `requestAnimationFrame`, i.e. once every several quanta,
/// and would simply never see an instantaneous value.
const PEAK_FALL_PER_SECOND: f32 = 0.05;

/// The metronome voice: a decaying sine.
#[derive(Debug, Clone)]
struct Click {
    sample_rate: f32,
    phase: f32,
    phase_step: f32,
    env: f32,
    env_decay: f32,
}

impl Click {
    fn new(sample_rate: f64) -> Self {
        let sample_rate = sample_rate as f32;
        Self {
            sample_rate,
            phase: 0.0,
            phase_step: 0.0,
            env: 0.0,
            env_decay: (-1.0 / (CLICK_DECAY_SECONDS * sample_rate)).exp(),
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.phase_step = 0.0;
        self.env = 0.0;
    }

    /// Retriggering cuts the previous tail short — which is exactly how a
    /// metronome should behave. Phase starts at zero, i.e. at a zero crossing:
    /// starting from an arbitrary phase would produce a step, and a click on
    /// top of the click.
    fn trigger(&mut self, hz: f32) {
        self.phase = 0.0;
        self.phase_step = std::f32::consts::TAU * hz / self.sample_rate;
        self.env = 1.0;
    }

    #[inline]
    fn next_sample(&mut self) -> f32 {
        if self.env == 0.0 {
            return 0.0;
        }
        let sample = self.phase.sin() * self.env * CLICK_GAIN;

        self.phase += self.phase_step;
        if self.phase >= std::f32::consts::TAU {
            self.phase -= std::f32::consts::TAU;
        }

        // The envelope is feedback state (§3.10, rule 1). The gate switches
        // off a finished voice; fz is the backstop against denormals should
        // the gate threshold ever be lowered.
        let env = fz(self.env * self.env_decay);
        self.env = if env < CLICK_GATE { 0.0 } else { env };

        sample
    }
}

pub struct Engine {
    transport: Transport,
    click: Click,
    peak: [f32; 2],
}

impl Engine {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            transport: Transport::new(sample_rate),
            click: Click::new(sample_rate),
            peak: [0.0; 2],
        }
    }

    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    pub fn peak(&self, channel: usize) -> f32 {
        self.peak.get(channel).copied().unwrap_or(0.0)
    }

    /// Return to the "as constructed" state (§3.10, rule 5). Without it the
    /// offline render would be comparing a warmed-up instance to a cold one.
    pub fn reset(&mut self) {
        let sample_rate = self.transport.sample_rate();
        self.transport = Transport::new(sample_rate);
        self.click.reset();
        self.peak = [0.0; 2];
    }

    /// Render one quantum.
    ///
    /// `commands` is the copy of records taken from the SAB, `cmd_count` is
    /// how many of them the worklet claimed (untrusted; clamped inside
    /// [`CommandBlock`]). Quantum length comes from the slices: the shorter of
    /// the two decides.
    ///
    /// There is no allocation, no locking and no panic here, and there cannot
    /// be — this is the hot path, with a budget of a fraction of a millisecond.
    pub fn process(
        &mut self,
        out_l: &mut [f32],
        out_r: &mut [f32],
        commands: &[u8],
        cmd_count: u32,
    ) {
        let frames = out_l.len().min(out_r.len());
        let block = CommandBlock::new(commands, cmd_count);
        let total = block.len();

        // Command offsets are measured from the position at the start of the
        // quantum. The transport advances segment by segment inside the
        // quantum, so this reference point has to be captured up front.
        let quantum_start = self.transport.sample_pos();

        let mut done = 0usize;
        let mut cursor = 0usize;

        loop {
            // Apply everything scheduled at or before the frame reached so
            // far, strictly in submission order: SetBpm before and after Play
            // sound different.
            let mut next_edge = frames;
            while cursor < total {
                let Some(entry) = block.entry(cursor, quantum_start, frames as u32) else {
                    // An unrecognised record means we are out of sync with
                    // `protocol.ts`. Skip it: stopping mid-quantum is worse.
                    cursor += 1;
                    continue;
                };
                match entry.offset {
                    // The instant has not arrived yet. This cannot happen at
                    // M0 — the UI only sends immediate commands; a queue of
                    // deferred ones arrives together with scheduling ahead.
                    None => cursor += 1,
                    Some(offset) if offset as usize <= done => {
                        self.apply(entry.record.command);
                        cursor += 1;
                    }
                    Some(offset) => {
                        next_edge = offset as usize;
                        break;
                    }
                }
            }

            if done >= frames {
                break;
            }

            // next_edge is strictly greater than done: the branch above only
            // fires for offset > done. So every lap advances the render.
            self.render_segment(&mut out_l[done..next_edge], &mut out_r[done..next_edge]);
            done = next_edge;
        }
    }

    /// Telemetry to be copied into the SAB. Position is split into two `u32`
    /// words (§6.1); the seqlock around them is the worklet's job, because
    /// what needs protecting is the moment of reading on the other side, not
    /// the write here.
    pub fn write_telemetry(&self, words: &mut [u32]) {
        if words.len() < TELEMETRY_WORDS {
            return;
        }
        let pos = self.transport.sample_pos();
        words[TELEMETRY_TRANSPORT_LO] = pos as u32;
        words[TELEMETRY_TRANSPORT_HI] = (pos >> 32) as u32;
        words[TELEMETRY_PEAK_L] = self.peak[0].to_bits();
        words[TELEMETRY_PEAK_R] = self.peak[1].to_bits();
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Play => self.transport.play(),
            // The click tail is deliberately left to ring out: an abrupt cut
            // of the buffer is precisely the click that ruins the sound.
            Command::Stop => self.transport.stop(),
            Command::SetBpm { bpm } => self.transport.set_bpm(f64::from(bpm)),
        }
    }

    /// A stretch of the quantum between two commands. Tempo and transport
    /// state do not change inside it, so the beat boundary need only be
    /// computed once per segment rather than once per frame.
    fn render_segment(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len();
        if frames == 0 {
            return;
        }

        let playing = self.transport.is_playing();
        let mut pos = self.transport.sample_pos();
        // While paused the position stands still and crosses no beat
        // boundaries, but the tail of the previous click must ring out.
        let mut next_click = if playing { self.transport.next_beat_boundary(pos) } else { u64::MAX };

        for frame in 0..frames {
            if pos == next_click {
                let beat = self.transport.beat_at(pos).round() as i64;
                let accent = beat.rem_euclid(BEATS_PER_BAR) == 0;
                self.click.trigger(if accent { CLICK_ACCENT_HZ } else { CLICK_HZ });
                next_click = self.transport.next_beat_boundary(pos + 1);
            }

            let sample = self.click.next_sample();
            // §3.10, rule 3: a NaN poisons feedback forever.
            debug_assert!(sample.is_finite(), "non-finite sample out of the metronome");

            out_l[frame] = sample;
            out_r[frame] = sample;

            if playing {
                pos += 1;
            }
        }

        self.transport.advance(frames as u32);
        self.update_peaks(out_l, out_r);
    }

    fn update_peaks(&mut self, out_l: &[f32], out_r: &[f32]) {
        let seconds = out_l.len() as f32 / self.transport.sample_rate() as f32;
        let decay = PEAK_FALL_PER_SECOND.powf(seconds);

        for (channel, out) in [out_l, out_r].into_iter().enumerate() {
            // f32::max returns the non-NaN argument, so a stray NaN on the
            // input will not poison the meter reading permanently.
            let block_peak = out.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
            // The falling reading is feedback state (§3.10, rule 1).
            self.peak[channel] = fz(self.peak[channel] * decay).max(block_peak);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Record;

    const SR: f64 = 48_000.0;
    /// The Web Audio render quantum.
    const Q: usize = 128;
    /// A tempo with a fractional beat length — round ones hide rounding bugs.
    const AWKWARD_BPM: f32 = 127.0;

    fn encode(records: &[Record]) -> Vec<u8> {
        records.iter().flat_map(|r| r.encode()).collect()
    }

    /// One quantum. Also checks the M0 mono invariant: the channels match.
    fn quantum(engine: &mut Engine, records: &[Record]) -> Vec<f32> {
        let bytes = encode(records);
        let mut left = vec![0.0f32; Q];
        let mut right = vec![0.0f32; Q];
        engine.process(&mut left, &mut right, &bytes, records.len() as u32);
        assert_eq!(left, right, "the M0 engine is mono: channels must match");
        left
    }

    fn render(engine: &mut Engine, quanta: usize) -> Vec<f32> {
        (0..quanta).flat_map(|_| quantum(engine, &[])).collect()
    }

    /// A run that discards the signal — for long stretches of silence.
    fn skip(engine: &mut Engine, quanta: usize) {
        let mut left = [0.0f32; Q];
        let mut right = [0.0f32; Q];
        for _ in 0..quanta {
            engine.process(&mut left, &mut right, &[], 0);
        }
    }

    /// Length of the click tail in frames — from trigger to the gate closing.
    fn tail_frames() -> usize {
        (CLICK_DECAY_SECONDS * (1.0 / CLICK_GATE).ln() * SR as f32) as usize
    }

    fn started(bpm: f32) -> (Engine, Vec<f32>) {
        let mut engine = Engine::new(SR);
        let signal = quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetBpm { bpm }),
                Record::immediate(Command::Play),
            ],
        );
        (engine, signal)
    }

    /// Positions at which clicks begin.
    ///
    /// A click starts at zero phase, so its first sample is exactly zero, and
    /// the onset is taken as the last zero sample before a sounding stretch.
    /// Works as long as beats are longer than the click tail (~80 ms), i.e.
    /// up to 750 BPM.
    fn onsets(signal: &[f32]) -> Vec<usize> {
        let mut result = Vec::new();
        let mut was_sounding = false;
        for (i, &sample) in signal.iter().enumerate() {
            let sounding = sample != 0.0;
            if sounding && !was_sounding {
                result.push(i.saturating_sub(1));
            }
            was_sounding = sounding;
        }
        result
    }

    #[test]
    fn silent_until_play() {
        let mut engine = Engine::new(SR);
        assert!(
            render(&mut engine, 100).iter().all(|&s| s == 0.0),
            "the output must be silent before the Play command"
        );
        assert_eq!(engine.transport().sample_pos(), 0);
    }

    #[test]
    fn play_produces_sound() {
        let (_, first) = started(120.0);
        assert!(first.iter().any(|&s| s != 0.0), "sound must start after Play");
    }

    #[test]
    fn first_click_is_at_the_very_first_sample() {
        let (_, first) = started(120.0);
        assert_eq!(onsets(&first), vec![0], "playback begins on a beat");
    }

    /// The milestone's key test: clicks land exactly on beats and none is lost.
    #[test]
    fn clicks_land_exactly_on_beats() {
        for bpm in [120.0f32, AWKWARD_BPM, 200.0] {
            let (mut engine, mut signal) = started(bpm);
            signal.extend(render(&mut engine, 2_000)); // ~5.3 s

            let reference = {
                let mut t = Transport::new(SR);
                t.set_bpm(f64::from(bpm));
                t
            };
            let expected: Vec<usize> = (0i64..)
                .map(|beat| reference.sample_of_beat(beat as f64) as usize)
                // An onset is recognised by the sample that follows it, so a
                // beat at the very end of the signal does not count.
                .take_while(|&pos| pos + 1 < signal.len())
                .collect();

            assert_eq!(onsets(&signal), expected, "bpm={bpm}");
        }
    }

    #[test]
    fn accent_falls_on_every_fourth_beat() {
        let (mut engine, mut signal) = started(120.0);
        signal.extend(render(&mut engine, 400)); // ~1.07 s, 3 beats

        // The accent click is higher in pitch, so it climbs away from zero
        // phase faster. Compare the sample 8 frames in: at 1600 Hz (period 30
        // frames) it is already past the peak, at 1000 Hz (period 48) not yet.
        let heights: Vec<f32> = onsets(&signal)
            .iter()
            .map(|&onset| signal[onset + 8].abs())
            .collect();
        assert!(heights.len() >= 3, "expected at least three clicks");
        assert!(
            heights[0] > heights[1] && heights[0] > heights[2],
            "the first beat of the bar must differ from the rest: {heights:?}"
        );
        assert!(
            (heights[1] - heights[2]).abs() < 1e-6,
            "unaccented beats must be identical: {heights:?}"
        );
    }

    #[test]
    fn stop_silences_the_transport_but_lets_the_tail_decay() {
        let (mut engine, _) = started(120.0);
        let tail = quantum(&mut engine, &[Record::immediate(Command::Stop)]);

        assert!(!engine.transport().is_playing());
        assert_eq!(engine.transport().sample_pos(), 0, "Stop rewinds to the start");
        assert!(
            tail.iter().any(|&s| s != 0.0),
            "the click tail must ring out: cutting the buffer is itself a click"
        );

        // 500 quanta is 1.3 s, i.e. two beats at 120 BPM. Had the transport
        // kept running, clicks would be audible. We measure from the end of
        // the tail: it lasts far longer than a single quantum.
        let after = render(&mut engine, 500);
        assert!(
            after[tail_frames() + Q..].iter().all(|&s| s == 0.0),
            "after Stop there must be neither tail nor new clicks"
        );
    }

    #[test]
    fn click_tail_ends_in_exact_silence() {
        // The voice gate must produce an exact zero, not an endless denormal
        // tail (§3.10, rule 1).
        let (mut engine, _) = started(120.0);
        let quiet = render(&mut engine, 100); // ~0.27 s; the next beat is far off
        assert_eq!(
            quiet[quiet.len() - Q..].iter().copied().fold(0.0f32, f32::max),
            0.0,
            "the tail does not converge to an exact zero"
        );
    }

    #[test]
    fn command_takes_effect_mid_quantum() {
        let mut engine = Engine::new(SR);
        let bytes = encode(&[Record { command: Command::Play, at_sample: 64 }]);
        let mut left = vec![0.0f32; Q];
        let mut right = vec![0.0f32; Q];
        engine.process(&mut left, &mut right, &bytes, 1);

        assert!(
            left[..64].iter().all(|&s| s == 0.0),
            "there must be silence before the moment of application"
        );
        assert_eq!(onsets(&left), vec![64], "the click must start exactly on frame 64");
        assert_eq!(
            engine.transport().sample_pos(),
            64,
            "the transport only counts from the moment of Play"
        );
    }

    #[test]
    fn tempo_change_reaches_the_grid() {
        let (mut engine, mut signal) = started(120.0);
        signal.extend(render(&mut engine, 200));
        signal.extend(quantum(&mut engine, &[Record::immediate(Command::SetBpm { bpm: 240.0 })]));
        signal.extend(render(&mut engine, 600));

        let found = onsets(&signal);
        assert_eq!(found[0], 0);
        assert_eq!(found[1], 24_000, "this beat was struck in the old tempo");

        // The grid is anchored to beat numbers, not to the moment of the
        // tempo change. The command arrived at position 25728, i.e. at beat
        // 1.072; beat 2 remains beat 2 and arrives 0.928 of a new-tempo beat
        // later: 25728 + 0.928 × 12000 = 36864. Exactly 36000 would only
        // happen if the tempo changed precisely on a beat boundary.
        assert_eq!(found[2], 36_864, "the new tempo was not applied from the beat number");

        let gaps: Vec<usize> = found.windows(2).skip(2).map(|w| w[1] - w[0]).collect();
        assert!(gaps.len() >= 3, "too few clicks after the tempo change: {found:?}");
        assert!(
            gaps.iter().all(|&gap| gap == 12_000),
            "the new tempo did not take hold: {gaps:?}"
        );
    }

    #[test]
    fn out_of_range_bpm_does_not_break_the_grid() {
        let mut engine = Engine::new(SR);
        for bpm in [f32::NAN, f32::INFINITY, -1.0, 0.0, 1e9] {
            quantum(&mut engine, &[Record::immediate(Command::SetBpm { bpm })]);
            assert!(engine.transport().samples_per_beat().is_finite(), "bpm={bpm}");
        }
        let signal = quantum(&mut engine, &[Record::immediate(Command::Play)]);
        assert!(signal.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn output_stays_finite_and_bounded() {
        let (mut engine, first) = started(AWKWARD_BPM);
        let mut signal = first;
        signal.extend(render(&mut engine, 4_000));
        for (i, &sample) in signal.iter().enumerate() {
            assert!(sample.is_finite(), "non-finite sample at position {i}");
            assert!(sample.abs() <= CLICK_GAIN, "out of range at position {i}");
        }
    }

    #[test]
    fn zero_length_quantum_still_applies_commands() {
        // Web Audio never asks for this, but decoding must stay meaningful:
        // a command must not be lost to an empty quantum.
        let mut engine = Engine::new(SR);
        let bytes = encode(&[Record::immediate(Command::Play)]);
        engine.process(&mut [], &mut [], &bytes, 1);
        assert!(engine.transport().is_playing());
    }

    #[test]
    fn garbage_commands_do_not_break_rendering() {
        let mut engine = Engine::new(SR);
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut bytes = vec![0u8; 64 * 16];
        let mut left = [0.0f32; Q];
        let mut right = [0.0f32; Q];
        for _ in 0..200 {
            for byte in bytes.iter_mut() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *byte = state as u8;
            }
            engine.process(&mut left, &mut right, &bytes, u32::MAX);
            assert!(left.iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn telemetry_reports_position_and_peaks() {
        let (mut engine, _) = started(120.0);
        render(&mut engine, 9);

        let mut words = [0u32; TELEMETRY_WORDS];
        engine.write_telemetry(&mut words);

        let position = u64::from(words[TELEMETRY_TRANSPORT_HI]) << 32
            | u64::from(words[TELEMETRY_TRANSPORT_LO]);
        assert_eq!(position, engine.transport().sample_pos());
        assert_eq!(position, (Q * 10) as u64);
        assert_eq!(f32::from_bits(words[TELEMETRY_PEAK_L]), engine.peak(0));
        assert_eq!(f32::from_bits(words[TELEMETRY_PEAK_R]), engine.peak(1));
        assert!(engine.peak(0) > 0.0, "the click must show up on the meter");
    }

    #[test]
    fn short_telemetry_buffer_is_left_alone() {
        let (engine, _) = started(120.0);
        let mut words = [0xDEAD_BEEFu32; TELEMETRY_WORDS - 1];
        engine.write_telemetry(&mut words);
        assert!(words.iter().all(|&w| w == 0xDEAD_BEEF), "the write ran past the buffer");
    }

    #[test]
    fn peak_decays_to_exact_zero() {
        // The meter reading decays forever and, without an explicit flush,
        // slides into denormals (§3.10, rule 1). An exact zero is the proof
        // that fz is doing its job.
        let (mut engine, _) = started(120.0);
        quantum(&mut engine, &[Record::immediate(Command::Stop)]);
        assert!(engine.peak(0) > 0.0);

        skip(&mut engine, (20.0 * SR / Q as f64) as usize); // 20 s of silence
        assert_eq!(engine.peak(0), 0.0, "the peak reading never reached zero");
        assert_eq!(engine.peak(1), 0.0);
    }

    #[test]
    fn render_is_deterministic() {
        // §3.10, rule 4. Without it §9 does not work: the golden tests at M3
        // compare bit for bit.
        fn script(engine: &mut Engine) -> Vec<f32> {
            let mut signal = quantum(
                engine,
                &[
                    Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
                    Record::immediate(Command::Play),
                ],
            );
            signal.extend(render(engine, 300));
            signal.extend(quantum(engine, &[Record::immediate(Command::SetBpm { bpm: 90.0 })]));
            signal.extend(render(engine, 300));
            signal
        }

        assert_eq!(script(&mut Engine::new(SR)), script(&mut Engine::new(SR)));
    }

    #[test]
    fn reset_restores_the_initial_state() {
        // §3.10, rule 5: otherwise the offline render compares a warmed-up
        // instance to a cold one and diverges from realtime.
        let mut used = Engine::new(SR);
        quantum(&mut used, &[Record::immediate(Command::SetBpm { bpm: 63.5 })]);
        quantum(&mut used, &[Record::immediate(Command::Play)]);
        render(&mut used, 500);
        used.reset();

        assert!(!used.transport().is_playing());
        assert_eq!(used.transport().sample_pos(), 0);
        assert_eq!(used.peak(0), 0.0);

        // The same script on a reset engine and on a fresh one must produce
        // a bit-identical signal.
        let (mut fresh, mut expected) = started(AWKWARD_BPM);
        expected.extend(render(&mut fresh, 200));

        let mut after_reset = quantum(
            &mut used,
            &[
                Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
                Record::immediate(Command::Play),
            ],
        );
        after_reset.extend(render(&mut used, 200));

        assert_eq!(after_reset, expected, "after reset the engine must sound like a new one");
    }
}
