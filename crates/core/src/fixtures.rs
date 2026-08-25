//! What more than one test module in this crate needs.
//!
//! `sine` and `engine` ask the same question of a block of samples — how many
//! times did it rise through zero — and the answer is a frequency only if the
//! block is exactly one second at [`RATE`]. The two travel together for that
//! reason: apart, one of them moves and the other goes on agreeing.

/// Sample rate the tests measure against. A block of [`RATE_HZ`] samples is one
/// second of it, which is what makes a crossing count a frequency.
pub(crate) const RATE_HZ: usize = 48_000;

/// The same rate, as the oscillator takes it.
pub(crate) const RATE: f32 = RATE_HZ as f32;

/// Over a block of [`RATE_HZ`] samples this is the frequency in hertz — and the
/// only way to ask an oscillator what it is doing from outside, its phase being
/// its own business.
pub(crate) fn rising_zero_crossings(block: &[f32]) -> usize {
    block
        .windows(2)
        .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
        .count()
}
