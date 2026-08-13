//! Sounding copies of the samples, and the pool that hands them out.
//!
//! Nothing here owns memory: a voice reads through a [`Region`] into the bank's
//! arena. That division is not tidiness — at M4 the allocation policy below
//! survives into the synthesiser and [`Voice`] does not, a struck sample and a
//! held note having almost nothing in common past the pool.

use super::bank::{Bank, Region, SLOTS};
use crate::TRACKS;
use crate::dsp::{clamped, frames_for};
use crate::pattern::{MAX_VELOCITY, MIN_VELOCITY};

/// A voice sounds on the track numbered like its slot, which means anything
/// only while the two counts agree.
///
/// A build failure rather than the silence it would otherwise be.
/// [`Pool::next_frame`] indexes an array of `TRACKS` by a slot, and `get_mut`
/// answers `None` past the end — so raising the slot count on its own would
/// leave every voice above the eighth rendering into nothing at all, with no
/// refusal, no counter and nothing to hear but a missing drum. That rise is
/// named as debt rather than ruled out, so this is a line somebody will one day
/// change deliberately; what it must not be is a line somebody changes without
/// meeting the consequence.
const _: () = assert!(SLOTS == TRACKS, "a voice's slot is its track — see Pool::next_frame");

/// Voices in the pool.
///
/// Reachable as a limit rather than theoretical: at 120 BPM a sixteenth is
/// 125 ms, so a one-second sample spans eight steps, and eight tracks striking
/// every step is sixty-four sounding at once. What happens then is decided by
/// [`Pool::allocate`].
pub const VOICES: usize = 32;

/// Fade applied to a voice when the transport stops.
///
/// Two milliseconds is below the threshold where a fade is heard as a fade and
/// far above the one frame where a cut is heard as a click.
const RELEASE_SECONDS: f64 = 0.002;

/// What a voice is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Free,
    Playing,
    /// Fading out, with the frames left in the ramp.
    Releasing(u32),
}

#[derive(Debug, Clone, Copy)]
struct Voice {
    slot: usize,
    /// Frames of the sample already played. Whole frames, not a fractional
    /// phase: the sample rate of a slot is the sample rate of the engine —
    /// `decodeAudioData` guarantees it — so a voice advances by exactly one.
    /// A fractional cursor is what pitch shifting needs, and it brings with it
    /// the question of what happens half a frame from the end. That question
    /// arrives with the feature that asks it.
    cursor: usize,
    velocity: f32,
    stage: Stage,
}

impl Voice {
    const FREE: Self = Self { slot: 0, cursor: 0, velocity: 0.0, stage: Stage::Free };

    /// This voice's contribution to one frame, or `None` when it has none.
    ///
    /// **One match on the stage, not two.** It reads the envelope for this
    /// frame and leaves the stage where the next frame needs it, in the same
    /// arm. Reading in one place and advancing in another is how the two come
    /// apart — and the way they come apart is a release that never reaches
    /// zero, so the voice never leaves the pool and the pool slowly stops
    /// answering.
    ///
    /// The `Releasing` ramp is computed from the frames left rather than
    /// multiplied down from the frame before, which is what keeps it free of
    /// both accumulated error and denormals: nothing here is fed its own
    /// output.
    ///
    /// **`release_span` is one less than the frame count, and that off-by-one
    /// is the ramp.** A fade of `n` frames holds `n` values and therefore `n−1`
    /// steps between them, so dividing by the count leaves the last value at
    /// `1/n` and the drop to silence outside the ramp: a step of −40 dB at 2 ms
    /// and 48 kHz, which is a quieter version of the click the fade exists to
    /// remove. Dividing by the steps puts the first value at exactly 1.0 — no
    /// discontinuity where the fade begins — and the last at exactly 0.0.
    fn next_frame(
        &mut self,
        arena: &[f32],
        region: &Region,
        release_span: f32,
    ) -> Option<[f32; 2]> {
        let envelope = match self.stage {
            Stage::Free => return None,
            Stage::Playing => 1.0,
            Stage::Releasing(left) => {
                self.stage = if left <= 1 { Stage::Free } else { Stage::Releasing(left - 1) };
                (left - 1) as f32 / release_span
            }
        };

        // Past the frames this slot declares lies the *next sample in the
        // arena* — not silence, and not the leavings of a previous tenant.
        // This comparison is the whole of what keeps that unheard, and it is
        // against the declared length rather than against how far the data
        // happens to run. A drum given the head of the next drum as its tail
        // is audible and sounds nearly plausible, which is exactly what makes
        // it get blamed on the sample.
        if self.cursor >= region.frames {
            self.stage = Stage::Free;
            return None;
        }

        let channels = usize::from(region.channels);
        let base = region.offset + self.cursor * channels;
        let scale = self.velocity * envelope;
        self.cursor += 1;

        // In range by the check above, by what `commit` validated against the
        // arena, and by a reservation clearing every region along with every
        // voice. A branch rather than an index all the same: the alternative
        // to a wrong answer here would be a panic, and a panic on this thread
        // ends the sound until the page is reloaded.
        let (Some(&left), Some(&right)) = (arena.get(base), arena.get(base + channels - 1)) else {
            self.stage = Stage::Free;
            return None;
        };

        // Mono lands both reads on the same value, so neither channel count
        // needs a branch of its own.
        Some([left * scale, right * scale])
    }
}

