//! What more than one test module in this crate needs.

/// Sample rate the tests measure against.
///
/// A number rather than a [`SampleRate`](escapement_time::SampleRate), because
/// half of it is what says the conversion takes its rate from the engine it was
/// built with rather than from anywhere else.
pub(crate) const RATE_HZ: f64 = 48_000.0;

/// The same rate, as everything in this crate takes it.
pub(crate) fn rate() -> escapement_time::SampleRate {
    escapement_time::SampleRate::new(RATE_HZ).expect("the tests chose a rate")
}
