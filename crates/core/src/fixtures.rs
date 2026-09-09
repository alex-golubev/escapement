//! What more than one test module in this crate needs.
//!
//! The rate and the length of a block are one fact, not two: a crossing count
//! is a frequency only if the block is exactly one second at [`RATE`]. Apart,
//! one of them moves and the other goes on agreeing.

/// Sample rate the tests measure against. A block of [`RATE_HZ`] samples is one
/// second of it, which is what makes a crossing count a frequency.
pub(crate) const RATE_HZ: usize = 48_000;

/// The same rate, as everything in this crate takes it.
pub(crate) fn rate() -> escapement_time::SampleRate {
    escapement_time::SampleRate::new(RATE_HZ as f64).expect("the tests chose a rate")
}

/// Over a block of [`RATE_HZ`] samples this is the frequency in hertz, and the
/// only way to ask an oscillator what it is doing from outside.
pub(crate) fn rising_zero_crossings(block: &[f32]) -> usize {
    block
        .windows(2)
        .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
        .count()
}
