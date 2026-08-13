//! The heart of the engine: applying commands and rendering a quantum.
//!
//! `Engine` owns neither the output buffers nor the exchange area — it is
//! handed slices. Ownership of that memory sits in the C-ABI layer: that is
//! where addresses must stay stable between calls, and that is where all the
//! `unsafe` lives. What remains here is pure DSP, testable with plain
//! `cargo test` on the native target and able to render anywhere — including
//! into an offline render buffer.
//!
//! The house rules for sample-processing code apply from the first line: no
//! allocation in `process`, feedback state flushed below a threshold, an
//! explicit `reset`, deterministic behavior.

use crate::commands::Command;
use crate::dsp::fz;
use crate::mixer::Mixer;
use crate::pattern::Pattern;
use crate::ring::CommandBlock;
use crate::transport::Transport;

/// Telemetry words, in the order the worklet copies them into the SAB.
///
/// This block crosses the ABI, which makes it the second half of the contract
/// `commands.rs` describes the first half of — audio → UI, where that one is
/// UI → audio. The mirror is `web/src/worklet/telemetry-block.ts`, the two are
/// edited together, and [`PROTOCOL_VERSION`](crate::commands::PROTOCOL_VERSION)
/// governs both: a renumbering here without a bump leaves a worklet built
/// yesterday copying the wrong words out of a block built today, and the
/// symptom is wrong numbers on screen with nothing reported anywhere.
/// `tests::telemetry_layout_is_pinned` is what fails first.
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

/// Click frequency on a beat and on the first beat of a bar.
const CLICK_HZ: f32 = 1000.0;
const CLICK_ACCENT_HZ: f32 = 1600.0;
/// Decay time constant of the click.
const CLICK_DECAY_SECONDS: f32 = 0.008;
/// Level below which the voice counts as finished and switches off.
/// −80 dB is inaudible, and an exact zero gives real silence between clicks.
const CLICK_GATE: f32 = 1e-4;
const CLICK_GAIN: f32 = 0.25;

/// Accent every fourth beat. The bar length is fixed for now — time
/// signatures come later — and without an accent you cannot tell a steady
/// metronome from a drifting one by ear.
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

        // The envelope is feedback state. The gate switches off a finished
        // voice; fz is the backstop against denormals should the gate
        // threshold ever be lowered.
        let env = fz(self.env * self.env_decay);
        self.env = if env < CLICK_GATE { 0.0 } else { env };

        sample
    }
}

pub struct Engine {
    transport: Transport,
    click: Click,
    mixer: Mixer,
    pattern: Pattern,
    peak: [f32; 2],
}

