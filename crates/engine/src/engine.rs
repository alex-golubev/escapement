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

use crate::TRACKS;
use crate::commands::Command;
use crate::dsp::{fz, soft_limit};
use crate::mixer::Mixer;
use crate::pattern::Pattern;
use crate::ring::CommandBlock;
use crate::sampler::{Refusal, Sampler};
use crate::sequencer;
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
pub const TELEMETRY_WORDS: usize = 5;
pub const TELEMETRY_TRANSPORT_LO: usize = 0;
pub const TELEMETRY_TRANSPORT_HI: usize = 1;
/// Peak levels sit in these words as `f32` bits (`f32::to_bits`).
/// On the JS side the same bytes are read through a `Float32Array` view.
pub const TELEMETRY_PEAK_L: usize = 2;
pub const TELEMETRY_PEAK_R: usize = 3;
/// Position within the pattern, in steps — `f32` bits like the peaks above, and
/// read on the far side through the same view over the same bytes. What the
/// value is and why it has that shape is argued where it is computed, at
/// [`sequencer::position_in_steps`].
pub const TELEMETRY_STEP: usize = 4;

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
    /// Whether a beat still starts a click. On, as a new engine is on: a switch
    /// that defaulted to off would be a change of behaviour announced by
    /// nothing, and silence is the one symptom this project refuses to leave
    /// unexplained.
    enabled: bool,
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
            enabled: true,
            phase: 0.0,
            phase_step: 0.0,
            env: 0.0,
            env_decay: (-1.0 / (CLICK_DECAY_SECONDS * sample_rate)).exp(),
        }
    }

    fn reset(&mut self) {
        self.enabled = true;
        self.phase = 0.0;
        self.phase_step = 0.0;
        self.env = 0.0;
    }

    /// **Switching off silences the next click, not this one.** The tail goes on
    /// decaying, for the reason a stopped transport lets it: cutting a sounding
    /// buffer is itself a click, and this one would land on the silence the
    /// listener just asked for.
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Retriggering cuts the previous tail short — which is exactly how a
    /// metronome should behave. Phase starts at zero, i.e. at a zero crossing:
    /// starting from an arbitrary phase would produce a step, and a click on
    /// top of the click.
    ///
    /// The switch is answered here rather than at the caller so that the whole
    /// metronome is one object to reason about: the beat still comes round on
    /// time, and what changes is only whether anything is struck on it.
    fn trigger(&mut self, hz: f32) {
        if !self.enabled {
            return;
        }
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
    sampler: Sampler,
    peak: [f32; 2],
}

