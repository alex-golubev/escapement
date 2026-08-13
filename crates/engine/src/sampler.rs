//! Sample memory and the voices that play it.
//!
//! A slot holds one loaded sample; a voice is one sounding copy of it. They
//! are separate counts because a sample is struck far more often than it
//! finishes — sixteen steps to the bar against a cymbal that rings for a
//! second — so eight slots feed a pool of thirty-two voices.
//!
//! **Nothing here decides how much memory a kit needs.** By the time a kit is
//! loaded the far side has decoded every file in it and knows each length and
//! channel count exactly. It names the total, [`Sampler::reserve`] takes it,
//! and a slot becomes three numbers pointing into one arena rather than a
//! buffer of its own. A constant in this module would be a guess standing in
//! for something already known, and would carry the shape of whatever it was
//! measured against into an engine that outlives the measuring.
//!
//! What sizing from outside costs is an allocation, and an allocation is the
//! one thing the render thread may never do — so it happens where the render
//! thread is not, in the message handler, between quanta. See
//! [`reserve`](Sampler::reserve) for what makes that affordable. Two
//! consequences reach past this module and neither is hidden:
//!
//! - **Reserving grows WASM linear memory, which detaches every view the
//!   worklet holds over it.** The worklet compares `memory.buffer` against the
//!   one it saw last and rebuilds its views when it differs. That check existed
//!   as a safety net against growth nobody predicted; here it carries load.
//! - **The arena moves as a whole.** A new reservation invalidates the old
//!   pointer, and with it every voice reading through it, so swapping a kit
//!   cuts every voice rather than only those of the sample being replaced.
//!   Swapping a kit is a deliberate act, not something that happens under the
//!   music.
//!
//! Everything crossing into this module is untrusted in the usual way: the
//! velocity of a strike arrives over the command protocol, the offset, length
//! and channel count of a sample arrive from the far side of the ABI.

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
///
/// **This is the one number here still measured against a drum kit**, and it is
/// worth knowing which way it binds. The arena removed the ceiling on how long
/// a sample may be and the price mono paid for stereo, but not how many samples
/// there can be at once. An instrument wanting one per key range or velocity
/// layer meets this count rather than any size — a different design, not a
/// different number. The count itself is cheap to raise, being an array of
/// three-number records; what it would leave unanswered is how a track then
/// says which slot it means.
pub const SLOTS: usize = TRACKS;

/// Voices in the pool.
///
/// Reachable as a limit rather than theoretical: at 120 BPM a sixteenth is
/// 125 ms, so a one-second sample spans eight steps, and eight tracks striking
/// every step is sixty-four sounding at once. What happens then is decided by
/// [`Sampler::allocate`].
pub const VOICES: usize = 32;

/// Channels a slot will accept.
const MAX_CHANNELS: u8 = 2;

/// Fade applied to a voice when the transport stops.
///
/// Two milliseconds is below the threshold where a fade is heard as a fade and
/// far above the one frame where a cut is heard as a click.
const RELEASE_SECONDS: f64 = 0.002;

/// Why the bank would not take what it was given.
///
/// A refusal is a value with a name on it rather than a `false`, and the
/// reason is not tidiness. Each of these is a different thing to say on the
/// page and a different thing to do about it — a kit too large for memory is
/// trimmed, a file with six channels is mixed down, a slot that does not exist
/// is a bug in the caller — and a single `false` makes the page invent which.
/// The TypeScript half already answers failure this way, with a tagged union
/// and a `describe` whose match has no default; this is the same answer on the
/// side that had never given it.
///
/// It also sharpens the test. Refusals asserted as `false` cannot tell which
/// guard fired, so a mutation that swaps two of them passes; asserted as
/// values, they cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The arena could not be made that large — the only refusal here whose
    /// cause is not in its arguments. That it is a refusal at all is the point
    /// of [`Sampler::reserve`].
    OutOfMemory { floats: usize },
    /// No slot carries that index.
    NoSuchSlot,
    /// Neither mono nor stereo.
    Channels(u8),
    /// A sample of no frames is not a sample.
    Empty,
    /// The declared sample runs past the end of the arena. Both numbers travel
    /// with it because the page can act on the difference — it laid the kit out
    /// and can lay it out again — and neither number alone says by how much.
    DoesNotFit { end: usize, reserved: usize },
}