impl Engine {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            transport: Transport::new(sample_rate),
            click: Click::new(sample_rate),
            mixer: Mixer::new(sample_rate),
            pattern: Pattern::new(),
            peak: [0.0; 2],
        }
    }

    // Windows onto the engine's state, and that every one of them is read-only
    // is the point rather than an accident.
    //
    // Nothing here hands out `&mut` and no field is public, so the only way a
    // value inside this type changes is a command decoded out of the block —
    // which is the property the whole design rests on: one road in, and it
    // starts in the ring. A setter added among these would be a second road,
    // and it would not announce itself as one; it would look like the four
    // lines above it.
    //
    // Their callers are the tests, and from M3 the offline renderer, which has
    // to read the transport to know when a render is finished. Worth saying,
    // because a method with only tests behind it is normally one to remove, and
    // these are not.

    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    pub fn mixer(&self) -> &Mixer {
        &self.mixer
    }

    pub fn pattern(&self) -> &Pattern {
        &self.pattern
    }

    pub fn peak(&self, channel: usize) -> f32 {
        self.peak.get(channel).copied().unwrap_or(0.0)
    }

    /// Return to the "as constructed" state. Without it the offline render
    /// would be comparing a warmed-up instance to a cold one.
    pub fn reset(&mut self) {
        let sample_rate = self.transport.sample_rate();
        self.transport = Transport::new(sample_rate);
        self.click.reset();
        self.mixer.reset();
        self.pattern.reset();
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
                    // An unrecognized record means we are out of sync with
                    // `protocol.ts`. Skip it: stopping mid-quantum is worse.
                    cursor += 1;
                    continue;
                };
                match entry.offset {
                    // Not this quantum's instant, so the record is **dropped**
                    // — not held back. There is nowhere to hold it: the block
                    // lives for one quantum and the worklet has already taken
                    // these bytes out of the ring, so a record passed over here
                    // is gone. `ring::offset_in_quantum` reports the case and
                    // argues why it is reported rather than clamped; this is
                    // the branch that decides what to do about it.
                    //
                    // Unreachable today: the UI stamps every command 0, meaning
                    // "immediately". `tests::a_command_stamped_for_a_later_quantum_is_dropped`
                    // is what states it, since a comment about what cannot
                    // happen yet is not a description of what does.
                    //
                    // Before anything schedules ahead, two things have to be
                    // settled, and they are one feature rather than two:
                    //
                    // 1. this branch, which needs somewhere to keep a record
                    //    across quanta;
                    // 2. `next_edge` below, taken from the first unapplied
                    //    command in submission order rather than the smallest
                    //    offset among those left — so `Play @ 64` followed by
                    //    `SetBpm @ 32` both land on frame 64.
                    //
                    // The second decides the first. Taking the minimum among
                    // the remaining means the queue may hold records in any
                    // order; a contract that submission order is non-decreasing
                    // in time means it need not sort but must reject. Writing
                    // the queue before that is settled is guessing which.
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
    /// words; the seqlock around them is the worklet's job, because what needs
    /// protecting is the moment of reading on the other side, not to write
    /// here.
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
            Command::SetTrackGain { track, gain } => self.mixer.set_track_gain(track, gain),
            Command::SetTrackPan { track, pan } => self.mixer.set_track_pan(track, pan),
            Command::SetMasterGain { gain } => self.mixer.set_master_gain(gain),
            Command::SetStep { track, step, velocity } => {
                self.pattern.set_step(track, step, velocity)
            }
            Command::ClearPattern => self.pattern.clear(),
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
            // A NaN poisons feedback forever.
            debug_assert!(sample.is_finite(), "non-finite sample out of the metronome");

            // Per frame, not per segment or per quantum: a gain that stepped
            // would be zipper noise, and the smoothing that prevents it only
            // advances when it is asked for a value. The metronome goes
            // through the master like everything else will.
            let sample = sample * self.mixer.next_master_gain();
            debug_assert!(sample.is_finite(), "non-finite sample out of the mixer");

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
            // The falling reading is feedback state.
            self.peak[channel] = fz(self.peak[channel] * decay).max(block_peak);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Record;
    use crate::testing::Xorshift64;

    const SR: f64 = 48_000.0;
    /// The Web Audio render quantum.
    const Q: usize = 128;
    /// A tempo with a fractional beat length — round ones hide rounding bugs.
    const AWKWARD_BPM: f32 = 127.0;

    fn encode(records: &[Record]) -> Vec<u8> {
        records.iter().flat_map(|r| r.encode()).collect()
    }

    /// One quantum, returning the left channel.
    ///
    /// Left alone is enough only while the two channels agree, and that is
    /// asserted by one test rather than here — see
    /// `both_channels_carry_the_same_signal_until_there_is_pan` for why it is
    /// not asserted on every call.
    fn quantum(engine: &mut Engine, records: &[Record]) -> Vec<f32> {
        let bytes = encode(records);
        let mut left = vec![0.0f32; Q];
        let mut right = vec![0.0f32; Q];
        engine.process(&mut left, &mut right, &bytes, records.len() as u32);
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
    fn both_channels_carry_the_same_signal_until_there_is_pan() {
        // A test of its own, where it used to be an assertion inside `quantum`
        // — which meant every test in this file asserted it in passing, none of
        // them said so, and the mixer landing a pan law would turn the file red
        // all at once with not one of those failures about what its test was
        // for. Here exactly one fails, and its failure is the pan arriving
        // rather than a regression: replace it then with what the two channels
        // are meant to differ by.
        //
        // The second assertion is what keeps the first from being free. Two
        // silent channels are equal, so without it this passes for an engine
        // that renders nothing at all.
        let mut engine = Engine::new(SR);
        let bytes = encode(&[
            Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
            Record::immediate(Command::Play),
        ]);
        let mut left = vec![0.0f32; Q];
        let mut right = vec![0.0f32; Q];

        engine.process(&mut left, &mut right, &bytes, 2);
        assert_eq!(left, right, "the channels parted on the first quantum");
        assert!(left.iter().any(|&s| s != 0.0), "two silent channels match for nothing");

        for quantum in 0..200 {
            engine.process(&mut left, &mut right, &[], 0);
            assert_eq!(left, right, "the channels parted on quantum {quantum}");
        }
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

    /// The key test: clicks land exactly on beats and none is lost.
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
                // An onset is recognized by the sample that follows it, so a
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
        // tail.
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
    fn a_command_stamped_for_a_later_quantum_is_dropped() {
        // What `process` does with a record whose instant lies past the end of
        // the quantum, stated because the code says only that it cannot happen
        // yet — and because `CommandBlock` reports the case without deciding
        // it, so the answer exists in one place and used to be written down in
        // none.
        //
        // The distinguishing assertion is the second one. "It did not apply in
        // this quantum" is equally true of a record that was held back, which
        // is the reading the word `deferred` invites; only rendering the
        // quanta the instant actually falls in separates the two.
        // The transport has to be running for the instant to be reached at all,
        // which rules out `Play` as the record being stamped: a held `Play`
        // would start the clock that has to advance for a held `Play` to fire,
        // so dropping and holding look identical from outside. The tempo has no
        // such circularity.
        let mut engine = Engine::new(SR);
        let default_bpm = engine.transport().bpm();
        let records = [
            Record::immediate(Command::Play),
            // Frame 500, three quanta past the end of this 128-frame block.
            Record { command: Command::SetBpm { bpm: AWKWARD_BPM }, at_sample: 500 },
            // A neighbour behind the one passed over: skipping a record must
            // not take the rest of the block with it, any more than an
            // unrecognized record does.
            Record::immediate(Command::SetMasterGain { gain: 0.5 }),
        ];
        quantum(&mut engine, &records);

        assert!(engine.transport().is_playing());
        assert_eq!(engine.mixer().master_gain(), 0.5, "the record behind it was lost too");
        assert_eq!(engine.transport().bpm(), default_bpm, "a future instant was applied at once");

        // Past frame 500 now, which is where a held record would have fired.
        render(&mut engine, 10);
        assert!(engine.transport().sample_pos() > 500, "the instant was never reached");
        assert_eq!(engine.transport().bpm(), default_bpm, "the record came back later");
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
    fn mixer_commands_reach_the_mixer_with_their_track() {
        // `arg_a` was a field nothing filled until these three commands, and
        // a decoder that dropped it would put every track's gain on track 0
        // while every assertion about "the gain" still passed.
        let mut engine = Engine::new(SR);
        quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetTrackGain { track: 3, gain: 0.25 }),
                Record::immediate(Command::SetTrackPan { track: 3, pan: -0.75 }),
                Record::immediate(Command::SetMasterGain { gain: 0.5 }),
            ],
        );

        assert_eq!(engine.mixer().track_gain(3), 0.25);
        assert_eq!(engine.mixer().track_pan(3), -0.75);
        assert_eq!(engine.mixer().master_gain(), 0.5);
        assert_eq!(engine.mixer().track_gain(0), 1.0, "the command reached the wrong track");
        assert_eq!(engine.mixer().track_pan(0), 0.0, "the command reached the wrong track");
    }

    #[test]
    fn pattern_commands_reach_the_grid_at_their_own_cell() {
        // `arg_b` had been a zero on every record until SetStep, and it sits
        // right beside `arg_a`. A step read one byte early would land on the
        // track number, so every strike in the pattern would go to one track —
        // and an assertion about "the step" would still pass.
        let mut engine = Engine::new(SR);
        quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetStep { track: 3, step: 11, velocity: 0.6 }),
                Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
            ],
        );

        assert_eq!(engine.pattern().velocity(3, 11), 0.6);
        assert_eq!(engine.pattern().velocity(0, 0), 1.0);
        assert_eq!(engine.pattern().velocity(11, 3), 0.0, "track and step were swapped");
        assert_eq!(engine.pattern().velocity(3, 0), 0.0, "the step index was dropped");
        assert_eq!(engine.pattern().velocity(0, 11), 0.0, "the track index was dropped");
    }

    #[test]
    fn clearing_the_pattern_leaves_the_rest_of_the_engine_alone() {
        // ClearPattern is the one command that touches a whole structure
        // rather than one cell; it must not take the tempo or the mixer with
        // it, which nothing but this would notice.
        let mut engine = Engine::new(SR);
        quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
                Record::immediate(Command::SetMasterGain { gain: 0.4 }),
                Record::immediate(Command::SetStep { track: 7, step: 15, velocity: 1.0 }),
            ],
        );
        quantum(&mut engine, &[Record::immediate(Command::ClearPattern)]);

        assert!(!engine.pattern().is_active(7, 15), "the step survived the clear");
        assert_eq!(engine.transport().bpm(), f64::from(AWKWARD_BPM));
        assert_eq!(engine.mixer().master_gain(), 0.4);
    }

    #[test]
    fn a_filled_pattern_changes_nothing_yet() {
        // Stated rather than assumed. A grid with every step struck must
        // render identically to an empty one, because there are no voices for
        // it to trigger — which is what keeps the metronome tests above
        // testing the metronome and nothing else.
        //
        // Written as an equality rather than as silence, since the metronome
        // is sounding in both. **This test is meant to fail when the sampler
        // lands** — that failure is the sampler working, and the signal to
        // replace it with one that asserts what the pattern now does.
        fn signal(fill: bool) -> Vec<f32> {
            let mut engine = Engine::new(SR);
            let mut setup = vec![Record::immediate(Command::SetBpm { bpm: 120.0 })];
            if fill {
                for track in 0..8u8 {
                    for step in 0..16u16 {
                        let strike = Command::SetStep { track, step, velocity: 1.0 };
                        setup.push(Record::immediate(strike));
                    }
                }
            }
            setup.push(Record::immediate(Command::Play));

            let mut rendered = quantum(&mut engine, &setup);
            rendered.extend(render(&mut engine, 200));
            rendered
        }

        assert_eq!(signal(true), signal(false), "the pattern reached the output");
    }

    #[test]
    fn the_master_gain_scales_the_output() {
        fn peak_at(gain: f32) -> f32 {
            let mut engine = Engine::new(SR);
            quantum(&mut engine, &[Record::immediate(Command::SetMasterGain { gain })]);
            // The glide is 10 ms; 100 quanta is 267 ms, long since settled.
            // Measured after it lands, so this is about the gain and not
            // about the smoothing, which dsp.rs tests on its own.
            skip(&mut engine, 100);

            let mut signal = quantum(&mut engine, &[Record::immediate(Command::Play)]);
            signal.extend(render(&mut engine, 20));
            signal.iter().fold(0.0f32, |peak, s| peak.max(s.abs()))
        }

        let unity = peak_at(1.0);
        assert!(unity > 0.0, "there was nothing to scale");
        assert!((peak_at(0.5) - unity / 2.0).abs() < 1e-6, "half gain is not half");
        assert!((peak_at(2.0) - unity * 2.0).abs() < 1e-6, "the ceiling is not reachable");
    }

    #[test]
    fn a_master_gain_of_zero_is_exact_silence() {
        // Not "very quiet": a one-pole approach converges without arriving, so
        // without the snap in `Smoothed` a muted output would keep a residue
        // forever — inaudible, but enough to make every "is it silent" test
        // downstream of it a tolerance comparison.
        let (mut engine, _) = started(120.0);
        quantum(&mut engine, &[Record::immediate(Command::SetMasterGain { gain: 0.0 })]);
        skip(&mut engine, 100);

        assert!(
            render(&mut engine, 200).iter().all(|&s| s == 0.0),
            "a muted master still let something through"
        );
    }

    #[test]
    fn a_gain_change_glides_rather_than_stepping() {
        // The audible half of the rule that parameters are interpolated per
        // frame. Muting mid-click must not cut the buffer off in one frame —
        // that discontinuity is itself a click, which is the noise the gain
        // was being turned down to avoid.
        let (mut engine, _) = started(120.0);
        let muted = quantum(&mut engine, &[Record::immediate(Command::SetMasterGain { gain: 0.0 })]);

        assert!(
            muted.iter().any(|&s| s != 0.0),
            "the gain reached zero within a single quantum"
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
        let mut rng = Xorshift64::new(0x9E37_79B9_7F4A_7C15);
        let mut bytes = vec![0u8; 64 * 16];
        let mut left = [0.0f32; Q];
        let mut right = [0.0f32; Q];
        for _ in 0..200 {
            rng.fill(&mut bytes);
            engine.process(&mut left, &mut right, &bytes, u32::MAX);
            assert!(left.iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn telemetry_layout_is_pinned() {
        // The counterpart of `commands::tests::wire_format_is_pinned`, for the
        // block going the other way, and necessary for the same reason: the
        // test below reads the very constants the code writes, so it stays
        // green through any renumbering of them. Swapping two of these was
        // tried, and all sixty-nine tests passed.
        //
        // Literals, therefore. A change here is a change to the ABI, and this
        // failure is the signal to update `telemetry-block.ts` alongside it and
        // to bump PROTOCOL_VERSION — the number that makes a worklet built
        // against the old block refuse to start rather than misreport.
        assert_eq!(TELEMETRY_WORDS, 4);
        assert_eq!(
            [
                TELEMETRY_TRANSPORT_LO,
                TELEMETRY_TRANSPORT_HI,
                TELEMETRY_PEAK_L,
                TELEMETRY_PEAK_R,
            ],
            [0, 1, 2, 3],
        );
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
        // slides into denormals. An exact zero is the proof that fz works.
        let (mut engine, _) = started(120.0);
        quantum(&mut engine, &[Record::immediate(Command::Stop)]);
        assert!(engine.peak(0) > 0.0);

        skip(&mut engine, (20.0 * SR / Q as f64) as usize); // 20 s of silence
        assert_eq!(engine.peak(0), 0.0, "the peak reading never reached zero");
        assert_eq!(engine.peak(1), 0.0);
    }

    #[test]
    fn render_is_deterministic() {
        // The golden render tests compare a bit for bit and rest on this.
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
        let mut used = Engine::new(SR);
        quantum(&mut used, &[Record::immediate(Command::SetBpm { bpm: 63.5 })]);
        // The mixer is part of "as constructed" too, and the comparison at the
        // end of this test is what proves it: a master gain left at 0.3 would
        // make every sample after the reset three tenths of the fresh one.
        quantum(&mut used, &[Record::immediate(Command::SetMasterGain { gain: 0.3 })]);
        quantum(&mut used, &[Record::immediate(Command::SetTrackGain { track: 6, gain: 0.1 })]);
        quantum(&mut used, &[Record::immediate(Command::SetStep { track: 2, step: 9, velocity: 1.0 })]);
        quantum(&mut used, &[Record::immediate(Command::Play)]);
        render(&mut used, 500);
        used.reset();

        assert!(!used.transport().is_playing());
        assert_eq!(used.transport().sample_pos(), 0);
        assert_eq!(used.peak(0), 0.0);
        assert_eq!(used.mixer().master_gain(), 1.0);
        assert_eq!(used.mixer().track_gain(6), 1.0);
        assert!(!used.pattern().is_active(2, 9), "the pattern survived the reset");

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
