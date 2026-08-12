//! Sample slots and the voices that play them.
//!
//! A slot holds one loaded sample; a voice is one sounding copy of it. They
//! are separate counts because a sample is struck far more often than it
//! finishes — sixteen steps to the bar against a cymbal that rings for a
//! second — so eight slots feed a pool of thirty-two voices.
//!
//! **Nothing here allocates after construction.** Every slot is given its
//! buffer in [`Sampler::new`], at full size, and that buffer is never resized,
//! replaced or handed back. Loading a sample writes into a region that was
//! already there.
//!
//! That is a decision, and the cheaper-looking alternative is worth naming:
//! sizing each slot to the sample put in it wastes nothing and costs three
//! things. WASM linear memory only ever grows, so every peak is permanent;
//! growth detaches every view the worklet holds over that memory; and an
//! allocation WASM cannot serve does not fail but aborts, which under
//! `panic = "abort"` ends the sound until the page is reloaded. Fixed slots
//! remove all three at once, and with them the questions that came along —
//! a free list, a length that has to be refused before it is attempted, a
//! window where a slot has been sized but not filled. What is paid for that is
//! a ceiling on how long a sample may be, and memory held whether or not
//! anything is loaded.
//!
//! Everything crossing into this module is untrusted in the usual way: the
//! velocity of a strike arrives over the command protocol, the length and
//! channel count of a sample arrive from the far side of the ABI. Each is
//! checked here rather than at the caller, because there is more than one
//! caller — the step sequencer and the preview command both strike a track,
//! and a guard on one of them would be a guard on neither.

use crate::TRACKS;
use crate::dsp::fz;
use crate::pattern::{MAX_VELOCITY, MIN_VELOCITY};

/// Sample slots — one per track.
///
/// The identity is a decision, and this line is where it is made: today a
/// track plays the slot with its own index, so there is no mapping to keep,
/// no opcode to change it, and nothing that can point a track at the wrong
/// sound. A kit whose tracks pick their slots freely would replace this line
/// with a table; it costs a table and an opcode, and today nothing wants one.
pub const SLOTS: usize = TRACKS;

/// Voices in the pool.
///
/// Reachable as a limit rather than theoretical: at 120 BPM a sixteenth is
/// 125 ms, so a one-second sample spans eight steps, and eight tracks striking
/// every step is sixty-four sounding at once. What happens then is decided by
/// [`Sampler::allocate`].
pub const VOICES: usize = 32;

/// How much sound a slot holds.
///
/// Four seconds covers a crash cymbal, which is the longest thing a drum kit
/// has; anything longer is refused with a reason rather than truncated into a
/// sound that ends wrong. The cost is fixed and worth stating in full: at
/// 48 kHz a stereo second is 375 KB, so eight slots come to 12 MB held from
/// the first quantum whether or not anything is loaded — against a tab that
/// measured 64.6 MB at the end of the skeleton milestone.
///
/// In seconds rather than frames, so that the ceiling is the same musical
/// length at any sample rate. The memory therefore scales with the rate, which
/// is why `engine_new` refuses a rate above its own limit: without that bound
/// this constant would turn an argument into an allocation of any size it
/// liked, and an allocation that fails here does not return null — it aborts.
pub const SLOT_SECONDS: f64 = 4.0;

/// Channels a slot will accept. Every slot is sized for the larger of the two,
/// so the ceiling above is four seconds whether the sample is mono or stereo.
const MAX_CHANNELS: u8 = 2;

/// Fade applied to a voice when the transport stops.
///
/// Two milliseconds is below the threshold where a fade is heard as a fade and
/// far above the one frame where a cut is heard as a click.
const RELEASE_SECONDS: f64 = 0.002;

/// One slot: a buffer that never moves, and what is currently declared in it.
#[derive(Debug, Clone)]
struct Sample {
    /// Interleaved: frame 0 left, frame 0 right, frame 1 left, and so on.
    /// Interleaved and not planar because a voice reads one cursor forwards;
    /// two planes would be two cursors and two cache lines for the same frame.
    ///
    /// Always the full capacity of a slot. The declared sample is a prefix of
    /// it; what lies past that prefix is whatever the last tenant left, and is
    /// never read.
    data: Vec<f32>,
    /// Frames declared by the last [`Sampler::commit`]. Zero means the slot
    /// holds nothing — the state before anything is loaded, and again for as
    /// long as one is being written into.
    frames: usize,
    channels: u8,
}