/// A velocity that will produce sound, or nothing at all.
///
/// One named place, because two callers reach the pool — the step sequencer and
/// the preview command — and a guard written at one of them is a guard at
/// neither.
///
/// [`dsp::clamped`](crate::dsp) answers the two values that must never reach a
/// multiplier. What this function adds is the third refusal, which is about
/// voices rather than arithmetic: **zero does not start one.** A step switched
/// off would otherwise take a voice out of a pool of thirty-two and spend it
/// rendering silence, and with a full grid the pool is the scarce thing. That
/// also settles what a flushed denormal means here — it arrives as zero, so it
/// is a strike that never happens.
fn audible(velocity: f32) -> Option<f32> {
    clamped(velocity, MIN_VELOCITY, MAX_VELOCITY).filter(|&velocity| velocity > 0.0)
}

pub struct Pool {
    voices: [Voice; VOICES],
    /// Frames in the release ramp.
    ///
    /// At least two, which is one more than [`frames_for`] guarantees anybody
    /// and is asked for here rather than there: a ramp runs from full to
    /// silence *inclusive*, and two values is the fewest that can describe a
    /// line. At one the span below would be zero and the ramp a division by
    /// it. Only a sample rate no device reports gets near that, and the
    /// arithmetic still has to be defined when it does.
    release_frames: u32,
}