impl Engine {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            transport: Transport::new(sample_rate),
            click: Click::new(sample_rate),
            mixer: Mixer::new(sample_rate),
            pattern: Pattern::new(),
            sampler: Sampler::new(sample_rate),
            peak: [0.0; 2],
        }
    }

    /// Make room for a kit, and hand back the arena to write it into.
    ///
    /// The pair below is not a second road into the engine, though it is the
    /// only thing here that is not read-only: sample data does not arrive as a
    /// command because a command is sixteen bytes and a kit is megabytes. What
    /// keeps it from being a road is that neither call decides anything — one
    /// asks for memory, the other says what was written into it — and both are
    /// answered with a refusal by name rather than a boolean.
    ///
    /// The caller is the C ABI, once the far side has somewhere to write from;
    /// until then it is the test that loads a kit, which walks the same two
    /// calls in the same order. Everything either of them is guarded against
    /// lives in [`Bank`](crate::sampler), whose doc comments argue it.
    pub fn reserve_bank(&mut self, floats: usize) -> Result<&mut [f32], Refusal> {
        self.sampler.reserve(floats)
    }

    /// Declare what was written into the arena.
    pub fn commit_sample(
        &mut self,
        slot: usize,
        offset: usize,
        frames: usize,
        channels: u8,
    ) -> Result<(), Refusal> {
        self.sampler.commit(slot, offset, frames, channels)
    }

    // Windows onto the engine's state, and that every one of them is read-only
    // is the point rather than an accident.
    //
    // No field is public and nothing here hands out `&mut`, so — apart from the
    // sample data above, which decides nothing — the only way a value inside
    // this type changes is a command decoded out of the block —
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
    ///
    /// **The kit goes with everything else**, which is the one part of this
    /// that costs the caller something: an offline render has to load its
    /// samples again before each run, exactly as it has to set the tempo again.
    /// Leaving them would be leaving the largest difference there is between a
    /// warm instance and a cold one.
    pub fn reset(&mut self) {
        let sample_rate = self.transport.sample_rate();
        self.transport = Transport::new(sample_rate);
        self.click.reset();
        self.mixer.reset();
        self.pattern.reset();
        self.sampler.reset();
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
        words[TELEMETRY_STEP] = sequencer::position_in_steps(&self.transport, pos).to_bits();
    }

    fn apply(&mut self, command: Command) {
        match command {
            Command::Play => self.transport.play(),
            // Nothing sounding is cut off here. The click tail is left to ring
            // out and the voices are faded rather than dropped, both for the
            // same reason: an abrupt cut of a buffer is precisely the click
            // that ruins the sound, and on a stop it lands on silence with
            // nothing to mask it. This is the one caller of the fade — a stolen
            // voice cannot be faded, having nowhere to fade to.
            Command::Stop => {
                self.transport.stop();
                self.sampler.release_all();
            }
            Command::SetBpm { bpm } => self.transport.set_bpm(f64::from(bpm)),
            Command::SetTrackGain { track, gain } => self.mixer.set_track_gain(track, gain),
            Command::SetTrackPan { track, pan } => self.mixer.set_track_pan(track, pan),
            Command::SetMasterGain { gain } => self.mixer.set_master_gain(gain),
            Command::SetStep { track, step, velocity } => {
                self.pattern.set_step(track, step, velocity)
            }
            Command::ClearPattern => self.pattern.clear(),
            Command::SetMetronome { enabled } => self.click.set_enabled(enabled),
            Command::TriggerTrack { track, velocity } => self.sampler.trigger(track, velocity),
        }
    }

    /// A stretch of the quantum between two commands. Tempo and transport
    /// state do not change inside it, so the next boundary of each musical
    /// grid need only be found once per segment rather than once per frame.
    fn render_segment(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len();
        if frames == 0 {
            return;
        }

        let playing = self.transport.is_playing();
        let mut pos = self.transport.sample_pos();
        // While paused the position stands still and crosses no boundary at
        // all, but what is already sounding — the tail of the last click, a
        // voice fading after a stop — must still be rendered.
        let (mut next_click, mut next_step) = if playing {
            (
                self.transport.next_beat_boundary(pos),
                sequencer::next_boundary(&self.transport, pos),
            )
        } else {
            (u64::MAX, u64::MAX)
        };
        // One frame of the pool, kept apart by track. The pool fills every
        // element before anything reads it, so one array serves the segment.
        let mut tracks = [[0.0f32; 2]; TRACKS];
        // Collected as the segment is written rather than swept out of the
        // buffer afterward, because what the meter wants is no longer in the
        // buffer: the limiter stands between them. See the two lines that
        // fill it.
        let mut block_peak = [0.0f32; 2];

        for frame in 0..frames {
            // Both triggers stand before the frame is rendered, which is what
            // puts an onset in the frame its boundary falls on rather than the
            // one after it. The jitter is zero by construction, not within
            // tolerance.
            if pos == next_click {
                let beat = self.transport.beat_at(pos).round() as i64;
                let accent = beat.rem_euclid(BEATS_PER_BAR) == 0;
                self.click.trigger(if accent { CLICK_ACCENT_HZ } else { CLICK_HZ });
                next_click = self.transport.next_beat_boundary(pos + 1);
            }
            if pos == next_step {
                let step = sequencer::step_at(&self.transport, pos);
                sequencer::strike(&self.pattern, &mut self.sampler, step);
                next_step = sequencer::next_boundary(&self.transport, pos + 1);
            }

            let click = self.click.next_sample();
            // A NaN poisons feedback forever.
            debug_assert!(click.is_finite(), "non-finite sample out of the metronome");

            self.sampler.next_frame(&mut tracks);
            // Each track through its own two gains, then summed. The metronome
            // joins the bus after that rather than through a track of its own:
            // it has no level, no pan and no place in the pattern, and giving
            // it one would put a ninth track in the mixer that the UI could
            // never show.
            let [mut left, mut right] = self.mixer.mix_tracks(&tracks);
            left += click;
            right += click;
            debug_assert!(left.is_finite() && right.is_finite(), "non-finite sample out of the sampler");

            // Per frame, not per segment or per quantum: a gain that stepped
            // would be zipper noise, and the smoothing that prevents it only
            // advances when it is asked for a value. Everything that sounds
            // goes through the master.
            let gain = self.mixer.next_master_gain();
            let (left, right) = (left * gain, right * gain);
            debug_assert!(left.is_finite() && right.is_finite(), "non-finite sample out of the mixer");

            // **The meter reads here, before the limiter**, and the position of
            // these two lines is the whole decision. The sum is deliberately
            // hot — eight tracks at unity reach 5.66 — so a reading taken after
            // the limiter sits against the ceiling and stays there, reporting
            // the same number for eight tracks, seven and three. Taken before,
            // it says how far into the limiter the mix is, which is the one
            // thing a fader can act on.
            //
            // Nothing is lost by reading early: the limiter is a pure
            // monotonic function, so the peak after it is the peak before it
            // put through the same curve, and the page can have both from this
            // one number. The converse does not hold.
            //
            // `max` and not a comparison, because `f32::max` returns the other
            // argument for a NaN and so cannot leave the meter stuck.
            block_peak[0] = block_peak[0].max(left.abs());
            block_peak[1] = block_peak[1].max(right.abs());

            let (left, right) = soft_limit(left, right);

            out_l[frame] = left;
            out_r[frame] = right;

            if playing {
                pos += 1;
            }
        }

        self.transport.advance(frames as u32);
        self.update_peaks(block_peak, frames);
    }

    /// Fold one segment's peaks into the falling reading.
    ///
    /// Takes the peaks rather than the buffers: they are of the bus before the
    /// limiter, which is not what the buffers hold. Reading them off the
    /// output would be a second pass over it and would measure the wrong
    /// signal.
    fn update_peaks(&mut self, block_peak: [f32; 2], frames: usize) {
        let seconds = frames as f32 / self.transport.sample_rate() as f32;
        let decay = PEAK_FALL_PER_SECOND.powf(seconds);

        for (channel, peak) in block_peak.into_iter().enumerate() {
            // The falling reading is feedback state.
            self.peak[channel] = fz(self.peak[channel] * decay).max(peak);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Record;
    use crate::mixer::{DEFAULT_PAN, channel_gains};
    use crate::pattern::STEPS;
    use crate::testing::Xorshift64;

    const SR: f64 = 48_000.0;
    /// The Web Audio render quantum.
    const Q: usize = 128;
    /// A tempo with a fractional beat length — round ones hide rounding bugs.
    const AWKWARD_BPM: f32 = 127.0;

    fn encode(records: &[Record]) -> Vec<u8> {
        records.iter().flat_map(|r| r.encode()).collect()
    }

    /// One quantum, both channels.
    fn stereo_quantum(engine: &mut Engine, records: &[Record]) -> (Vec<f32>, Vec<f32>) {
        let bytes = encode(records);
        let mut left = vec![0.0f32; Q];
        let mut right = vec![0.0f32; Q];
        engine.process(&mut left, &mut right, &bytes, records.len() as u32);
        (left, right)
    }

    /// One quantum, returning the left channel.
    ///
    /// Left alone is enough only while the two channels agree, and that is
    /// asserted by one test rather than here — see
    /// `the_channels_stay_together_while_every_track_is_centred` for why it is
    /// not asserted on every call.
    fn quantum(engine: &mut Engine, records: &[Record]) -> Vec<f32> {
        stereo_quantum(engine, records).0
    }

    /// What one voice at `velocity` comes to on either channel, on a track left
    /// at unity gain and centre pan.
    ///
    /// Through the law rather than as `0.707`, because a literal here would
    /// agree with itself and these tests are checking against whatever the law
    /// says. Constant power puts a centred track 3 dB down on each side, which
    /// is why no amplitude below is its velocity.
    fn centred(velocity: f32) -> f32 {
        channel_gains(velocity, DEFAULT_PAN)[0]
    }

    /// One strike on track 0 at full velocity, with its gain and pan settled.
    ///
    /// **The two stages are the point.** A level command starts a ramp, so a
    /// strike in the same quantum is multiplied by the ramp's first frame
    /// rather than by the value asked for. The stopped transport settles it:
    /// the per-frame loop runs whether or not the transport does, so ten
    /// milliseconds pass for the mixer while nothing sounds.
    fn strike_with(gain: f32, pan: f32) -> (f32, f32) {
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        stereo_quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetMetronome { enabled: false }),
                Record::immediate(Command::SetTrackGain { track: 0, gain }),
                Record::immediate(Command::SetTrackPan { track: 0, pan }),
                Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
            ],
        );
        skip(&mut engine, 8); // past the 480-frame glide, with room to spare
        let (left, right) = stereo_quantum(&mut engine, &[Record::immediate(Command::Play)]);
        (left[0], right[0])
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

    /// One bar at 120 BPM, in whole quanta: four beats of 24 000 frames.
    const BAR_FRAMES: usize = 4 * 24_000;
    const BAR_QUANTA: usize = BAR_FRAMES / Q;

    /// A kit of `frames`-long samples, one per track, every value 1.0.
    ///
    /// Loaded through the two calls the far side of the ABI will make, in the
    /// order it will make them. A struck voice then contributes exactly its
    /// velocity for exactly `frames` frames, which is what turns the output
    /// buffer into something to be read rather than measured.
    fn load_kit(engine: &mut Engine, frames: usize) {
        engine
            .reserve_bank(TRACKS * frames)
            .expect("the arena must be granted")
            .fill(1.0);
        for slot in 0..TRACKS {
            assert_eq!(engine.commit_sample(slot, slot * frames, frames, 1), Ok(()), "slot {slot}");
        }
    }

    /// Frames louder than the metronome can be.
    ///
    /// The click is a sine scaled by an envelope that starts at one, so its
    /// amplitude never exceeds `CLICK_GAIN`; a frame above that came from a
    /// voice and from nothing else. That is what makes a strike readable while
    /// the metronome is still sounding underneath it, and it holds only because
    /// the master gain is left at unity in these tests.
    fn struck_frames(signal: &[f32]) -> usize {
        signal.iter().filter(|sample| sample.abs() > CLICK_GAIN).count()
    }

    /// A strike in every cell of the grid, at full velocity.
    fn all_cells() -> Vec<Record> {
        let mut cells = Vec::new();
        for track in 0..TRACKS as u8 {
            for step in 0..STEPS as u16 {
                cells.push(Record::immediate(Command::SetStep { track, step, velocity: 1.0 }));
            }
        }
        cells
    }

    /// Setup that starts the transport at 120 BPM with every cell struck.
    fn every_cell_struck() -> Vec<Record> {
        let mut setup = vec![Record::immediate(Command::SetBpm { bpm: 120.0 })];
        setup.extend(all_cells());
        setup.push(Record::immediate(Command::Play));
        setup
    }

    /// Positions of the frames that carry a sample, and what they carry.
    ///
    /// With the metronome switched off and a one-frame sample loaded, a strike
    /// is one non-zero frame and nothing else in the engine writes one — so
    /// this is the whole output, read rather than measured.
    fn sounding_frames(signal: &[f32]) -> Vec<(usize, f32)> {
        signal
            .iter()
            .enumerate()
            .filter(|&(_, &sample)| sample != 0.0)
            .map(|(frame, &sample)| (frame, sample))
            .collect()
    }

    /// A transport at `bpm`, for computing where a step ought to fall
    /// independently of the engine that put it there.
    fn reference(bpm: f32) -> Transport {
        let mut transport = Transport::new(SR);
        transport.set_bpm(f64::from(bpm));
        transport
    }

    /// One bar rendered from a setup applied on its first quantum.
    fn one_bar(engine: &mut Engine, setup: &[Record]) -> Vec<f32> {
        let mut signal = quantum(engine, setup);
        signal.extend(render(engine, BAR_QUANTA - 1));
        signal
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
    fn the_channels_stay_together_while_every_track_is_centred() {
        // A test of its own, where it used to be an assertion inside `quantum`
        // — which meant every test in this file asserted it in passing, none of
        // them said so, and the mixer landing a pan law would have turned the
        // file red all at once with not one of those failures about what its
        // test was for.
        //
        // **The pan law arrived and this did not go red**, which the split was
        // written expecting. Worth keeping rather than explaining away: centre
        // is the default, so what holds the channels together is no longer that
        // the engine has one of them — it is a value, and a value can change.
        // That makes this the statement that the two channel paths are
        // symmetric, and it is now the only thing standing between a defect in
        // one of them and every test in this file that reads the left alone.
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
    fn stop_fades_the_voices_rather_than_cutting_them() {
        // The transport's stop is the one place a fade is reachable at all — a
        // stolen voice has nowhere to fade to — so this is the only test in
        // which the ramp is joined to a command.
        //
        // Measured where the metronome is already silent: the strike is at
        // frame 0, the click gate closes some 3 500 frames later, and the next
        // sixteenth is at 6 000. Stopping at 5 120 leaves the sustained voice
        // as the only thing sounding, which is what makes the values below
        // exact rather than approximate.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, SR as usize); // one second per slot: still sounding at the stop
        let sounding = quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetBpm { bpm: 120.0 }),
                Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
                Record::immediate(Command::Play),
            ],
        );
        assert_eq!(struck_frames(&sounding), Q, "the fixture left no voice sounding");
        let before = render(&mut engine, 5_120 / Q - 1);
        let sustained = centred(1.0);
        assert_eq!(before[before.len() - 1], sustained, "the metronome was still sounding at the stop");

        let tail = quantum(&mut engine, &[Record::immediate(Command::Stop)]);

        assert_eq!(tail[0], sustained, "the fade opened with a step of its own");
        assert!(
            tail.windows(2).all(|pair| pair[1] <= pair[0]),
            "the fade rose somewhere on its way down"
        );
        // Exactly zero, not nearly: a ramp that stops short leaves the voice in
        // the pool forever, and the pool then answers fewer strikes every time
        // the transport is stopped.
        assert_eq!(tail[Q - 1], 0.0, "the fade did not reach silence within a quantum");
    }

    #[test]
    fn switching_the_metronome_off_leaves_exact_silence() {
        // Exact, because the onset tests stand on it: a click leaking through at
        // any level at all would put a non-zero frame between the strikes, and
        // there it would be read as one.
        let mut engine = Engine::new(SR);
        let mut signal = quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetBpm { bpm: 120.0 }),
                Record::immediate(Command::SetMetronome { enabled: false }),
                Record::immediate(Command::Play),
            ],
        );
        signal.extend(render(&mut engine, 500)); // 1.3 s, two beats

        assert!(signal.iter().all(|&sample| sample == 0.0), "the metronome sounded while off");
        // The beat still comes round; what changed is only whether anything is
        // struck on it. A switch that stopped the transport would pass the line
        // above and take the grid with it.
        assert!(engine.transport().is_playing());
        assert_eq!(engine.transport().sample_pos(), 501 * Q as u64);
    }

    #[test]
    fn switching_the_metronome_off_lets_the_click_it_is_sounding_ring_out() {
        // The same rule as Stop, and for the same reason: cutting a sounding
        // buffer is itself a click, and this one would land on the silence the
        // listener just asked for.
        let (mut engine, _) = started(120.0);
        let tail = quantum(&mut engine, &[Record::immediate(Command::SetMetronome { enabled: false })]);
        assert!(tail.iter().any(|&sample| sample != 0.0), "the click was cut off mid-tail");

        // Past the tail and past the next beat, which must not sound at all.
        let after = render(&mut engine, 500);
        assert!(
            after[tail_frames()..].iter().all(|&sample| sample == 0.0),
            "a beat struck after the metronome was switched off"
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
    fn a_filled_pattern_is_silent_until_a_kit_is_loaded() {
        // Written to fail the moment the sampler landed, and it did not — which
        // turned out to be worth more than the failure. A strike at a slot
        // holding nothing is refused before a voice is taken, so a full grid
        // with no kit loaded renders exactly as an empty one. That is what this
        // now says: an engine with nothing loaded is silence, rather than
        // thirty-two voices busy rendering nothing.
        //
        // Written as an equality rather than as silence, since the metronome is
        // sounding in both.
        let empty = vec![
            Record::immediate(Command::SetBpm { bpm: 120.0 }),
            Record::immediate(Command::Play),
        ];
        let struck = one_bar(&mut Engine::new(SR), &every_cell_struck());

        assert_eq!(struck, one_bar(&mut Engine::new(SR), &empty), "an empty kit sounded");
    }

    #[test]
    fn onsets_land_exactly_on_the_step_boundaries() {
        // The criterion of the milestone, through the whole engine and read
        // straight off the output rather than measured against a threshold:
        // with the metronome switched off nothing else in the engine writes a
        // non-zero frame, and a one-frame sample makes every one of them an
        // onset. An equality, not a tolerance — the jitter is zero by
        // construction, so anything else is a defect rather than a margin.
        //
        // At a tempo whose sixteenth is 5669.29 samples, because a step of a
        // whole number of frames is the case where every rounding here happens
        // to be right.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        let mut setup = vec![
            Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
            Record::immediate(Command::SetMetronome { enabled: false }),
        ];
        setup.extend(all_cells());
        setup.push(Record::immediate(Command::Play));

        let mut signal = quantum(&mut engine, &setup);
        signal.extend(render(&mut engine, 3_000)); // ~8 s, four bars and a little

        let grid = reference(AWKWARD_BPM);
        let expected: Vec<usize> = (0i64..)
            .map(|step| grid.sample_of_division(step as f64, sequencer::STEPS_PER_BEAT) as usize)
            .take_while(|&frame| frame < signal.len())
            .collect();

        let struck: Vec<usize> = sounding_frames(&signal).into_iter().map(|(at, _)| at).collect();
        assert_eq!(struck, expected, "the grid did not strike where the transport says it should");
        // What a strike is *worth* was asserted here too, and is not any more:
        // it is `a_strike_carries_every_track_of_its_step`, one test down. The
        // amplitude of a strike now depends on the pan law and on the limiter,
        // so it moves for reasons this test is not about, and every one of
        // those moves would have turned this red with a message about onsets.
        // The same split the mono assertion needed, made before the second
        // reason to make it arrived rather than after.
    }

    #[test]
    fn a_strike_carries_every_track_of_its_step() {
        // What the positions above cannot say: they would be equally true of a
        // grid striking one track and dropping seven.
        //
        // **Struck at an eighth of full velocity, deliberately.** At full it
        // sums to 5.66 and the limiter answers 0.98 — and answers within a
        // thousandth of that for seven tracks, or for three, so the reading
        // stops distinguishing exactly what this test is here to distinguish.
        // Below the threshold the output is a product again.
        const VELOCITY: f32 = 0.125;

        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        let mut setup = vec![
            Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
            Record::immediate(Command::SetMetronome { enabled: false }),
        ];
        for track in 0..TRACKS as u8 {
            setup.push(Record::immediate(Command::SetStep { track, step: 0, velocity: VELOCITY }));
        }
        setup.push(Record::immediate(Command::Play));

        let signal = quantum(&mut engine, &setup);

        // Summed the way the mixer sums it, one track at a time: eight
        // identical additions do not land where one multiplication by eight
        // does, and the difference is larger than the equality below allows.
        let expected = (0..TRACKS).fold(0.0f32, |sum, _| sum + centred(VELOCITY));
        assert_eq!(sounding_frames(&signal), vec![(0, expected)]);
    }

    #[test]
    fn each_cell_strikes_at_its_own_step_with_its_own_velocity() {
        // What a full grid cannot say. With every cell struck at one velocity,
        // a step number read one column over — or never wrapped at the end of
        // the pattern — produces exactly the right output; here four cells hold
        // four velocities, and on a unit impulse the value of a frame is the
        // velocity of the cell that put it there, through the pan law. Each
        // cell strikes alone and the loudest reaches the limiter's threshold
        // without passing it, so these stay equalities.
        const CELLS: [(u8, u16, f32); 4] = [(0, 0, 0.25), (3, 3, 0.5), (7, 7, 1.0), (2, 15, 0.75)];

        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        let mut setup = vec![
            Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
            Record::immediate(Command::SetMetronome { enabled: false }),
        ];
        for (track, step, velocity) in CELLS {
            setup.push(Record::immediate(Command::SetStep { track, step, velocity }));
        }
        setup.push(Record::immediate(Command::Play));

        let mut signal = quantum(&mut engine, &setup);
        signal.extend(render(&mut engine, 3_000));

        let grid = reference(AWKWARD_BPM);
        let expected: Vec<(usize, f32)> = (0i64..)
            .flat_map(|bar| {
                CELLS.map(|(_, step, velocity)| {
                    let division = bar * STEPS as i64 + i64::from(step);
                    let at = grid.sample_of_division(division as f64, sequencer::STEPS_PER_BEAT);
                    (at as usize, centred(velocity))
                })
            })
            .take_while(|&(frame, _)| frame < signal.len())
            .collect();

        assert_eq!(sounding_frames(&signal), expected);
    }

    #[test]
    fn the_grid_sounds_the_same_however_the_quantum_is_cut() {
        // 128 frames is the host's number and not an assumption of ours: the
        // offline render will ask for blocks thousands of frames long, and
        // several step boundaries then fall inside a single one of them.
        //
        // That is also the only place the loop's own bookkeeping can be seen.
        // After a strike the next boundary is looked up from `pos + 1`, because
        // looked up from `pos` it answers with the frame just struck — and a
        // boundary already behind the position never comes round again, so the
        // grid strikes once per block instead of once per step. At 128 frames
        // there is never more than one boundary in a block, so nothing else
        // here can tell the two apart.
        let mut cut = Engine::new(SR);
        load_kit(&mut cut, 1);
        let expected = one_bar(&mut cut, &every_cell_struck());

        let setup = every_cell_struck();
        let mut whole = Engine::new(SR);
        load_kit(&mut whole, 1);
        let mut left = vec![0.0f32; BAR_FRAMES];
        let mut right = vec![0.0f32; BAR_FRAMES];
        whole.process(&mut left, &mut right, &encode(&setup), setup.len() as u32);

        assert_eq!(struck_frames(&left), STEPS, "the whole bar struck the wrong number of times");
        assert_eq!(left, expected, "the bar came out differently rendered in one block");
    }

    #[test]
    fn a_struck_grid_falls_silent_again_when_the_pattern_is_cleared() {
        // The pattern is read every step rather than latched at the start, and
        // nothing else here would notice if it were: a grid cleared mid-bar has
        // to stop striking on the very next step.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        let struck = one_bar(&mut engine, &every_cell_struck());
        assert!(struck_frames(&struck) > 0, "the fixture struck nothing");

        let cleared = one_bar(&mut engine, &[Record::immediate(Command::ClearPattern)]);

        assert_eq!(struck_frames(&cleared), 0, "a cleared grid went on striking");
    }

    #[test]
    fn a_preview_sounds_while_the_transport_is_stopped() {
        // The property that makes a pad a command of its own rather than a
        // shortcut to a step: the grid is read by the walk over frames, and a
        // stopped transport crosses no boundary at all. So a filled pattern is
        // exactly the silence the preview is heard against, and no metronome
        // has to be switched off to hear it — a click needs a beat to land on,
        // and there are none either.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);

        let silent = quantum(
            &mut engine,
            &[Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 })],
        );
        // Exact zeros rather than `struck_frames`, whose threshold would also
        // report nothing for a strike that merely came out quiet.
        assert!(
            silent.iter().all(|&sample| sample == 0.0),
            "the grid sounded with the transport stopped"
        );

        let previewed = quantum(
            &mut engine,
            &[Record::immediate(Command::TriggerTrack { track: 0, velocity: 1.0 })],
        );
        assert_eq!(previewed[0], centred(1.0), "the pad did not strike");
    }

    #[test]
    fn a_preview_and_a_cell_strike_through_one_door() {
        // Two callers of `Sampler::trigger`, and this says they are two callers
        // rather than two implementations. Nothing else would: each of them has
        // its own tests, both would pass over a second door, and what a second
        // door produces is a pad that sounds unlike the grid it is editing —
        // heard long before anyone thinks to go looking for it.
        //
        // A velocity that is neither zero nor one, because the two paths agree
        // trivially at both.
        const VELOCITY: f32 = 0.6;

        fn engine_with_a_kit() -> Engine {
            let mut engine = Engine::new(SR);
            load_kit(&mut engine, 1);
            engine
        }

        let pad = quantum(
            &mut engine_with_a_kit(),
            &[Record::immediate(Command::TriggerTrack { track: 3, velocity: VELOCITY })],
        );
        let grid = quantum(
            &mut engine_with_a_kit(),
            &[
                Record::immediate(Command::SetMetronome { enabled: false }),
                Record::immediate(Command::SetStep { track: 3, step: 0, velocity: VELOCITY }),
                Record::immediate(Command::Play),
            ],
        );

        assert_eq!(pad[0], grid[0], "the pad and the cell came out at different levels");
        assert_eq!(pad[0], centred(VELOCITY));
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

    /// Below the limiter's threshold at full velocity, so that everything read
    /// in the level tests is a product rather than a point on a curve.
    const QUIET: f32 = 0.5;

    #[test]
    fn panning_a_track_keeps_it_as_loud_as_it_was() {
        // What constant power means where it can be heard: sweeping a track
        // across the image changes where it is, not how loud it is. A law that
        // merely faded one side down would leave the centre 3 dB below either
        // edge, and a track panned during a take would dip as it crossed.
        for pan in [-1.0f32, -0.5, 0.0, 0.5, 1.0] {
            let (left, right) = strike_with(QUIET, pan);
            let power = left * left + right * right;
            assert!(
                (power - QUIET * QUIET).abs() < 1e-6,
                "pan {pan} rendered at power {power}, not {}",
                QUIET * QUIET
            );
        }
    }

    #[test]
    fn a_hard_panned_track_is_exactly_silent_on_the_far_side() {
        // Exactly, and at both ends — the second half is the whole reason the
        // law is in its root form. `cos θ` / `sin θ`, the textbook way to write
        // the same law, is exact at one end only: `cos` of a quarter turn in
        // `f32` is -4.4e-8 rather than zero, so this assertion would hold on
        // the left and fail on the right, for no reason a reader could find in
        // the design.
        assert_eq!(strike_with(QUIET, -1.0), (QUIET, 0.0));
        assert_eq!(strike_with(QUIET, 1.0), (0.0, QUIET));
    }

    #[test]
    fn a_track_gain_scales_its_own_track_and_no_other() {
        // The two tracks are pushed to opposite edges so that each channel
        // carries exactly one of them. Summed together they would not
        // distinguish a fader that moved the wrong track from one that moved
        // both — the total would be the same.
        fn struck(gain_of_track_0: f32) -> (f32, f32) {
            let mut engine = Engine::new(SR);
            load_kit(&mut engine, 1);
            stereo_quantum(
                &mut engine,
                &[
                    Record::immediate(Command::SetMetronome { enabled: false }),
                    Record::immediate(Command::SetTrackPan { track: 0, pan: -1.0 }),
                    Record::immediate(Command::SetTrackPan { track: 1, pan: 1.0 }),
                    Record::immediate(Command::SetTrackGain { track: 0, gain: gain_of_track_0 }),
                    Record::immediate(Command::SetTrackGain { track: 1, gain: QUIET }),
                    Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
                    Record::immediate(Command::SetStep { track: 1, step: 0, velocity: 1.0 }),
                ],
            );
            skip(&mut engine, 8);
            let (left, right) = stereo_quantum(&mut engine, &[Record::immediate(Command::Play)]);
            (left[0], right[0])
        }

        assert_eq!(struck(QUIET), (QUIET, QUIET), "the fixture did not separate the tracks");
        assert_eq!(struck(QUIET / 2.0), (QUIET / 2.0, QUIET), "the fader moved more than its track");
    }

    #[test]
    fn a_fader_moved_while_its_track_is_silent_has_arrived_by_the_next_strike() {
        // What advancing only the tracks that sound would cost, and it is not
        // paid in the silence. The glide would then measure ten milliseconds of
        // *sounding* rather than of time, so a fader moved during a rest would
        // still be halfway when the next strike opened — a step at the head of
        // the sample, which is the zipper the smoothing exists to remove, moved
        // to where nothing is listening for it.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        stereo_quantum(
            &mut engine,
            &[
                Record::immediate(Command::SetMetronome { enabled: false }),
                Record::immediate(Command::SetTrackGain { track: 0, gain: QUIET }),
                Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
            ],
        );
        // Nothing sounds through any of this: no voice has been struck yet, so
        // every track's frame is zero and a mixer that skipped them would not
        // advance at all.
        skip(&mut engine, 8);

        let struck = quantum(&mut engine, &[Record::immediate(Command::Play)])[0];
        assert_eq!(struck, centred(QUIET), "the fader had not arrived when the strike did");
    }

    #[test]
    fn a_stereo_sample_is_balanced_rather_than_collapsed() {
        // A sample with an image of its own must keep it. What the pan law does
        // to a mono voice is pan it; the same two gains over a voice that
        // already has two different channels is balance, and the two need no
        // branch between them because the voice hands over a pair either way.
        //
        // The rule is written down before anything loads a stereo loop, since
        // the natural mistake — the law applied to the sum — sounds fine on the
        // mono material a drum machine is full of and folds the image flat on
        // the first thing that has one.
        fn struck(pan: f32) -> (f32, f32) {
            let mut engine = Engine::new(SR);
            engine.reserve_bank(2).expect("the arena must be granted").copy_from_slice(&[0.5, 0.25]);
            assert_eq!(engine.commit_sample(0, 0, 1, 2), Ok(()));
            stereo_quantum(
                &mut engine,
                &[
                    Record::immediate(Command::SetMetronome { enabled: false }),
                    Record::immediate(Command::SetTrackPan { track: 0, pan }),
                    Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
                ],
            );
            skip(&mut engine, 8);
            let (left, right) = stereo_quantum(&mut engine, &[Record::immediate(Command::Play)]);
            (left[0], right[0])
        }

        let (left, right) = struck(DEFAULT_PAN);
        assert_eq!((left, right), (centred(0.5), centred(0.25)), "the image was not kept");

        // Hard left leaves the source's left channel alone and drops its right
        // entirely — a balance control, not a collapse into one signal.
        assert_eq!(struck(-1.0), (0.5, 0.0));
        assert_eq!(struck(1.0), (0.0, 0.25));
    }

    #[test]
    fn the_meter_reads_the_bus_before_the_limiter() {
        // A full grid sums to 5.66 and leaves the limiter just under unity —
        // and leaves it within a thousandth of that for seven tracks, or three.
        // A meter reading the output would therefore report the same healthy
        // number for every one of those, which is a meter that cannot report
        // the one condition a fader answers.
        let mut engine = Engine::new(SR);
        load_kit(&mut engine, 1);
        let mut setup = vec![Record::immediate(Command::SetMetronome { enabled: false })];
        setup.extend(every_cell_struck());

        let signal = quantum(&mut engine, &setup);
        let summed = (0..TRACKS).fold(0.0f32, |sum, _| sum + centred(1.0));

        assert!(summed > 1.0, "the fixture did not reach the limiter at all");
        assert_eq!(engine.peak(0), summed, "the meter read something other than the bus");
        // And the output is that same reading put through the curve, which is
        // what makes reading early lossless: the page can compute this from the
        // meter, and could not compute the meter from this.
        assert_eq!(signal[0], soft_limit(summed, summed).0);
        assert!(signal.iter().all(|&s| s.abs() <= 1.0), "the output passed full scale");
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
        assert_eq!(TELEMETRY_WORDS, 5);
        assert_eq!(
            [
                TELEMETRY_TRANSPORT_LO,
                TELEMETRY_TRANSPORT_HI,
                TELEMETRY_PEAK_L,
                TELEMETRY_PEAK_R,
                TELEMETRY_STEP,
            ],
            [0, 1, 2, 3, 4],
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
    fn telemetry_reports_where_the_grid_stands() {
        // Both readings are equalities rather than neighbourhoods, because 120
        // BPM at 48 kHz makes a step 6000 whole samples: half a bar is exactly
        // eight steps and a whole one is exactly the pattern. Eight is also what
        // tells the unit apart from its neighbours — the same instant is two
        // beats and 48 000 samples.
        //
        // `started` has already rendered one quantum, which is why each stretch
        // below is one short of the half bar it lands on.
        let (mut engine, _) = started(120.0);
        let mut words = [0u32; TELEMETRY_WORDS];

        skip(&mut engine, BAR_QUANTA / 2 - 1);
        engine.write_telemetry(&mut words);
        assert_eq!(words[TELEMETRY_TRANSPORT_LO], (BAR_FRAMES / 2) as u32);
        assert_eq!(f32::from_bits(words[TELEMETRY_STEP]), 8.0);

        skip(&mut engine, BAR_QUANTA / 2);
        engine.write_telemetry(&mut words);
        assert_eq!(f32::from_bits(words[TELEMETRY_STEP]), 0.0, "the word did not wrap");
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
            // With voices in it, because they are the part with a lifecycle:
            // an allocation order that depended on anything but the pool's own
            // state would show up here and nowhere else.
            load_kit(engine, 4_096);
            let mut signal = quantum(
                engine,
                &[
                    Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
                    Record::immediate(Command::SetStep { track: 1, step: 0, velocity: 0.8 }),
                    Record::immediate(Command::SetStep { track: 5, step: 7, velocity: 0.3 }),
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
        load_kit(&mut used, 1);
        quantum(&mut used, &[Record::immediate(Command::SetBpm { bpm: 63.5 })]);
        // The mixer is part of "as constructed" too, and the comparison at the
        // end of this test is what proves it: a master gain left at 0.3 would
        // make every sample after the reset three tenths of the fresh one.
        quantum(&mut used, &[Record::immediate(Command::SetMasterGain { gain: 0.3 })]);
        quantum(&mut used, &[Record::immediate(Command::SetTrackGain { track: 6, gain: 0.1 })]);
        quantum(&mut used, &[Record::immediate(Command::SetStep { track: 2, step: 9, velocity: 1.0 })]);
        quantum(&mut used, &[Record::immediate(Command::SetMetronome { enabled: false })]);
        quantum(&mut used, &[Record::immediate(Command::Play)]);
        render(&mut used, 500);
        used.reset();

        assert!(!used.transport().is_playing());
        assert_eq!(used.transport().sample_pos(), 0);
        assert_eq!(used.peak(0), 0.0);
        assert_eq!(used.mixer().master_gain(), 1.0);
        assert_eq!(used.mixer().track_gain(6), 1.0);
        assert!(!used.pattern().is_active(2, 9), "the pattern survived the reset");

        // The script strikes, which is what makes the kit part of this
        // comparison: a bank that survived the reset would sound here, and
        // nothing else in the test would notice a thing.
        fn after(engine: &mut Engine) -> Vec<f32> {
            let mut signal = quantum(
                engine,
                &[
                    Record::immediate(Command::SetBpm { bpm: AWKWARD_BPM }),
                    Record::immediate(Command::SetStep { track: 0, step: 0, velocity: 1.0 }),
                    Record::immediate(Command::Play),
                ],
            );
            signal.extend(render(engine, 200));
            signal
        }

        let expected = after(&mut Engine::new(SR));

        assert_eq!(after(&mut used), expected, "after reset the engine must sound like a new one");
    }
}