impl Sample {
    fn new(capacity_frames: usize) -> Self {
        Self {
            data: vec![0.0; capacity_frames * usize::from(MAX_CHANNELS)],
            frames: 0,
            channels: 0,
        }
    }
}

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
}

pub struct Sampler {
    slots: [Sample; SLOTS],
    voices: [Voice; VOICES],
    capacity_frames: usize,
    release_frames: u32,
}

impl Sampler {
    pub fn new(sample_rate: f64) -> Self {
        debug_assert!(sample_rate > 0.0, "sample rate must be positive");
        let capacity_frames = (SLOT_SECONDS * sample_rate) as usize;
        Self {
            slots: core::array::from_fn(|_| Sample::new(capacity_frames)),
            voices: [Voice::FREE; VOICES],
            capacity_frames,
            // At least one frame, so a nonsensical sample rate gives an abrupt
            // release rather than a division by zero in the ramp.
            release_frames: ((RELEASE_SECONDS * sample_rate) as u32).max(1),
        }
    }

    /// Longest sample a slot will take, in frames.
    ///
    /// Exposed because the page has to refuse an over-long file before it
    /// writes one: the region handed out by [`begin_load`](Self::begin_load) is
    /// this many frames of stereo, and there is nothing past it to spill into.
    pub fn capacity_frames(&self) -> usize {
        self.capacity_frames
    }

    /// Return to the as-constructed state: no samples, no voices.
    ///
    /// The buffers are left alone, and their contents are not cleared either.
    /// That is not laziness: a slot with no frames declared cannot be read, so
    /// a reset instance renders exactly as a fresh one does — which is what the
    /// offline render needs — while nobody pays to zero twelve megabytes that
    /// nothing will look at.
    pub fn reset(&mut self) {
        for slot in &mut self.slots {
            slot.frames = 0;
            slot.channels = 0;
        }
        self.voices = [Voice::FREE; VOICES];
    }

    /// Open a slot for writing and hand back the region to write into.
    ///
    /// The region is [`capacity_frames`](Self::capacity_frames) frames of
    /// stereo, and its address never changes — for this slot or any other,
    /// from construction to the end of the engine. That is the point of the
    /// fixed layout: the far side may keep the pointer, and nothing here can
    /// invalidate it.
    ///
    /// The slot is silenced before the region is handed over, and this is not
    /// bookkeeping — it is the only thing between a voice and a buffer being
    /// overwritten underneath it. What the far side writes arrives after this
    /// call returns, so until [`commit`](Self::commit) the slot holds a mixture
    /// of two samples and must not be read.
    ///
    /// **Voices on this slot are cut, not faded**, and that is the one
    /// discontinuity this module accepts deliberately. A fade has to keep
    /// reading the sample it is fading, and the sample is precisely what is
    /// being replaced: the ramp would be applied to whatever the new sound has
    /// at that cursor, which is a worse artifact than the cut and an unbounded
    /// one. Keeping the old sound alive until its voices drain needs a second
    /// buffer for every slot, and buys it for the moment a kit is swapped —
    /// which is a deliberate act, not something happening under the music.
    pub fn begin_load(&mut self, slot: usize) -> Option<&mut [f32]> {
        if slot >= SLOTS {
            return None;
        }

        for voice in &mut self.voices {
            if voice.slot == slot {
                voice.stage = Stage::Free;
            }
        }

        let target = self.slots.get_mut(slot)?;
        target.frames = 0;
        target.channels = 0;
        Some(&mut target.data)
    }

