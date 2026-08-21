//! Support shared by tests across the crate, compiled only for them.
//!
//! **Under `src/` despite shipping nowhere, and that is Rust rather than
//! taste.** Everything in `tests/` is built as its own crate and linked against
//! this one from outside, so a unit test — which lives beside the module it
//! covers and reaches its private items — cannot import anything from there.
//! Support that unit tests share therefore has to live in the crate itself, and
//! `#[cfg(test)]` on the declaration in `lib.rs` is what keeps it out of the
//! artifact.

/// Deterministic garbage: an xorshift64 generator seeded by whoever needs it.
///
/// Three tests feed random bytes at the decoders — the block parser, the
/// engine, and the same thing through the C ABI — and each was carrying its own
/// copy of these three shifts. Copies of a generator are worth removing for a
/// reason beyond tidiness: a period this one is known to have is a property of
/// the constants 13, 7 and 17 together, and a copy that loses a digit still
/// produces bytes that look random enough to pass.
///
/// The *seeds* stay with the tests rather than moving here, and that is the
/// other half. Three streams reach three different sets of states; one shared
/// seed would be one stream tested three times over.
pub struct Xorshift64(u64);

impl Xorshift64 {
    /// A seed of zero is refused rather than substituted. Zero is the fixed
    /// point of this generator — it maps to itself and every byte after it is
    /// zero — and a fuzz test fed nothing but zeros passes trivially, since
    /// zeroed memory is the one input every decoder here handles by design.
    pub fn new(seed: u64) -> Self {
        assert_ne!(seed, 0, "xorshift64 seeded with zero yields only zeros");
        Self(seed)
    }

    /// Not named `next`: an inherent method by that name reads as `Iterator`
    /// without being one, and clippy says so.
    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// Overwrite every byte of a buffer.
    pub fn fill(&mut self, bytes: &mut [u8]) {
        for byte in bytes.iter_mut() {
            *byte = self.next_u64() as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shift_constants_are_pinned() {
        // Literals, like every pin in this repository, and here the argument is
        // sharper than usual: 13, 7 and 17 are one of the triples that give
        // xorshift64 its full period, and the neighbouring triples do not. A
        // digit lost from any of them still produces bytes that look random —
        // enough to pass every other test in this file and every fuzz test
        // downstream, while quietly covering a fraction of the state space.
        // Changing one shift and running the suite was tried: all 154 passed.
        //
        // Nothing else can hold this. A period of 2^64 − 1 is not checkable,
        // and a statistical test would be a test that sometimes fails.
        let mut rng = Xorshift64::new(1);
        assert_eq!(
            [
                rng.next_u64(),
                rng.next_u64(),
                rng.next_u64(),
                rng.next_u64()
            ],
            [
                0x0000_0000_4082_2041,
                0x1000_4106_0C01_1441,
                0x9B1E_842F_6E86_2629,
                0xF554_F503_555D_8025,
            ],
        );
    }

    #[test]
    #[should_panic(expected = "xorshift64 seeded with zero")]
    fn a_seed_of_zero_is_refused() {
        // Refused rather than substituted, and asserted rather than assumed:
        // substituting would be a fuzz test running on a stream its caller did
        // not choose, and zero is the one seed that yields nothing but zeros —
        // which every decoder here handles by design, so the run would pass
        // without having tested anything.
        Xorshift64::new(0);
    }

    #[test]
    fn the_same_seed_gives_the_same_bytes() {
        // What the fuzz tests downstream rest on: a failure they find has to be
        // reachable again from the seed printed beside it.
        let mut first = [0u8; 256];
        let mut second = [0u8; 256];
        Xorshift64::new(0x2545_F491_4F6C_DD1D).fill(&mut first);
        Xorshift64::new(0x2545_F491_4F6C_DD1D).fill(&mut second);
        assert_eq!(first, second);
    }

    #[test]
    fn different_seeds_give_different_bytes() {
        // The reason the three fuzz tests keep their own seeds instead of
        // sharing one.
        let mut first = [0u8; 256];
        let mut second = [0u8; 256];
        Xorshift64::new(0x2545_F491_4F6C_DD1D).fill(&mut first);
        Xorshift64::new(0x9E37_79B9_7F4A_7C15).fill(&mut second);
        assert_ne!(first, second);
    }

    #[test]
    fn every_byte_of_the_buffer_is_written() {
        // `fill` overwrites rather than appends, and a loop that stopped short
        // would leave a tail of zeros — which decodes to nothing at all and
        // would quietly shrink every fuzz test to its first few records.
        let mut bytes = [0u8; 4096];
        Xorshift64::new(0xD1B5_4A32_D192_ED03).fill(&mut bytes);
        assert!(bytes.iter().any(|&b| b != 0));
        assert!(
            bytes[bytes.len() - 64..].iter().any(|&b| b != 0),
            "the tail of the buffer was left untouched"
        );
    }

    #[test]
    fn the_generator_does_not_settle() {
        // Every xorshift has one state it cannot leave, and for this one it is
        // zero. `new` refuses that seed; this is the check that no reachable
        // state walks into it, which would turn the rest of a long fuzz run
        // into zeros without failing anything.
        let mut rng = Xorshift64::new(1);
        for lap in 0..100_000 {
            assert_ne!(rng.next_u64(), 0, "the generator reached zero on lap {lap}");
        }
    }
}
