//! The memory samples live in, and the only place their data is looked at.
//!
//! **Nothing here decides how much memory a kit needs.** By the time a kit is
//! loaded the far side has decoded every file in it and knows each length and
//! channel count exactly. It names the total, [`Bank::reserve`] takes it, and a
//! slot becomes three numbers pointing into one arena rather than a buffer of
//! its own. A constant in this module would be a guess standing in for
//! something already known, and would carry the shape of whatever it was
//! measured against into an engine that outlives the measuring.
//!
//! What sizing from outside costs is an allocation, and an allocation is the
//! one thing the render thread may never do — so it happens where the render
//! thread is not, in the message handler, between quanta. See
//! [`reserve`](Bank::reserve) for what makes that affordable. Two consequences
//! reach past this module and neither is hidden:
//!
//! - **Reserving grows WASM linear memory, which detaches every view the
//!   worklet holds over it.** The worklet compares `memory.buffer` against the
//!   one it saw last and rebuilds its views when it differs. That check existed
//!   as a safety net against growth nobody predicted; here it carries load.
//! - **The arena moves as a whole.** A new reservation invalidates the old
//!   pointer, and with it every voice reading through it. Cutting those voices
//!   is not this module's to do — it holds no voices — which is why reserving
//!   goes through [`Sampler`](super::Sampler) rather than being called here
//!   directly.

use crate::TRACKS;
use crate::dsp::sanitized;

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

const MAX_CHANNELS: u8 = 2;

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
    /// of [`Bank::reserve`].
    OutOfMemory { floats: usize },
    NoSuchSlot,
    /// Neither mono nor stereo.
    Channels(u8),
    Empty,
    /// The declared sample runs past the end of the arena. Both numbers travel
    /// with it because the page can act on the difference — it laid the kit out
    /// and can lay it out again — and neither number alone says by how much.
    DoesNotFit { end: usize, reserved: usize },
}

/// Where one sample sits in the arena.
///
/// Fields open to the rest of the sampler: the voice reading a sample needs all
/// three every frame, and accessors around three `usize`s would be ceremony.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    /// In floats rather than frames, because floats is the unit it is checked
    /// in — a bound compared against a length in one unit and computed in
    /// another passes for samples that do not fit.
    pub(super) offset: usize,
    /// Zero means the slot holds nothing: before a kit is loaded, and again for
    /// as long as one is being written in. **This is the only field that says
    /// so**, which is what lets the other two describe a shape unconditionally.
    pub(super) frames: usize,
    /// Channels, and so the stride from one frame of the sample to the next.
    ///
    /// **Never zero, including in a slot holding nothing.** A reader takes the
    /// last channel of a frame as `channels - 1`, and a stride of zero makes
    /// that a subtraction below zero — a panic in debug, and in release a read
    /// of the float lying before the sample. Neither is reachable today, and
    /// both are reachable by rearranging two lines: the guard is the emptiness
    /// test above happening to come first. A stride describes how the data is
    /// laid out, and data nobody declared is still laid out some way; making
    /// this field carry emptiness as well would be a second answer to a
    /// question `frames` already answers.
    pub(super) channels: u8,
}

impl Region {
    /// A slot holding nothing. One channel rather than none, for the reason
    /// that field gives.
    const EMPTY: Self = Self { offset: 0, frames: 0, channels: 1 };
}

pub struct Bank {
    /// Laid out by whoever loaded the kit; this side only reads the layout
    /// back off the regions it was given.
    arena: Vec<f32>,
    slots: [Region; SLOTS],
}