/// Where one sample sits in the arena.
///
/// Three numbers rather than a buffer: the memory belongs to the bank, and a
/// slot only says which stretch of it this sample is and how to read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Region {
    /// Offset into the arena, counted in floats rather than frames. In floats
    /// because that is the unit it is checked in — a bound compared against a
    /// length in one unit and computed in another is a bound that passes for
    /// samples which do not fit.
    offset: usize,
    /// Frames declared by the last [`Sampler::commit`]. Zero means the slot
    /// holds nothing — the state before a kit is loaded, and again for as long
    /// as one is being written in.
    frames: usize,
    channels: u8,
}

impl Region {
    const EMPTY: Self = Self { offset: 0, frames: 0, channels: 0 };
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
    fn next_frame(
        &mut self,
        arena: &[f32],
        region: &Region,
        release_frames: f32,
    ) -> Option<[f32; 2]> {
        let envelope = match self.stage {
            Stage::Free => return None,
            Stage::Playing => 1.0,
            Stage::Releasing(left) => {
                self.stage = if left <= 1 { Stage::Free } else { Stage::Releasing(left - 1) };
                left as f32 / release_frames
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

        // For mono the two reads land on the same value, which is what makes
        // one branchless expression serve both.
        Some([left * scale, right * scale])
    }
}

/// A velocity that will produce sound, or nothing at all.
///
/// Three refusals in one named place, because two callers reach the pool and a
/// guard written at one of them is a guard at neither. Non-finite is refused
/// rather than clamped — `f32::clamp` passes NaN straight through, and a NaN
/// velocity scales a voice to a silence that never ends. Out of range is
/// clamped rather than refused: an over-loud strike is a bug on the far side,
/// and the loudest strike is a better answer to it than silence. Zero is
/// refused because a step switched off should not spend a voice on silence.
fn audible(velocity: f32) -> Option<f32> {
    if !velocity.is_finite() {
        return None;
    }
    let velocity = fz(velocity.clamp(MIN_VELOCITY, MAX_VELOCITY));
    (velocity > 0.0).then_some(velocity)
}

pub struct Sampler {
    /// Every sample in the bank, laid end to end by whoever loaded them.
    arena: Vec<f32>,
    slots: [Region; SLOTS],
    voices: [Voice; VOICES],
    release_frames: u32,
}

impl Sampler {
    pub fn new(sample_rate: f64) -> Self {
        debug_assert!(sample_rate > 0.0, "sample rate must be positive");
        Self {
            // Empty, and it stays empty until a kit arrives. Creating the
            // engine no longer decides how much sample memory the page is
            // going to want, which is why the sample rate no longer bounds
            // anything: nothing here is proportional to it any more.
            arena: Vec::new(),
            slots: [Region::EMPTY; SLOTS],
            voices: [Voice::FREE; VOICES],
            // At least one frame, so a nonsensical sample rate gives an abrupt
            // release rather than a division by zero in the ramp.
            release_frames: ((RELEASE_SECONDS * sample_rate) as u32).max(1),
        }
    }

    /// Make room for a whole kit, and hand back the arena to write it into.
    ///
    /// `floats` is the caller's sum of `frames × channels` over every sample it
    /// is about to load. The bank is loaded as a whole rather than a slot at a
    /// time, and that is forced rather than chosen: this call replaces the
    /// arena, so laying out eight samples needs all eight lengths at once.
    /// What it buys is that placement never becomes a question — the arena is
    /// built from empty every time, and there is nothing to fragment.
    ///
    /// Everything previously loaded is gone, and the voices are cut rather than
    /// faded: a fade has to keep reading the sample it is fading, which is
    /// precisely what is being replaced, so the ramp would land on whatever the
    /// new kit holds at that cursor — a worse artifact than the cut, and an
    /// unbounded one.
    ///
    /// **The refusal is the point of the whole design.** An allocation WASM
    /// cannot serve does not return an error, it aborts, and under
    /// `panic = "abort"` an abort on this thread is the end of sound until the
    /// page is reloaded. Asking through [`Vec::try_reserve_exact`] rather than
    /// growing the vector directly is the whole of the difference: "there is
    /// not that much memory" becomes a value the page can read and act on.
    pub fn reserve(&mut self, floats: usize) -> Result<&mut [f32], Refusal> {
        // Cleared before the allocation is attempted rather than after it
        // succeeds. A refusal then leaves a bank holding nothing, instead of
        // one whose slots point into an arena of the wrong size.
        self.slots = [Region::EMPTY; SLOTS];
        self.voices = [Voice::FREE; VOICES];
        self.arena.clear();

        if self.arena.try_reserve_exact(floats).is_err() {
            return Err(Refusal::OutOfMemory { floats });
        }

        // Capacity was just secured, so this fills and cannot allocate. It is
        // also what makes the window between here and the far side's copy
        // silence rather than leftovers: a kit smaller than the one before it
        // does not leave the tail of the old one lying in the arena.
        self.arena.resize(floats, 0.0);
        Ok(&mut self.arena)
    }

    /// Declare what was written into the arena, and let it sound.
    ///
    /// A refusal leaves the slot silent rather than half declared, and says
    /// which of the four things was wrong — see [`Refusal`].
    ///
    /// This is the only place sample data can be looked at.
    /// [`reserve`](Self::reserve) hands out a region and the values are written
    /// by the other side of the ABI, so there is no return path through Rust
    /// for them to be checked on — without this call the house rule that
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
    /// **What is deliberately not checked is whether two slots overlap.** Two
    /// tracks pointed at one sample is a legitimate kit rather than a mistake,
    /// and forbidding it would cost that for the sake of a check that buys
    /// nothing: an overlap made in error produces a wrong sound, not a read
    /// out of bounds, and the side that laid the kit out is the side that can
    /// tell the two apart.
    pub fn commit(
        &mut self,
        slot: usize,
        offset: usize,
        frames: usize,
        channels: u8,
    ) -> Result<(), Refusal> {
        if slot >= SLOTS {
            return Err(Refusal::NoSuchSlot);
        }
        if channels == 0 || channels > MAX_CHANNELS {
            return Err(Refusal::Channels(channels));
        }
        if frames == 0 {
            return Err(Refusal::Empty);
        }

        // Saturating, because all three numbers come from the far side and
        // `offset + frames × channels` overflows as readily as an index leaves
        // the grid. Wrapped, it would compute an end inside the arena for a
        // sample that runs far past it — a bounds check that passes on exactly
        // the input it exists to stop.
        let reserved = self.arena.len();
        let end = offset.saturating_add(frames.saturating_mul(usize::from(channels)));
        if end > reserved {
            return Err(Refusal::DoesNotFit { end, reserved });
        }

        // `offset <= end <= reserved` follows from the two lines above, so the
        // range is in bounds without a second check — and indexing out of them
        // here would end the worklet rather than return.
        for value in &mut self.arena[offset..end] {
            *value = if value.is_finite() { fz(*value) } else { 0.0 };
        }

        self.slots[slot] = Region { offset, frames, channels };
        Ok(())
    }

    /// Return to the as-constructed state: no samples, no voices.
    ///
    /// The arena's length goes with the declarations, because a bank that has
    /// been reset holds nothing — which is what "as constructed" means, and
    /// what the offline render needs before it can compare two runs. Its
    /// capacity stays: WASM linear memory never comes back once taken, so
    /// handing it over would cost the next kit a fresh growth and buy nothing
    /// at all.
    ///
    /// The consequence for the offline render is worth stating where it can be
    /// read: after a reset the kit has to be loaded again, exactly as the
    /// tempo and the pattern have to be set again.
    pub fn reset(&mut self) {
        self.slots = [Region::EMPTY; SLOTS];
        self.voices = [Voice::FREE; VOICES];
        self.arena.clear();
    }

    /// Strike a track. Silently does nothing if there is nothing to strike.
    ///
    /// One door to the voice pool, on purpose: the step sequencer and the
    /// preview command both arrive here, and a second entry point would be a
    /// preview that sounds unlike the grid — a difference heard long before it
    /// is found.
    pub fn trigger(&mut self, slot: usize, velocity: f32) {
        let Some(velocity) = audible(velocity) else {
            return;
        };
        if !self.holds_a_sample(slot) {
            return;
        }

        let index = self.allocate();
        if let Some(voice) = self.voices.get_mut(index) {
            *voice = Voice { slot, cursor: 0, velocity, stage: Stage::Playing };
        }
    }

    /// Whether striking this slot would produce anything.
    ///
    /// False for a slot that does not exist and for one holding nothing —
    /// including one whose sample is being written into the arena right now,
    /// which declares no frames until [`commit`](Self::commit) says otherwise.
    fn holds_a_sample(&self, slot: usize) -> bool {
        self.slots.get(slot).is_some_and(|region| region.frames > 0)
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

        // Split so that voices can be advanced while the arena they read is
        // borrowed: the two are disjoint fields, which the compiler will only
        // believe if it is told directly.
        let Self { arena, slots, voices, release_frames } = self;
        let release = *release_frames as f32;

        // The slot of a free voice is looked up and thrown away, which is a
        // bounds check and an address per idle voice per frame — some three
        // thousandths of a core at 48 kHz, and spent when the pool is idle,
        // which is precisely when there is nothing else to spend. Buying it
        // back costs a second test of the stage out here, in the one loop that
        // should read as a sentence.
        for voice in voices.iter_mut() {
            let Some(region) = slots.get(voice.slot) else {
                continue;
            };
            let Some(frame) = voice.next_frame(arena, region, release) else {
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
            Some(region) => region.frames.saturating_sub(voice.cursor),
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// One sample of the value 1.0, alone in the bank.
    ///
    /// One frame of it is the impulse the tests are built on: a struck voice
    /// then writes exactly one non-zero frame, so the output buffer can be
    /// read directly — where the frame sits is the onset, how big it is is the
    /// product of everything that scaled it.
    fn loaded(slot: usize, frames: usize, channels: u8) -> Sampler {
        let mut sampler = Sampler::new(SR);
        load(&mut sampler, &[(slot, frames, channels, 1.0)]);
        sampler
    }

    /// Load a whole kit: reserve for the sum, lay the samples out end to end,
    /// then declare each where it was written.
    ///
    /// Two passes and not one, and it is not the test being tidy — it is the
    /// protocol. The arena is borrowed for writing, so nothing can be declared
    /// until the writing is done, which is exactly the order the worklet works
    /// in.
    fn load(sampler: &mut Sampler, kit: &[(usize, usize, u8, f32)]) {
        let floats = |(_, frames, channels, _): &(usize, usize, u8, f32)| {
            frames * usize::from(*channels)
        };
        let total: usize = kit.iter().map(floats).sum();

        let arena = sampler.reserve(total).expect("the arena must be granted");
        let mut offset = 0;
        for sample in kit {
            let len = floats(sample);
            arena[offset..offset + len].fill(sample.3);
            offset += len;
        }

        let mut offset = 0;
        for sample in kit {
            let (slot, frames, channels, _) = *sample;
            assert_eq!(
                sampler.commit(slot, offset, frames, channels),
                Ok(()),
                "the bank refused slot {slot}"
            );
            offset += floats(sample);
        }
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
    fn a_new_sampler_asks_for_no_memory_at_all() {
        // The property that replaced a constant. Creating the engine used to
        // decide how much sample memory the page would be allowed, before the
        // page had opened a single file; now it decides nothing, and the bank
        // holds nothing until a kit names its own size.
        let mut sampler = Sampler::new(SR);
        assert_eq!(sampler.arena.capacity(), 0, "the engine took memory nobody asked for");

        // And nothing can be declared into an arena that was never reserved:
        // the bounds check is against its length, which is zero.
        assert_eq!(
            sampler.commit(0, 0, 1, 1),
            Err(Refusal::DoesNotFit { end: 1, reserved: 0 })
        );
        assert!(silent(&mut sampler, 16));
    }

    #[test]
    fn reloading_a_kit_no_larger_than_the_last_asks_for_no_new_memory() {
        // What replaces the free list. WASM linear memory only ever grows, so
        // a bank that reserved afresh on every load would climb for as long as
        // the session lasted — half an hour of swapping kits and the tab is
        // measurably heavier, with nothing to show where it went.
        let mut sampler = Sampler::new(SR);
        load(&mut sampler, &[(0, 48_000, 2, 1.0)]);
        let granted = sampler.arena.capacity();
        assert!(granted >= 96_000);

        for round in 0..64 {
            let frames = 1 + (round * 971) % 40_000;
            load(&mut sampler, &[(round % SLOTS, frames, 1 + (round % 2) as u8, 1.0)]);
            assert_eq!(sampler.arena.capacity(), granted, "round {round} grew the arena");
        }
    }

    #[test]
    fn a_kit_too_large_for_memory_is_refused_rather_than_fatal() {
        // The refusal the whole design turns on — see `reserve` for why it is
        // one at all. What this pins is that it carries the number, so the page
        // can say what it could not have.
        let mut sampler = loaded(0, 16, 1);
        let absurd = usize::MAX / 8;

        assert_eq!(sampler.reserve(absurd), Err(Refusal::OutOfMemory { floats: absurd }));

        // And a refused reservation leaves a bank holding nothing, rather than
        // slots still pointing into an arena that is no longer the right size.
        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0, "a slot survived a refused reservation");
        assert!(silent(&mut sampler, 8));
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
        // The neighbour is loaded at a different value from the sample under
        // test, so a cursor running past its declaration shows up as a tail
        // that should not be there rather than as silence.
        let mut sampler = Sampler::new(SR);
        load(&mut sampler, &[(0, 2, 1, 1.0), (1, 5_000, 1, 0.7)]);

        sampler.trigger(0, 1.0);
        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        assert_eq!(frame(&mut sampler), (1.0, 1.0));
        assert!(silent(&mut sampler, 32), "the voice ran on into its neighbour");
    }

    #[test]
    fn two_slots_may_share_one_sample() {
        // Not an accident of the layout but a thing the layout allows, and the
        // reason `commit` does not police overlap: two tracks on one sound is a
        // legitimate kit, and a check strict enough to catch a mistaken overlap
        // would forbid this along with it.
        let mut sampler = Sampler::new(SR);
        let arena = sampler.reserve(4).expect("the arena must be granted");
        arena.fill(1.0);
        assert_eq!(sampler.commit(2, 0, 4, 1), Ok(()));
        assert_eq!(sampler.commit(5, 0, 4, 1), Ok(()));

        sampler.trigger(2, 1.0);
        sampler.trigger(5, 1.0);

        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        assert_eq!(out[2][0], 1.0);
        assert_eq!(out[5][0], 1.0);
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
        // The window this guards is invisible in Rust: `reserve` returns an
        // arena the other side of the ABI has not written yet, and a voice
        // started in it would play whatever the copy has managed so far.
        let mut sampler = loaded(2, 4, 1);
        let arena = sampler.reserve(4).expect("the arena must be granted");
        arena.fill(1.0);

        sampler.trigger(2, 1.0);
        assert_eq!(sounding(&sampler), 0, "an undeclared slot was struck");
        assert!(silent(&mut sampler, 8));

        assert_eq!(sampler.commit(2, 0, 4, 1), Ok(()));
        sampler.trigger(2, 1.0);
        assert_eq!(frame(&mut sampler), (1.0, 1.0), "a declared slot must sound");
    }

    #[test]
    fn commit_cleans_what_the_far_side_wrote() {
        // The only pass over sample data there is. A NaN here reaches the
        // output and poisons every feedback path downstream of it for good; a
        // denormal costs an order of magnitude of CPU on every frame of the
        // tail that holds it, which is the house symptom of CPU climbing while
        // nothing is audible.
        let mut sampler = Sampler::new(SR);
        let arena = sampler.reserve(6).expect("the arena must be granted");
        arena.copy_from_slice(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e-40, -1e-40, 0.5]);
        assert_eq!(sampler.commit(1, 0, 6, 1), Ok(()));

        sampler.trigger(1, 1.0);
        let played: Vec<f32> = (0..6).map(|_| frame(&mut sampler).0).collect();
        assert_eq!(played, vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn commit_cleans_only_what_it_was_given() {
        // The sweep is bounded by the declaration, not by the arena, and with
        // one arena that matters in a way it did not before: a pass that ran
        // past the end would rewrite the neighbouring sample, and rewrite it
        // with values that look entirely reasonable.
        let mut sampler = Sampler::new(SR);
        let arena = sampler.reserve(4).expect("the arena must be granted");
        arena.copy_from_slice(&[f32::NAN, 0.5, 1e-40, 0.25]);
        assert_eq!(sampler.commit(0, 0, 2, 1), Ok(()));

        assert_eq!(sampler.arena[0], 0.0, "the declared frame was not cleaned");
        assert_eq!(sampler.arena[2], 1e-40, "the sweep ran past the declaration");
    }

    #[test]
    fn stereo_keeps_its_channels_apart_and_mono_reaches_both() {
        // Interleaving read with the wrong stride shows up here and almost
        // nowhere else: a mono sample read as stereo would play at double
        // speed, and a stereo one read as mono would play the left channel
        // twice at half speed. Both still sound like a drum.
        let mut sampler = Sampler::new(SR);
        let arena = sampler.reserve(4).expect("the arena must be granted");
        arena.copy_from_slice(&[1.0, -1.0, 0.5, -0.5]);
        assert_eq!(sampler.commit(0, 0, 2, 2), Ok(()));
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
    fn a_sample_reads_from_its_own_offset() {
        // Two samples in one arena, and only the offset tells them apart. Read
        // from the wrong one the kit is intact and every drum is the wrong
        // drum — which is the failure a per-slot buffer could not produce and
        // this layout can.
        let mut sampler = Sampler::new(SR);
        load(&mut sampler, &[(0, 1, 1, 0.25), (1, 1, 1, 0.75)]);

        sampler.trigger(1, 1.0);
        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        assert_eq!(out[1][0], 0.75, "the voice read from the wrong offset");
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
    fn reserving_cuts_every_voice_in_the_bank() {
        // The deliberate discontinuity, kept as a test so that it stays
        // deliberate — and it is wider than it was: the arena is replaced
        // whole, so a kit change takes the voices of every track and not only
        // those of the sample being replaced. What must not be left behind is
        // a voice reading through a pointer into the arena that was.
        let mut sampler = Sampler::new(SR);
        load(&mut sampler, &[(0, 1_000, 1, 1.0), (1, 1_000, 1, 1.0)]);

        sampler.trigger(0, 1.0);
        sampler.trigger(1, 1.0);
        assert_eq!(frame(&mut sampler), (2.0, 2.0));

        load(&mut sampler, &[(0, 4, 1, 1.0)]);

        assert_eq!(sounding(&sampler), 0, "a voice survived the new kit");
        assert!(silent(&mut sampler, 8));
    }

    #[test]
    fn what_does_not_fit_is_refused_by_name_and_leaves_the_slot_silent() {
        // Each refusal is asserted as the value it is, not as failure. Five of
        // them checked for falsehood cannot tell which guard fired, and a
        // mutation swapping two conditions is exactly what that misses.
        //
        // Refusing must leave nothing half declared: a slot sounding a
        // truncated sample would be worse than one that says no.
        let mut sampler = Sampler::new(SR);
        sampler.reserve(64).expect("the arena must be granted");

        assert_eq!(sampler.commit(0, 0, 65, 1), Err(Refusal::DoesNotFit { end: 65, reserved: 64 }));
        assert_eq!(sampler.commit(0, 60, 8, 1), Err(Refusal::DoesNotFit { end: 68, reserved: 64 }));
        assert_eq!(sampler.commit(0, 0, 33, 2), Err(Refusal::DoesNotFit { end: 66, reserved: 64 }));
        assert_eq!(sampler.commit(0, 0, 0, 1), Err(Refusal::Empty));
        assert_eq!(sampler.commit(0, 0, 8, 0), Err(Refusal::Channels(0)));
        assert_eq!(sampler.commit(0, 0, 8, 3), Err(Refusal::Channels(3)));
        assert_eq!(sampler.commit(SLOTS, 0, 8, 1), Err(Refusal::NoSuchSlot));

        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0, "a refused slot sounded");

        // The exact fit is accepted, in either channel count: the bound is the
        // arena's length in floats, and nothing about it prefers a shape.
        assert_eq!(sampler.commit(0, 0, 64, 1), Ok(()));
        assert_eq!(sampler.commit(0, 0, 32, 2), Ok(()));
    }

    #[test]
    fn an_end_that_would_overflow_is_refused_rather_than_wrapped() {
        // All three numbers come from the far side. Computed with wrapping
        // arithmetic, an offset near the top of the address space plus a
        // plausible length lands back inside the arena, and the bounds check
        // passes on exactly the input it exists to stop.
        let mut sampler = Sampler::new(SR);
        sampler.reserve(64).expect("the arena must be granted");

        for (offset, frames, channels) in [
            (usize::MAX, 8, 1),
            (usize::MAX - 4, 8, 2),
            (0, usize::MAX, 2),
            (32, usize::MAX / 2 + 1, 2),
        ] {
            let refusal = sampler.commit(0, offset, frames, channels);
            assert!(
                matches!(refusal, Err(Refusal::DoesNotFit { .. })),
                "offset {offset} frames {frames} channels {channels} gave {refusal:?}"
            );
        }
        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0);
    }

    #[test]
    fn reset_returns_to_the_as_constructed_state_and_keeps_the_memory() {
        // Both halves matter and they pull apart: the render has to be
        // identical to a fresh instance, or the golden tests compare a warmed
        // engine against a cold one — while the memory has to stay, for the
        // reason `reset` gives.
        let mut sampler = loaded(0, 4_096, 1);
        let granted = sampler.arena.capacity();
        sampler.trigger(0, 1.0);
        frame(&mut sampler);

        sampler.reset();

        assert_eq!(sounding(&sampler), 0);
        assert!(silent(&mut sampler, 16));
        sampler.trigger(0, 1.0);
        assert_eq!(sounding(&sampler), 0, "a reset slot still held its sample");
        assert_eq!(sampler.arena.capacity(), granted, "the arena was handed back");
    }
}