impl Pool {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            voices: [Voice::FREE; VOICES],
            release_frames: frames_for(RELEASE_SECONDS, sample_rate).max(2),
        }
    }

    /// Free every voice at once, sounding or not.
    ///
    /// Cutting rather than fading, and the caller is what makes that right: the
    /// only reason to silence the whole pool is that the samples underneath it
    /// are being replaced, and a fade would have to keep reading them.
    pub fn silence(&mut self) {
        self.voices = [Voice::FREE; VOICES];
    }

    /// Strike a track. Silently does nothing if there is nothing to strike.
    ///
    /// One door to the pool, on purpose: the step sequencer and the preview
    /// command both arrive here, and a second entry point would be a preview
    /// that sounds unlike the grid — a difference heard long before it is
    /// found.
    pub fn trigger(&mut self, bank: &Bank, slot: usize, velocity: f32) {
        let Some(velocity) = audible(velocity) else {
            return;
        };
        if !bank.holds_a_sample(slot) {
            return;
        }

        let index = self.allocate(bank);
        if let Some(voice) = self.voices.get_mut(index) {
            *voice = Voice { slot, cursor: 0, velocity, stage: Stage::Playing };
        }
    }

    /// Fade every sounding voice out. What the transport does on stop.
    ///
    /// Cutting the buffer instead is the click that ruins the first impression
    /// of a sound, and it is the one the ear notices most, because it lands on
    /// silence with nothing to mask it.
    pub fn release_all(&mut self) {
        let release = self.release_frames;
        for voice in &mut self.voices {
            if voice.stage == Stage::Playing {
                voice.stage = Stage::Releasing(release);
            }
        }
    }

    /// One frame of every sounding voice, kept apart by track.
    ///
    /// Per track and not summed, because the track's own level and pan are
    /// applied downstream and a sum would have thrown away what they apply to.
    /// The caller owns the array, so this path allocates nothing.
    ///
    /// No denormal flush on the way out, and that is not an omission: there is
    /// no feedback here — no value computed from a previous output — and both
    /// factors entering the multiplication were flushed at the doors they came
    /// through, `commit` for the sample and `trigger` for the velocity.
    pub fn next_frame(&mut self, bank: &Bank, out: &mut [[f32; 2]; TRACKS]) {
        *out = [[0.0; 2]; TRACKS];
        let arena = bank.arena();
        // Steps in the ramp, not frames — see `Voice::next_frame`. Computed
        // once per frame rather than once per voice, being the same for all.
        let release_span = (self.release_frames - 1) as f32;

        // A free voice still has its slot looked up and thrown away — some
        // three thousandths of a core at 48 kHz, spent when the pool is idle
        // and there is nothing else to spend it on. Buying it back costs a
        // second test of the stage out here, in the loop that should read as a
        // sentence.
        for voice in self.voices.iter_mut() {
            let Some(region) = bank.region(voice.slot) else {
                continue;
            };
            let Some(frame) = voice.next_frame(arena, region, release_span) else {
                continue;
            };
            if let Some(track) = out.get_mut(voice.slot) {
                track[0] += frame[0];
                track[1] += frame[1];
            }
        }
    }

    /// Which voice the next strike takes.
    ///
    /// The pool never refuses, so the question is only ever which voice is
    /// least missed. In order: a free one; else the most faded of those
    /// already releasing, where the cut lands on a value near zero; else the
    /// playing voice with the least of its sample left, which for a struck
    /// drum is also its quietest part.
    ///
    /// What is deliberately not done is fading the voice being taken. A fade
    /// needs somewhere for the new note to sound while the old one runs out,
    /// and having nowhere is the definition of the case this function is in.
    /// The alternative is delaying the new note by the length of the fade,
    /// which trades a rare quiet click for a sample-accurate onset — and the
    /// onset is the property the whole milestone is built on.
    ///
    /// **The last rank rests on something true of struck sounds and of nothing
    /// else.** "Least of its sample left" stands in for "quietest", and it may
    /// stand in for it because a drum decays: what remains of one is its tail.
    /// A sound that is held until it is let go has no such relation between how
    /// much is left and how loud it is, and against a pool of those this order
    /// picks the loudest voice there is. Ranking by envelope level instead is a
    /// small repair; what makes it worth writing down before it is needed is
    /// that until then the defect is silent, and it is silent in the direction
    /// of an audible click.
    fn allocate(&self, bank: &Bank) -> usize {
        let mut best = 0usize;
        let mut best_rank = (u8::MAX, usize::MAX);

        for (index, voice) in self.voices.iter().enumerate() {
            let rank = match voice.stage {
                Stage::Free => return index,
                Stage::Releasing(left) => (0u8, left as usize),
                Stage::Playing => (1u8, remaining(bank, voice)),
            };
            if rank < best_rank {
                best_rank = rank;
                best = index;
            }
        }
        best
    }
}