impl Bank {
    pub fn new() -> Self {
        Self {
            // Creating the engine decides nothing about sample memory, which
            // is why `engine_new` no longer bounds the sample rate: nothing
            // here is proportional to it.
            arena: Vec::new(),
            slots: [Region::EMPTY; SLOTS],
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
    /// Everything previously loaded is gone. Voices reading it must be cut, and
    /// they are cut by [`Sampler::reserve`](super::Sampler::reserve), which is
    /// the only caller: a fade would have to keep reading the sample it is
    /// fading, which is precisely what is being replaced, so the ramp would land
    /// on whatever the new kit holds at that cursor — a worse artifact than the
    /// cut, and an unbounded one.
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
        self.arena.clear();

        if self.arena.try_reserve_exact(floats).is_err() {
            return Err(Refusal::OutOfMemory { floats });
        }

        // Fills rather than allocates, the capacity being secured above — and
        // makes the window before the far side's copy silence rather than
        // leftovers: a smaller kit does not leave the tail of the old one here.
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
    /// The pass itself is [`dsp::sanitized`](crate::dsp) per value, which is
    /// the door for data rather than for parameters — see there for why a bad
    /// sample becomes silence instead of a refusal.
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

        // Indexed without a further check: out of bounds here would not return
        // but end the worklet.
        for value in &mut self.arena[offset..end] {
            *value = sanitized(*value);
        }

        self.slots[slot] = Region { offset, frames, channels };
        Ok(())
    }

    /// Declare the bank empty, keeping the memory it was given.
    ///
    /// The arena's length goes with the declarations, because a bank that has
    /// been reset holds nothing — which is what "as constructed" means, and
    /// what the offline render needs before it can compare two runs. Its
    /// capacity stays: WASM linear memory never comes back once taken, so
    /// handing it over would cost the next kit a fresh growth and buy nothing
    /// at all.
    ///
    /// The consequence for the offline render is worth stating where it can be
    /// read: after a reset the kit has to be loaded again, exactly as the tempo
    /// and the pattern have to be set again.
    pub fn reset(&mut self) {
        self.slots = [Region::EMPTY; SLOTS];
        self.arena.clear();
    }

    pub(super) fn arena(&self) -> &[f32] {
        &self.arena
    }

    pub(super) fn region(&self, slot: usize) -> Option<&Region> {
        self.slots.get(slot)
    }

    /// Whether striking this slot would produce anything.
    ///
    /// False for a slot that does not exist and for one holding nothing —
    /// including one whose sample is being written into the arena right now,
    /// which declares no frames until [`commit`](Self::commit) says otherwise.
    pub(super) fn holds_a_sample(&self, slot: usize) -> bool {
        self.region(slot).is_some_and(|region| region.frames > 0)
    }
}

#[cfg(test)]
pub(in crate::sampler) mod tests {
    use super::*;

    /// Load a whole kit: reserve for the sum, lay the samples out end to end,
    /// then declare each where it was written.
    ///
    /// Two passes and not one, and it is not the test being tidy — it is the
    /// protocol. The arena is borrowed for writing, so nothing can be declared
    /// until the writing is done, which is exactly the order the worklet works
    /// in. Shared with the voice tests, which need a loaded bank to read from:
    /// one builder, so a change to the load protocol cannot be made in one
    /// place and missed in the other.
    pub(in crate::sampler) fn loaded(kit: &[(usize, usize, u8, f32)]) -> Bank {
        let mut bank = Bank::new();
        load(&mut bank, kit);
        bank
    }