    /// Declare what was written into the slot, and let it sound.
    ///
    /// `false` for a slot that does not exist, a channel count that is not
    /// mono or stereo, an empty sample, or a length past the slot's capacity.
    /// A refusal leaves the slot silent rather than half loaded.
    ///
    /// This is the only place sample data can be looked at.
    /// [`begin_load`](Self::begin_load) hands out a region and the values are
    /// written by the other side of the ABI, so there is no return path through
    /// Rust for them to be checked on — without this call the house rule that
    /// everything crossing the ABI is input would have exactly one exception,
    /// and it would be the largest buffer in the engine.
    ///
    /// A non-finite value becomes silence rather than rejecting the whole
    /// sample: one NaN is a bug upstream either way, and zeroing that frame
    /// costs a click where dropping the sample costs a track. Denormals go the
    /// same way as everywhere else — a sample decaying into the denormal range
    /// would burn CPU on every voice that reached its tail, which is the house
    /// symptom of CPU climbing during silence.
    ///
    /// Only the declared prefix is swept. Past it lies whatever the previous
    /// tenant left, and it is cheaper to leave it than to walk four seconds of
    /// stereo for the sake of a hundred-millisecond hat.
    pub fn commit(&mut self, slot: usize, frames: usize, channels: u8) -> bool {
        if channels == 0 || channels > MAX_CHANNELS {
            return false;
        }
        if frames == 0 || frames > self.capacity_frames {
            return false;
        }
        let Some(target) = self.slots.get_mut(slot) else {
            return false;
        };

        let len = frames * usize::from(channels);
        let Some(declared) = target.data.get_mut(..len) else {
            return false;
        };
        for value in declared {
            *value = if value.is_finite() { fz(*value) } else { 0.0 };
        }

        target.frames = frames;
        target.channels = channels;
        true
    }

