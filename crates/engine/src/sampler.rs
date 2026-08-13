//! The sampler: loaded sounds, and the voices that play them.
//!
//! Two halves, in two files, because they are two different things with two
//! different ways of being wrong. [`bank`] owns memory and validates what
//! crosses the ABI into it; its failures are refusals and growth. [`voices`]
//! owns lifecycle and arithmetic per frame; its failures are counted in
//! non-zero frames and heard as clicks. A test that catches one catches nothing
//! of the other, which is the argument for the seam being here and not
//! elsewhere.
//!
//! [`Sampler`] is what the engine holds, and it is thin on purpose: the only
//! behaviour that belongs to it rather than to either half is the ordering
//! between them, and there is exactly one such ordering — a new kit has to
//! silence the voices before the memory they read is replaced.
//!
//! Everything crossing into this module is untrusted in the usual way: the
//! velocity of a strike arrives over the command protocol, the offset, length
//! and channel count of a sample arrive from the far side of the ABI.

mod bank;
mod voices;

pub use bank::{Refusal, SLOTS};
pub use voices::VOICES;

use crate::TRACKS;
use bank::Bank;
use voices::Pool;

pub struct Sampler {
    bank: Bank,
    pool: Pool,
}

impl Sampler {
    pub fn new(sample_rate: f64) -> Self {
        Self { bank: Bank::new(), pool: Pool::new(sample_rate) }
    }

    /// Make room for a whole kit, and hand back the arena to write it into.
    ///
    /// The one thing this module does that neither half can: **the voices are
    /// silenced before the memory is asked for.** Both orders compile and the
    /// wrong one is silent — a voice left alive across a reservation reads
    /// through an offset into an arena that has been replaced under it, which
    /// is a sound rather than a crash, and a plausible one. Silencing first
    /// also means a refusal leaves nothing sounding and nothing declared,
    /// rather than a pool still playing a kit the bank no longer has.
    ///
    /// See [`Bank::reserve`] for why the size comes from outside and why the
    /// refusal exists at all.
    pub fn reserve(&mut self, floats: usize) -> Result<&mut [f32], Refusal> {
        self.pool.silence();
        self.bank.reserve(floats)
    }

    pub fn commit(
        &mut self,
        slot: usize,
        offset: usize,
        frames: usize,
        channels: u8,
    ) -> Result<(), Refusal> {
        self.bank.commit(slot, offset, frames, channels)
    }

    pub fn trigger(&mut self, slot: usize, velocity: f32) {
        self.pool.trigger(&self.bank, slot, velocity);
    }

    pub fn release_all(&mut self) {
        self.pool.release_all();
    }

    pub fn next_frame(&mut self, out: &mut [[f32; 2]; TRACKS]) {
        self.pool.next_frame(&self.bank, out);
    }

    /// Return to the as-constructed state: no samples, no voices.
    ///
    /// Both halves together, so that a reset engine renders exactly as a fresh
    /// one — which is what the offline render on M3 compares against.
    pub fn reset(&mut self) {
        self.bank.reset();
        self.pool.silence();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    fn sounding_sampler(frames: usize) -> Sampler {
        let mut sampler = Sampler::new(SR);
        sampler.reserve(frames).expect("the arena must be granted").fill(1.0);
        assert_eq!(sampler.commit(0, 0, frames, 1), Ok(()));
        sampler.trigger(0, 1.0);
        sampler
    }

    /// Render one frame and sum its left channel across tracks.
    ///
    /// Left alone is enough for everything here: these tests ask whether a
    /// voice is sounding at all, and nothing in this type can make one channel
    /// sound without the other.
    fn summed_left(sampler: &mut Sampler) -> f32 {
        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        out.iter().map(|track| track[0]).sum()
    }

    #[test]
    fn a_new_kit_silences_the_voices_before_it_takes_the_memory() {
        // The single ordering this type owns. Reversed, the voices would go on
        // reading offsets into an arena that has been replaced beneath them —
        // audible, plausible, and impossible to attribute to the reservation
        // that caused it.
        let mut sampler = sounding_sampler(1_000);
        assert_eq!(summed_left(&mut sampler), 1.0, "the fixture did not leave a voice sounding");

        sampler.reserve(4).expect("the arena must be granted").fill(1.0);

        assert_eq!(summed_left(&mut sampler), 0.0, "a voice survived the new kit");
    }

    #[test]
    fn a_refused_reservation_leaves_neither_a_voice_nor_a_sample() {
        // Failing to get memory must not leave a voice playing a kit that is
        // no longer declared.
        let mut sampler = sounding_sampler(1_000);
        let absurd = usize::MAX / 8;
        assert_eq!(sampler.reserve(absurd), Err(Refusal::OutOfMemory { floats: absurd }));

        assert_eq!(summed_left(&mut sampler), 0.0, "a voice survived a refused reservation");
        sampler.trigger(0, 1.0);
        assert_eq!(summed_left(&mut sampler), 0.0, "a slot survived a refused reservation");
    }

    #[test]
    fn reset_returns_to_the_as_constructed_state() {
        // The golden tests on M3 compare an engine that has been running
        // against one just built; anything this call leaves behind is a
        // difference between them.
        let mut sampler = sounding_sampler(4_096);
        assert_eq!(summed_left(&mut sampler), 1.0);

        sampler.reset();

        assert_eq!(summed_left(&mut sampler), 0.0, "a voice survived the reset");
        sampler.trigger(0, 1.0);
        assert_eq!(summed_left(&mut sampler), 0.0, "a reset slot still held its sample");
    }
}