    pub(in crate::sampler) fn load(bank: &mut Bank, kit: &[(usize, usize, u8, f32)]) {
        let floats =
            |(_, frames, channels, _): &(usize, usize, u8, f32)| frames * usize::from(*channels);
        let total: usize = kit.iter().map(floats).sum();

        let arena = bank.reserve(total).expect("the arena must be granted");
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
                bank.commit(slot, offset, frames, channels),
                Ok(()),
                "the bank refused slot {slot}"
            );
            offset += floats(sample);
        }
    }

    #[test]
    fn a_new_bank_asks_for_no_memory_at_all() {
        // The engine must take no sample memory before a kit has named a
        // size, and must refuse anything declared into what it has not been
        // given.
        let mut bank = Bank::new();
        assert_eq!(bank.arena().len(), 0, "the engine took memory nobody asked for");

        // And nothing can be declared into an arena that was never reserved:
        // the bounds check is against its length, which is zero.
        assert_eq!(bank.commit(0, 0, 1, 1), Err(Refusal::DoesNotFit { end: 1, reserved: 0 }));
        assert!(!bank.holds_a_sample(0));
    }

    #[test]
    fn a_slot_holding_nothing_still_describes_a_legal_stride() {
        // `channels` is a stride, and the voice reads the last channel of a
        // frame at `channels - 1`. Zero there subtracts below zero. The two
        // ways a slot comes to hold nothing are this constant and a refused
        // reservation — `commit` cannot produce one, having refused a channel
        // count of zero before it builds a region at all — so both are checked
        // here, where the constant is.
        let mut bank = loaded(&[(0, 16, 2, 1.0)]);
        bank.reset();
        let absurd = usize::MAX / 8;
        assert_eq!(bank.reserve(absurd), Err(Refusal::OutOfMemory { floats: absurd }));

        for slot in 0..SLOTS {
            let region = bank.region(slot).expect("every slot has a declaration");
            assert_eq!(region.frames, 0, "slot {slot} still declares frames");
            assert!(region.channels >= 1, "slot {slot} has a stride of zero");
        }
    }

    #[test]
    fn reloading_a_kit_no_larger_than_the_last_asks_for_no_new_memory() {
        // What replaces the free list. WASM linear memory only ever grows, so
        // a bank that reserved afresh on every load would climb for as long as
        // the session lasted — half an hour of swapping kits and the tab is
        // measurably heavier, with nothing to show where it went.
        let mut bank = loaded(&[(0, 48_000, 2, 1.0)]);
        let granted = bank.arena.capacity();
        assert!(granted >= 96_000);

        for round in 0..64 {
            let frames = 1 + (round * 971) % 40_000;
            load(&mut bank, &[(round % SLOTS, frames, 1 + (round % 2) as u8, 1.0)]);
            assert_eq!(bank.arena.capacity(), granted, "round {round} grew the arena");
        }
    }

    #[test]
    fn a_kit_too_large_for_memory_is_refused_rather_than_fatal() {
        // The refusal the whole design turns on — see `reserve` for why it is
        // one at all. What this pins is that it carries the number, so the page
        // can say what it could not have.
        let mut bank = loaded(&[(0, 16, 1, 1.0)]);
        let absurd = usize::MAX / 8;

        assert_eq!(bank.reserve(absurd), Err(Refusal::OutOfMemory { floats: absurd }));

        // And a refused reservation leaves a bank holding nothing, rather than
        // slots still pointing into an arena that is no longer the right size.
        assert!(!bank.holds_a_sample(0), "a slot survived a refused reservation");
    }

    #[test]
    fn commit_cleans_what_the_far_side_wrote() {
        // The only pass over sample data there is. A NaN here reaches the
        // output and poisons every feedback path downstream of it for good; a
        // denormal costs an order of magnitude of CPU on every frame of the
        // tail that holds it, which is the house symptom of CPU climbing while
        // nothing is audible.
        let mut bank = Bank::new();
        let arena = bank.reserve(6).expect("the arena must be granted");
        arena.copy_from_slice(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 1e-40, -1e-40, 0.5]);
        assert_eq!(bank.commit(1, 0, 6, 1), Ok(()));

        assert_eq!(bank.arena(), &[0.0, 0.0, 0.0, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn commit_cleans_only_what_it_was_given() {
        // The sweep is bounded by the declaration, not by the arena, and with
        // one arena that matters in a way it did not before: a pass that ran
        // past the end would rewrite the neighbouring sample, and rewrite it
        // with values that look entirely reasonable.
        let mut bank = Bank::new();
        let arena = bank.reserve(4).expect("the arena must be granted");
        arena.copy_from_slice(&[f32::NAN, 0.5, 1e-40, 0.25]);
        assert_eq!(bank.commit(0, 0, 2, 1), Ok(()));

        assert_eq!(bank.arena()[0], 0.0, "the declared frame was not cleaned");
        assert_eq!(bank.arena()[2], 1e-40, "the sweep ran past the declaration");
    }

    #[test]
    fn two_slots_may_share_one_sample() {
        // Two tracks on one sound is a kit, not a mistake — which is what a
        // check against overlapping regions would cost. See `commit`.
        let mut bank = Bank::new();
        bank.reserve(4).expect("the arena must be granted").fill(1.0);

        assert_eq!(bank.commit(2, 0, 4, 1), Ok(()));
        assert_eq!(bank.commit(5, 0, 4, 1), Ok(()));
        assert_eq!(bank.region(2), bank.region(5));
    }

    #[test]
    fn what_does_not_fit_is_refused_by_name_and_leaves_the_slot_undeclared() {
        // Asserted as values rather than as failure, for the reason `Refusal`
        // gives: swapping two of the conditions must not pass.
        let mut bank = Bank::new();
        bank.reserve(64).expect("the arena must be granted");

        assert_eq!(bank.commit(0, 0, 65, 1), Err(Refusal::DoesNotFit { end: 65, reserved: 64 }));
        assert_eq!(bank.commit(0, 60, 8, 1), Err(Refusal::DoesNotFit { end: 68, reserved: 64 }));
        assert_eq!(bank.commit(0, 0, 33, 2), Err(Refusal::DoesNotFit { end: 66, reserved: 64 }));
        assert_eq!(bank.commit(0, 0, 0, 1), Err(Refusal::Empty));
        assert_eq!(bank.commit(0, 0, 8, 0), Err(Refusal::Channels(0)));
        assert_eq!(bank.commit(0, 0, 8, 3), Err(Refusal::Channels(3)));
        assert_eq!(bank.commit(SLOTS, 0, 8, 1), Err(Refusal::NoSuchSlot));

        assert!(!bank.holds_a_sample(0), "a refused slot was declared anyway");

        // The exact fit is accepted, in either channel count: the bound is the
        // arena's length in floats, and nothing about it prefers a shape.
        assert_eq!(bank.commit(0, 0, 64, 1), Ok(()));
        assert_eq!(bank.commit(0, 0, 32, 2), Ok(()));
    }

    #[test]
    fn an_end_that_would_overflow_is_refused_rather_than_wrapped() {
        // All three numbers come from the far side. Computed with wrapping
        // arithmetic, an offset near the top of the address space plus a
        // plausible length lands back inside the arena, and the bounds check
        // passes on exactly the input it exists to stop.
        let mut bank = Bank::new();
        bank.reserve(64).expect("the arena must be granted");

        for (offset, frames, channels) in [
            (usize::MAX, 8, 1),
            (usize::MAX - 4, 8, 2),
            (0, usize::MAX, 2),
            (32, usize::MAX / 2 + 1, 2),
        ] {
            let refusal = bank.commit(0, offset, frames, channels);
            assert!(
                matches!(refusal, Err(Refusal::DoesNotFit { .. })),
                "offset {offset} frames {frames} channels {channels} gave {refusal:?}"
            );
        }
        assert!(!bank.holds_a_sample(0));
    }

    #[test]
    fn reset_declares_nothing_and_keeps_the_memory() {
        // Both halves matter and they pull apart: a reset bank has to read as a
        // fresh one, or the golden tests compare a warmed engine against a cold
        // one — while the memory has to stay, for the reason `reset` gives.
        let mut bank = loaded(&[(0, 4_096, 1, 1.0)]);
        let granted = bank.arena.capacity();

        bank.reset();

        assert!(!bank.holds_a_sample(0), "a reset slot still held its sample");
        assert_eq!(bank.arena().len(), 0);
        assert_eq!(bank.arena.capacity(), granted, "the arena was handed back");
    }
}