/// Frames of its sample a voice has left.
fn remaining(bank: &Bank, voice: &Voice) -> usize {
    match bank.region(voice.slot) {
        Some(region) => region.frames.saturating_sub(voice.cursor),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sampler::SLOTS;
    use crate::sampler::bank::tests::{Sample, loaded};

    const SR: f64 = 48_000.0;

    /// A bank holding one sample of the value 1.0, and an idle pool.
    ///
    /// One frame of that sample is the impulse these tests are built on: a
    /// struck voice then writes exactly one non-zero frame, so the output can
    /// be read directly — where the frame sits is the onset, how big it is is
    /// the product of everything that scaled it.
    fn one(slot: usize, frames: usize, channels: u8) -> (Bank, Pool) {
        (loaded(&[Sample { slot, frames, channels, value: 1.0 }]), Pool::new(SR))
    }

    /// Render one frame and sum it across tracks, left and right.
    ///
    /// Summed because most tests here ask what the pool produced, not which row
    /// it landed on — the two tests that do care read `out` directly, and are
    /// the only ones that should.
    fn summed_frame(pool: &mut Pool, bank: &Bank) -> (f32, f32) {
        let mut out = [[0.0f32; 2]; TRACKS];
        pool.next_frame(bank, &mut out);
        out.iter().fold((0.0, 0.0), |(l, r), track| (l + track[0], r + track[1]))
    }

    fn silent(pool: &mut Pool, bank: &Bank, frames: usize) -> bool {
        (0..frames).all(|_| summed_frame(pool, bank) == (0.0, 0.0))
    }

    fn sounding(pool: &Pool) -> usize {
        pool.voices.iter().filter(|v| v.stage != Stage::Free).count()
    }

    #[test]
    fn a_new_pool_holds_nothing_and_says_so() {
        let bank = Bank::new();
        let mut pool = Pool::new(SR);
        assert!(silent(&mut pool, &bank, 64));
        assert_eq!(sounding(&pool), 0);
        // Striking a slot with no sample in it is not an error and not a
        // voice: the grid is edited before the kit is loaded, every time.
        pool.trigger(&bank, 0, 1.0);
        assert_eq!(sounding(&pool), 0);
    }

    #[test]
    fn an_impulse_sounds_on_the_frame_it_was_struck_and_not_after() {
        // The property every onset test downstream rests on. A voice that
        // started one frame late, or that repeated its first frame, would
        // still sound like a drum and would put the whole grid off the beat.
        let (bank, mut pool) = one(3, 1, 1);
        pool.trigger(&bank, 3, 1.0);

        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0));
        assert!(silent(&mut pool, &bank, 16), "the voice outlived its one frame");
        assert_eq!(sounding(&pool), 0, "the voice did not free itself");
    }

    #[test]
    fn a_voice_never_reads_past_what_was_declared() {
        // The neighbour holds a different value, so a cursor running past its
        // declaration shows up as a tail rather than as silence.
        let bank = loaded(&[
            Sample { slot: 0, frames: 2, channels: 1, value: 1.0 },
            Sample { slot: 1, frames: 5_000, channels: 1, value: 0.7 },
        ]);
        let mut pool = Pool::new(SR);

        pool.trigger(&bank, 0, 1.0);
        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0));
        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0));
        assert!(silent(&mut pool, &bank, 32), "the voice ran on into its neighbour");
    }

    #[test]
    fn a_voice_whose_slot_stops_being_declared_falls_silent() {
        // The second thing the declaration check keeps out, and the one with no
        // test until now: a voice already sounding when its slot goes empty.
        //
        // Set up as the window a reservation opens — an arena holding data, no
        // slot declaring any of it — because that is the case where nothing
        // else would catch it. Against a *cleared* arena the bounds check on
        // the read answers just as well; here it does not, and a voice reading
        // on would play the incoming kit at the cursor it happened to hold.
        // That is the sound `Sampler::reserve` silences the pool to prevent,
        // and this is the half of it the pool has to survive alone: the two
        // halves are separate types, and only one of them knows about the
        // ordering.
        let (mut bank, mut pool) = one(0, 1_000, 1);
        pool.trigger(&bank, 0, 1.0);
        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0));

        bank.reserve(1_000).expect("the arena must be granted").fill(0.5);

        assert!(silent(&mut pool, &bank, 8), "a voice went on reading an undeclared slot");
        assert_eq!(sounding(&pool), 0, "the voice did not free itself");
    }

    #[test]
    fn a_sample_reads_from_its_own_offset() {
        // Only the offset tells two samples in one arena apart: read from the
        // wrong one, the kit is intact and every drum is the wrong drum.
        let bank = loaded(&[
            Sample { slot: 0, frames: 1, channels: 1, value: 0.25 },
            Sample { slot: 1, frames: 1, channels: 1, value: 0.75 },
        ]);
        let mut pool = Pool::new(SR);

        pool.trigger(&bank, 1, 1.0);
        let mut out = [[0.0f32; 2]; TRACKS];
        pool.next_frame(&bank, &mut out);
        assert_eq!(out[1][0], 0.75, "the voice read from the wrong offset");
    }

    #[test]
    fn a_voice_sounds_on_its_own_track() {
        // A sum would hide this, and the mixer downstream applies a level per
        // track: a voice landing on the wrong row would be a fader moving a
        // sound it does not name.
        let (bank, mut pool) = one(5, 1, 1);
        pool.trigger(&bank, 5, 1.0);

        let mut out = [[0.0f32; 2]; TRACKS];
        pool.next_frame(&bank, &mut out);
        for (track, pair) in out.iter().enumerate() {
            let expected = if track == 5 { 1.0 } else { 0.0 };
            assert_eq!(pair[0], expected, "track {track}");
        }
    }

    #[test]
    fn velocity_scales_the_strike() {
        for velocity in [1.0f32, 0.5, 0.25, MAX_VELOCITY] {
            let (bank, mut pool) = one(0, 1, 1);
            pool.trigger(&bank, 0, velocity);
            assert_eq!(summed_frame(&mut pool, &bank), (velocity, velocity), "velocity {velocity}");
        }
    }

    #[test]
    fn a_velocity_that_cannot_sound_starts_no_voice() {
        // The pool's own property, and the one `dsp::clamped` does not have:
        // what these inputs must not cost is a *voice*. A pool of thirty-two
        // against a full grid is the scarce thing, and a strike that renders
        // silence occupies a slot for the length of its sample.
        //
        // The denormal is here for the same reason and is the case that was
        // untested: it survives the range check, arrives as zero through the
        // flush, and must then be indistinguishable from a step switched off.
        // Negative and non-finite come the two other ways to the same place.
        let (bank, mut pool) = one(0, 1, 1);
        for bad in [0.0, -1.0, 1e-40, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            pool.trigger(&bank, 0, bad);
            assert_eq!(sounding(&pool), 0, "velocity {bad:e} started a voice");
        }
        // And an out-of-range velocity is clamped rather than dropped: 2.0 is
        // a UI bug, silence would be a worse answer than the loudest strike.
        pool.trigger(&bank, 0, 2.0);
        assert_eq!(summed_frame(&mut pool, &bank), (MAX_VELOCITY, MAX_VELOCITY));
    }

    #[test]
    fn a_slot_out_of_range_is_dropped_rather_than_wrapped() {
        // The index arrives as a byte from another thread, so 200 is as
        // reachable as 3, and writing it into a neighbour would turn a bug on
        // the far side into a wrong drum here.
        let (bank, mut pool) = one(0, 1, 1);
        for slot in [SLOTS, SLOTS + 1, 200, usize::MAX] {
            pool.trigger(&bank, slot, 1.0);
            assert_eq!(sounding(&pool), 0, "slot {slot} started a voice");
        }
    }

    #[test]
    fn a_slot_that_was_not_declared_does_not_sound() {
        // The window this guards is invisible in Rust: `reserve` returns an
        // arena the other side of the ABI has not written yet, and a voice
        // started in it would play whatever the copy has managed so far.
        let mut bank = Bank::new();
        let mut pool = Pool::new(SR);
        bank.reserve(4).expect("the arena must be granted").fill(1.0);

        pool.trigger(&bank, 2, 1.0);
        assert_eq!(sounding(&pool), 0, "an undeclared slot was struck");

        assert_eq!(bank.commit(2, 0, 4, 1), Ok(()));
        pool.trigger(&bank, 2, 1.0);
        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0), "a declared slot must sound");
    }

    #[test]
    fn stereo_keeps_its_channels_apart_and_mono_reaches_both() {
        // Interleaving read with the wrong stride shows up here and almost
        // nowhere else: a mono sample read as stereo would play at double
        // speed, and a stereo one read as mono would play the left channel
        // twice at half speed. Both still sound like a drum.
        let mut bank = Bank::new();
        let mut pool = Pool::new(SR);
        let arena = bank.reserve(4).expect("the arena must be granted");
        arena.copy_from_slice(&[1.0, -1.0, 0.5, -0.5]);
        assert_eq!(bank.commit(0, 0, 2, 2), Ok(()));
        pool.trigger(&bank, 0, 1.0);

        assert_eq!(summed_frame(&mut pool, &bank), (1.0, -1.0));
        assert_eq!(summed_frame(&mut pool, &bank), (0.5, -0.5));
        assert!(silent(&mut pool, &bank, 4), "a two-frame stereo sample lasted longer");

        let (mono, mut pool) = one(0, 1, 1);
        pool.trigger(&mono, 0, 1.0);
        let (left, right) = summed_frame(&mut pool, &mono);
        assert_eq!(left, right, "a mono sample must reach both channels alike");
    }

    #[test]
    fn the_same_slot_struck_again_sounds_twice_over() {
        // A drum machine retriggers a track long before its sample has
        // finished — a closed hat on every sixteenth is the normal case, not
        // an edge one — and the two strikes overlap rather than choking each
        // other. Nothing in the pool ties a voice to a track.
        let (bank, mut pool) = one(0, 8, 1);
        pool.trigger(&bank, 0, 1.0);
        assert_eq!(summed_frame(&mut pool, &bank), (1.0, 1.0));
        pool.trigger(&bank, 0, 1.0);
        assert_eq!(summed_frame(&mut pool, &bank), (2.0, 2.0), "the second strike replaced the first");
        assert_eq!(sounding(&pool), 2);
    }

    #[test]
    fn stopping_fades_the_voices_rather_than_cutting_them() {
        // The fade is the whole reason `Releasing` exists, and both of its ends
        // are a discontinuity if the arithmetic is off by one — in the same
        // direction, towards the click the fade removes.
        //
        // The far end is the one that hides. A ramp dividing by the frame count
        // instead of the steps between them ends at 1/n and drops to silence
        // from there: −40 dB at 2 ms and 48 kHz. Everything downstream still
        // passes — the voice does leave the pool, the output does fall silent —
        // so only asking for the ramp's own last value catches it.
        let (bank, mut pool) = one(0, 100_000, 1);
        pool.trigger(&bank, 0, 1.0);
        let before = summed_frame(&mut pool, &bank).0;

        pool.release_all();
        let first = summed_frame(&mut pool, &bank).0;
        assert_eq!(first, before, "the release began with a step");

        let mut previous = first;
        for step in 1..pool.release_frames as usize {
            let value = summed_frame(&mut pool, &bank).0;
            assert!(value < previous, "the release stalled at {value} on step {step}");
            previous = value;
        }
        assert_eq!(previous, 0.0, "the ramp ended at {previous} and stepped to silence");

        assert!(silent(&mut pool, &bank, 8), "the release did not reach silence");
        assert_eq!(sounding(&pool), 0, "a faded voice stayed in the pool");
    }

    #[test]
    fn the_pool_takes_the_voice_that_is_least_missed() {
        // Stated against the choice rather than against the sound, because the
        // sound of a wrong choice is a click that only some patterns produce.
        // Free first; then the most faded of those already releasing, where
        // the cut lands near zero; then the playing voice with the least of
        // its sample left.
        let (bank, mut pool) = one(0, 1_000, 1);

        // One free voice among busy ones is taken, wherever it sits.
        for voice in pool.voices.iter_mut() {
            voice.stage = Stage::Playing;
        }
        pool.voices[7].stage = Stage::Free;
        assert_eq!(pool.allocate(&bank), 7);

        // No free voice: the most faded release wins over any playing voice,
        // however near its end.
        for voice in pool.voices.iter_mut() {
            *voice = Voice { slot: 0, cursor: 999, velocity: 1.0, stage: Stage::Playing };
        }
        pool.voices[4].stage = Stage::Releasing(90);
        pool.voices[9].stage = Stage::Releasing(3);
        assert_eq!(pool.allocate(&bank), 9);

        // Nothing releasing either: the one with the least left to play.
        for (index, voice) in pool.voices.iter_mut().enumerate() {
            *voice = Voice { slot: 0, cursor: index * 10, velocity: 1.0, stage: Stage::Playing };
        }
        assert_eq!(pool.allocate(&bank), VOICES - 1);
    }

    #[test]
    fn the_pool_never_refuses_a_strike() {
        // Sixty-four voices wanted against thirty-two available is reachable
        // from a full grid and a long sample, so exhaustion is a case the
        // sequencer will meet rather than a theoretical one. What must not
        // happen is a silent drop: the newest strike is the one the player
        // just made.
        let (bank, mut pool) = one(0, 100_000, 1);
        for _ in 0..VOICES * 3 {
            pool.trigger(&bank, 0, 1.0);
        }
        assert_eq!(sounding(&pool), VOICES, "the pool lost voices or grew");

        let (left, _) = summed_frame(&mut pool, &bank);
        assert_eq!(left, VOICES as f32, "not every voice in the pool was sounding");
    }

    #[test]
    fn silencing_frees_every_voice_at_once() {
        // Nothing may be left behind, including voices already on their way
        // out.
        let (bank, mut pool) = one(0, 1_000, 1);
        pool.trigger(&bank, 0, 1.0);
        pool.trigger(&bank, 0, 1.0);
        pool.release_all();
        pool.trigger(&bank, 0, 1.0);
        assert_eq!(sounding(&pool), 3);

        pool.silence();

        assert_eq!(sounding(&pool), 0);
        assert!(silent(&mut pool, &bank, 8));
    }
}