    /// Strike a track. Silently does nothing if there is nothing to strike.
    ///
    /// One door to the voice pool, on purpose: the step sequencer and the
    /// preview command both arrive here, and a second entry point would be a
    /// preview that sounds unlike the grid — a difference heard long before it
    /// is found.
    pub fn trigger(&mut self, slot: usize, velocity: f32) {
        if !velocity.is_finite() {
            return;
        }
        let velocity = fz(velocity.clamp(MIN_VELOCITY, MAX_VELOCITY));
        // Zero is a step that does not sound, and a voice scaled by zero is a
        // voice spending a slot on silence.
        if velocity == 0.0 {
            return;
        }

        let Some(sample) = self.slots.get(slot) else {
            return;
        };
        if sample.frames == 0 {
            return;
        }

        let index = self.allocate();
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
    pub fn next_frame(&mut self, out: &mut [[f32; 2]; TRACKS]) {
        *out = [[0.0; 2]; TRACKS];

        // Split so that voices can be advanced while the slots they read are
        // borrowed: the two are disjoint fields, which the compiler will only
        // believe if it is told directly.
        let Self { slots, voices, release_frames, .. } = self;
        let release = *release_frames as f32;

        for voice in voices.iter_mut() {
            let envelope = match voice.stage {
                Stage::Free => continue,
                Stage::Playing => 1.0,
                Stage::Releasing(left) => left as f32 / release,
            };

            let Some(sample) = slots.get(voice.slot) else {
                voice.stage = Stage::Free;
                continue;
            };
            if voice.cursor >= sample.frames {
                voice.stage = Stage::Free;
                continue;
            }

            // In range by the check above: `cursor` is below the declared frame
            // count, and `commit` only declares a length the buffer holds. Past
            // that prefix lies the previous tenant's sound, which is exactly
            // what this must not reach.
            let channels = usize::from(sample.channels);
            let base = voice.cursor * channels;
            let scale = voice.velocity * envelope;
            let left = sample.data[base] * scale;
            let right = sample.data[base + channels - 1] * scale;

            if let Some(track) = out.get_mut(voice.slot) {
                track[0] += left;
                track[1] += right;
            }

            voice.cursor += 1;
            if let Stage::Releasing(left) = voice.stage {
                voice.stage = if left <= 1 { Stage::Free } else { Stage::Releasing(left - 1) };
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
    fn allocate(&self) -> usize {
        let mut best = 0usize;
        let mut best_rank = (u8::MAX, usize::MAX);

        for (index, voice) in self.voices.iter().enumerate() {
            let rank = match voice.stage {
                Stage::Free => return index,
                Stage::Releasing(left) => (0u8, left as usize),
                Stage::Playing => (1u8, self.remaining(voice)),
            };
            if rank < best_rank {
                best_rank = rank;
                best = index;
            }
        }
        best
    }

    /// Frames of its sample a voice has left.
    fn remaining(&self, voice: &Voice) -> usize {
        match self.slots.get(voice.slot) {
            Some(sample) => sample.frames.saturating_sub(voice.cursor),
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// A sampler with one slot holding `frames` frames of the value 1.0.
    ///
    /// One frame of it is the impulse the tests are built on: a struck voice
    /// then writes exactly one non-zero frame, so the output buffer can be
    /// read directly — where the frame sits is the onset, how big it is is the
    /// product of everything that scaled it.
    fn loaded(slot: usize, frames: usize, channels: u8) -> Sampler {
        let mut sampler = Sampler::new(SR);
        write(&mut sampler, slot, frames, channels, 1.0);
        sampler
    }

    /// Fill the head of a slot with one value and declare it.
    fn write(sampler: &mut Sampler, slot: usize, frames: usize, channels: u8, value: f32) {
        let region = sampler.begin_load(slot).expect("the slot must open");
        region[..frames * usize::from(channels)].fill(value);
        assert!(sampler.commit(slot, frames, channels), "the slot must accept this sample");
    }

    /// One frame, summed across tracks — for tests that do not care which
    /// track sounded.
    fn frame(sampler: &mut Sampler) -> (f32, f32) {
        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        out.iter().fold((0.0, 0.0), |(l, r), track| (l + track[0], r + track[1]))
    }

    fn silent(sampler: &mut Sampler, frames: usize) -> bool {
        (0..frames).all(|_| frame(sampler) == (0.0, 0.0))
    }

    fn sounding(sampler: &Sampler) -> usize {
        sampler.voices.iter().filter(|v| v.stage != Stage::Free).count()
    }

    #[test]
    fn every_slot_has_its_memory_from_the_start() {
        // The invariant the ABI rests on. Each slot is writable before
        // anything has been loaded and holds four seconds of stereo, so
        // loading a sample is a copy and never a request for memory.
        let mut sampler = Sampler::new(SR);
        assert_eq!(sampler.capacity_frames(), (SLOT_SECONDS * SR) as usize);

        let capacity = sampler.capacity_frames();
        for slot in 0..SLOTS {
            let region = sampler.begin_load(slot).expect("every slot must open");
            assert_eq!(region.len(), capacity * usize::from(MAX_CHANNELS), "slot {slot}");
        }
        assert!(sampler.begin_load(SLOTS).is_none());
        assert!(sampler.begin_load(usize::MAX).is_none());
    }

    #[test]
    fn a_slot_keeps_its_address_through_every_load() {
        // What replaces the free list, and a stronger promise than one: the
        // buffer is not reused but never given up. A region that moved would
        // leave the worklet writing a sample into memory the engine no longer
        // reads — nothing to report, and silence to show for it.
        let mut sampler = Sampler::new(SR);
        let addresses: Vec<*const f32> =
            (0..SLOTS).map(|slot| sampler.slots[slot].data.as_ptr()).collect();

        for round in 0..64 {
            for slot in 0..SLOTS {
                let frames = 1 + (round * 37 + slot) % 5_000;
                write(&mut sampler, slot, frames, 1 + (slot % 2) as u8, 1.0);
            }
        }

        for (slot, address) in addresses.iter().enumerate() {
            assert_eq!(sampler.slots[slot].data.as_ptr(), *address, "slot {slot} moved");
        }
    }

    #[test]
    fn a_new_sampler_holds_nothing_and_says_so() {
        let mut sampler = Sampler::new(SR);
        assert!(silent(&mut sampler, 64));
        assert_eq!(sounding(&sampler), 0);
        // Striking a slot with no sample in it is not an error and not a
        // voice: the grid is edited before the kit is loaded, every time.
        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0);
        assert!(silent(&mut sampler, 8));
    }

    #[test]
    fn an_impulse_sounds_on_the_frame_it_was_struck_and_not_after() {
        // The property every onset test downstream rests on. A voice that
        // started one frame late, or that repeated its first frame, would
        // still sound like a drum and would put the whole grid off the beat.
        let mut sampler = loaded(3, 1, 1);
        sampler.trigger(3, 1.0);

        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        assert!(silent(&mut sampler, 16), "the voice outlived its one frame");
        assert_eq!(sounding(&sampler), 0, "the voice did not free itself");
    }

    #[test]
    fn a_voice_never_reads_past_what_was_declared() {
        // The buffer outlives its tenants, so the frames past a short sample
        // hold the sound that was there before. Reading one of them is a drum
        // with a tail from the wrong kit — audible, and impossible to
        // attribute. This is the case the fixed layout adds and the sized-to-
        // fit one could not have.
        let mut sampler = Sampler::new(SR);
        write(&mut sampler, 0, 5_000, 1, 0.7);
        write(&mut sampler, 0, 2, 1, 1.0);

        sampler.trigger(0, 1.0);
        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        assert!(silent(&mut sampler, 32), "the voice ran on into the previous sample");
    }

    #[test]
    fn a_voice_sounds_on_its_own_track() {
        // A sum would hide this, and the mixer downstream applies a level per
        // track: a voice landing on the wrong row would be a fader moving a
        // sound it does not name.
        let mut sampler = loaded(5, 1, 1);
        sampler.trigger(5, 1.0);

        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        for (track, pair) in out.iter().enumerate() {
            let expected = if track == 5 { 1.0 } else { 0.0 };
            assert_eq!(pair[0], expected, "track {track}");
        }
    }

    #[test]
    fn velocity_scales_the_strike() {
        for velocity in [1.0f32, 0.5, 0.25, MAX_VELOCITY] {
            let mut sampler = loaded(0, 1, 1);
            sampler.trigger(0, velocity);
            assert_eq!(frame(&mut sampler), (velocity, velocity), "velocity {velocity}");
        }
    }

    #[test]
    fn a_velocity_that_cannot_sound_starts_no_voice() {
        // Zero is a step switched off, and the guard is against spending a
        // voice on silence — with a full grid the pool is the scarce thing.
        // Non-finite is refused rather than clamped: `f32::clamp` passes NaN
        // through, and a NaN velocity scales a voice to silence that never
        // ends and cannot be recovered.
        let mut sampler = loaded(0, 1, 1);
        for bad in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            sampler.trigger(0, bad);
            assert_eq!(sounding(&sampler), 0, "velocity {bad} started a voice");
        }
        // And an out-of-range velocity is clamped rather than dropped: 2.0 is
        // a UI bug, silence would be a worse answer than the loudest strike.
        sampler.trigger(0, 2.0);
        assert_eq!(frame(&mut sampler), (MAX_VELOCITY, MAX_VELOCITY));
    }

    #[test]
    fn a_slot_out_of_range_is_dropped_rather_than_wrapped() {
        // The index arrives as a byte from another thread, so 200 is as
        // reachable as 3, and writing it into a neighbour would turn a bug on
        // the far side into a wrong drum here.
        let mut sampler = loaded(0, 1, 1);
        for slot in [SLOTS, SLOTS + 1, 200, usize::MAX] {
            sampler.trigger(slot, 1.0);
            assert_eq!(sounding(&sampler), 0, "slot {slot} started a voice");
        }
    }

    #[test]
    fn a_slot_that_was_not_committed_does_not_sound() {
        // The window this guards is invisible in Rust: `begin_load` returns a
        // region the other side of the ABI has not written yet, and the region
        // still holds the sample being replaced. A voice started there would
        // play half of each.
        let mut sampler = loaded(2, 4, 1);
        let region = sampler.begin_load(2).expect("the slot must open");
        region[..4].fill(1.0);

        sampler.trigger(2, 1.0);
        assert_eq!(sounding(&sampler), 0, "an uncommitted slot was struck");
        assert!(silent(&mut sampler, 8));

        assert!(sampler.commit(2, 4, 1));
        sampler.trigger(2, 1.0);
        assert_eq!(frame(&mut sampler), (1.0, 1.0), "a committed slot must sound");
    }

    #[test]
    fn commit_cleans_what_the_far_side_wrote() {
        // The only pass over sample data there is. A NaN here reaches the
        // output and poisons every feedback path downstream of it for good; a
        // denormal costs an order of magnitude of CPU on every frame of the
        // tail that holds it, which is the house symptom of CPU climbing while
        // nothing is audible.
        let mut sampler = Sampler::new(SR);
        let region = sampler.begin_load(1).expect("the slot must open");
        region[..6]
            .copy_from_slice(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e-40, -1e-40, 0.5]);
        assert!(sampler.commit(1, 6, 1));

        sampler.trigger(1, 1.0);
        let played: Vec<f32> = (0..6).map(|_| frame(&mut sampler).0).collect();
        assert_eq!(played, vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn stereo_keeps_its_channels_apart_and_mono_reaches_both() {
        // Interleaving read with the wrong stride shows up here and almost
        // nowhere else: a mono sample read as stereo would play at double
        // speed, and a stereo one read as mono would play the left channel
        // twice at half speed. Both still sound like a drum.
        let mut sampler = Sampler::new(SR);
        let region = sampler.begin_load(0).expect("the slot must open");
        region[..4].copy_from_slice(&[1.0, -1.0, 0.5, -0.5]);
        assert!(sampler.commit(0, 2, 2));
        sampler.trigger(0, 1.0);

        assert_eq!(frame(&mut sampler), (1.0, -1.0));
        assert_eq!(frame(&mut sampler), (0.5, -0.5));
        assert!(silent(&mut sampler, 4), "a two-frame stereo sample lasted longer");

        let mut mono = loaded(0, 1, 1);
        mono.trigger(0, 1.0);
        let (left, right) = frame(&mut mono);
        assert_eq!(left, right, "a mono sample must reach both channels alike");
    }

    #[test]
    fn the_same_slot_struck_again_sounds_twice_over() {
        // A drum machine retriggers a track long before its sample has
        // finished — a closed hat on every sixteenth is the normal case, not
        // an edge one — and the two strikes overlap rather than choking each
        // other. Nothing in the pool ties a voice to a track.
        let mut sampler = loaded(0, 8, 1);
        sampler.trigger(0, 1.0);
        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        sampler.trigger(0, 1.0);
        assert_eq!(frame(&mut sampler), (2.0, 2.0), "the second strike replaced the first");
        assert_eq!(sounding(&sampler), 2);
    }

    #[test]
    fn stopping_fades_the_voices_rather_than_cutting_them() {
        // The fade is the whole reason `Releasing` exists. Its shape matters
        // in two ways and both are asserted: it must not start with a step —
        // the first frame after a stop is as loud as the last one before it —
        // and it must reach exact silence, because a ramp that only approaches
        // zero leaves a voice occupying the pool forever.
        let mut sampler = loaded(0, 100_000, 1);
        sampler.trigger(0, 1.0);
        let before = frame(&mut sampler).0;

        sampler.release_all();
        let first = frame(&mut sampler).0;
        assert_eq!(first, before, "the release began with a step");

        let mut previous = first;
        let release = sampler.release_frames as usize;
        for _ in 1..release {
            let value = frame(&mut sampler).0;
            assert!(value < previous, "the release stalled at {value}");
            previous = value;
        }

        assert!(silent(&mut sampler, 8), "the release did not reach silence");
        assert_eq!(sounding(&sampler), 0, "a faded voice stayed in the pool");
    }

    #[test]
    fn the_pool_takes_the_voice_that_is_least_missed() {
        // Stated against the choice rather than against the sound, because the
        // sound of a wrong choice is a click that only some patterns produce.
        // Free first; then the most faded of those already releasing, where
        // the cut lands near zero; then the playing voice with the least of
        // its sample left.
        let mut sampler = loaded(0, 1_000, 1);

        // One free voice among busy ones is taken, wherever it sits.
        for voice in sampler.voices.iter_mut() {
            voice.stage = Stage::Playing;
        }
        sampler.voices[7].stage = Stage::Free;
        assert_eq!(sampler.allocate(), 7);

        // No free voice: the most faded release wins over any playing voice,
        // however near its end.
        for voice in sampler.voices.iter_mut() {
            *voice = Voice { slot: 0, cursor: 999, velocity: 1.0, stage: Stage::Playing };
        }
        sampler.voices[4].stage = Stage::Releasing(90);
        sampler.voices[9].stage = Stage::Releasing(3);
        assert_eq!(sampler.allocate(), 9);

        // Nothing releasing either: the one with the least left to play.
        for (index, voice) in sampler.voices.iter_mut().enumerate() {
            *voice = Voice { slot: 0, cursor: index * 10, velocity: 1.0, stage: Stage::Playing };
        }
        assert_eq!(sampler.allocate(), VOICES - 1);
    }

    #[test]
    fn the_pool_never_refuses_a_strike() {
        // Sixty-four voices wanted against thirty-two available is reachable
        // from a full grid and a long sample, so exhaustion is a case the
        // sequencer will meet rather than a theoretical one. What must not
        // happen is a silent drop: the newest strike is the one the player
        // just made.
        let mut sampler = loaded(0, 100_000, 1);
        for _ in 0..VOICES * 3 {
            sampler.trigger(0, 1.0);
        }
        assert_eq!(sounding(&sampler), VOICES, "the pool lost voices or grew");

        let (left, _) = frame(&mut sampler);
        assert_eq!(left, VOICES as f32, "not every voice in the pool was sounding");
    }

    #[test]
    fn opening_a_slot_cuts_only_its_own_voices() {
        // The deliberate discontinuity, kept as a test so that it stays
        // deliberate. What it must not do is reach the other tracks, and what
        // it must not leave is a voice reading a buffer being written into.
        let mut sampler = loaded(0, 1_000, 1);
        write(&mut sampler, 1, 1_000, 1, 1.0);

        sampler.trigger(0, 1.0);
        sampler.trigger(1, 1.0);
        assert_eq!(frame(&mut sampler), (2.0, 2.0));

        write(&mut sampler, 0, 4, 1, 1.0);

        assert_eq!(frame(&mut sampler), (1.0, 1.0), "the reload took the wrong voices");
        assert_eq!(sounding(&sampler), 1);
    }

    #[test]
    fn a_sample_that_does_not_fit_is_refused_and_leaves_the_slot_silent() {
        // The ceiling the fixed layout buys, and the failure it replaces: with
        // slots sized to their contents this argument would have been an
        // allocation, and one WASM cannot serve aborts rather than failing.
        // Refusing must leave nothing half loaded — a slot sounding a
        // truncated sample would be worse than one that says no.
        let mut sampler = loaded(0, 64, 1);
        let capacity = sampler.capacity_frames();
        sampler.begin_load(0).expect("the slot must open");

        assert!(!sampler.commit(0, capacity + 1, 1), "an over-long sample was accepted");
        assert!(!sampler.commit(0, 0, 1), "an empty sample is not a sample");
        assert!(!sampler.commit(0, 8, 0));
        assert!(!sampler.commit(0, 8, 3));
        assert!(!sampler.commit(SLOTS, 8, 1), "a slot that does not exist was committed");

        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0, "a refused slot sounded");

        // The ceiling is a duration and not a float count, so the largest
        // sample is the capacity in stereo — which fills the buffer exactly.
        // Mono at the same length uses half of it and is refused past the same
        // number of frames: four seconds is four seconds either way.
        assert!(sampler.commit(0, capacity, 2), "the largest sample that fits was refused");
        assert!(sampler.commit(0, capacity, 1));
    }

    #[test]
    fn reset_returns_to_the_as_constructed_state_and_keeps_the_memory() {
        // Both halves matter and they pull apart: the render has to be
        // identical to a fresh instance, or the golden tests compare a warmed
        // engine against a cold one — while handing the buffers back would put
        // the allocation this module exists to avoid into the offline
        // renderer, once per run.
        let mut sampler = loaded(0, 4_096, 1);
        let address = sampler.slots[0].data.as_ptr();
        sampler.trigger(0, 1.0);
        frame(&mut sampler);

        sampler.reset();

        assert_eq!(sounding(&sampler), 0);
        assert!(silent(&mut sampler, 16));
        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0, "a reset slot still held its sample");
        assert_eq!(sampler.slots[0].data.as_ptr(), address, "the buffer was handed back");
    }
}
