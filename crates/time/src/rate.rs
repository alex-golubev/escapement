//! The sample rate, and the two conversions that need one.
//!
//! Here rather than in `escapement-core` because both ends convert: the model
//! turns a position into a moment to schedule, and the engine turns its clock
//! back into a position every quantum (ARCHITECTURE.md §2.5). Here rather than
//! in [`tempo`](crate::tempo) because that map answers in seconds — seconds are
//! physical, and the offline render for export drives the same engine at a rate
//! of its own choosing, so a map that knew the rate could not serve both.

/// How many samples stand in a second, and the rounding that follows.
///
/// The one place a rate multiplies anything (§2.5). Built rather than passed
/// around as a bare number, so that a rate which is not one is turned away here
/// instead of reaching arithmetic with no way to report it.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct SampleRate(f64);

impl SampleRate {
    /// `None` for anything that is not a rate: zero, negative, infinite, or not
    /// a number.
    ///
    /// Refused here because nowhere downstream can refuse it. A rate that is
    /// `NaN` reaches the oscillator's Nyquist check as a comparison false
    /// whatever it is given, so every frequency is quietly ignored and the tone
    /// holds a step no later command can change.
    #[must_use]
    pub const fn new(hz: f64) -> Option<Self> {
        if hz.is_finite() && hz > 0.0 {
            Some(Self(hz))
        } else {
            None
        }
    }

    /// Samples in a second.
    #[must_use]
    pub const fn hz(self) -> f64 {
        self.0
    }

    /// The sample `seconds` falls in, counting from wherever `seconds` counts
    /// from.
    ///
    /// Sample *n* covers `[n/rate, (n+1)/rate)`, so this is `floor` and not a
    /// choice among roundings (§2.5). A cast on its own truncates toward zero,
    /// which puts one sample of double width across the origin — and the origin
    /// is exactly where a count-in lives.
    ///
    /// Saturating at the ends, and a moment that is not a number answers with
    /// the origin: the cast does both, and there is no error channel on the
    /// audio thread to do better with.
    #[must_use]
    pub fn sample_at(self, seconds: f64) -> i64 {
        libm::floor(seconds * self.0) as i64
    }

    /// Where a sample begins, in seconds.
    ///
    /// The start of the interval above rather than its middle, which is what
    /// makes [`SampleRate::sample_at`] give the sample back.
    #[must_use]
    pub fn seconds_at(self, sample: i64) -> f64 {
        sample as f64 / self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HZ: f64 = 48_000.0;

    fn rate() -> SampleRate {
        SampleRate::new(HZ).expect("48 kHz is a rate")
    }

    #[test]
    fn a_rate_is_what_it_was_built_from() {
        assert_eq!(rate().hz(), HZ);
    }

    /// Each one separately: a single guard covering three of the four would
    /// pass a test that only tried the fourth.
    #[test]
    fn what_is_not_a_rate_is_refused() {
        assert_eq!(SampleRate::new(f64::NAN), None, "not a number");
        assert_eq!(SampleRate::new(f64::INFINITY), None, "infinite");
        assert_eq!(SampleRate::new(f64::NEG_INFINITY), None, "infinite");
        assert_eq!(SampleRate::new(0.0), None, "zero");
        assert_eq!(SampleRate::new(-HZ), None, "negative");
    }

    /// The smallest rate that is one is still one. Nothing here divides by it in
    /// a way that cares, and refusing it would be a limit invented here.
    #[test]
    fn a_rate_barely_above_zero_is_still_a_rate() {
        assert!(SampleRate::new(f64::MIN_POSITIVE).is_some());
    }

    #[test]
    fn a_moment_inside_a_sample_belongs_to_that_sample() {
        let rate = rate();
        let one = 1.0 / HZ;

        assert_eq!(rate.sample_at(0.0), 0, "the boundary belongs to the sample");
        assert_eq!(rate.sample_at(one * 0.5), 0);
        assert_eq!(rate.sample_at(one * 0.999), 0);
        assert_eq!(
            rate.sample_at(one),
            1,
            "the next boundary is the next sample"
        );
    }

    /// The test a cast fails. Truncation answers `0` for both halves of the
    /// sample before the origin, and a count-in is made of them.
    #[test]
    fn a_moment_before_the_origin_falls_in_the_sample_before_it() {
        let rate = rate();
        let one = 1.0 / HZ;

        assert_eq!(rate.sample_at(-one * 0.5), -1, "truncated toward zero");
        assert_eq!(rate.sample_at(-one * 0.001), -1, "truncated toward zero");
        assert_eq!(rate.sample_at(-one), -1);
        assert_eq!(rate.sample_at(-one * 1.5), -2);
    }

    /// Every sample the same width, which is what the test above is really
    /// about: without it the one at the origin is twice the others.
    #[test]
    fn samples_are_the_same_width_either_side_of_the_origin() {
        let rate = rate();
        let one = 1.0 / HZ;

        for n in -4..4 {
            let inside = one * (f64::from(n) + 0.5);
            assert_eq!(rate.sample_at(inside), i64::from(n), "sample {n}");
        }
    }

    #[test]
    fn a_sample_starts_where_the_moment_that_falls_in_it_begins() {
        let rate = rate();

        for n in [-9_999, -1, 0, 1, 48_000, 1_000_000] {
            assert_eq!(rate.sample_at(rate.seconds_at(n)), n, "sample {n}");
        }
    }

    #[test]
    fn a_later_moment_is_never_an_earlier_sample() {
        let rate = rate();
        let step = 1.0 / HZ / 3.0;

        let mut last = i64::MIN;
        for tick in -20..20 {
            let now = rate.sample_at(f64::from(tick) * step);
            assert!(now >= last, "went backwards at {tick}");
            last = now;
        }
    }

    /// Neither may panic: this is arithmetic the audio thread runs.
    #[test]
    fn a_moment_past_the_end_of_time_saturates_rather_than_wrapping() {
        let rate = rate();

        assert_eq!(rate.sample_at(f64::MAX), i64::MAX);
        assert_eq!(rate.sample_at(-f64::MAX), i64::MIN);
    }

    /// No sample holds it, and the origin is what the cast gives — the same
    /// answer `tempo::position_at` settles on, for the same reason.
    #[test]
    fn a_moment_that_is_not_a_number_answers_with_the_origin() {
        assert_eq!(rate().sample_at(f64::NAN), 0);
    }

    /// A rate that is not the usual one is not a special case, and a fractional
    /// one is what a resampled render hands over.
    #[test]
    fn the_rate_is_the_one_it_was_given() {
        let rate = SampleRate::new(44_100.0).expect("a rate");
        assert_eq!(rate.sample_at(1.0), 44_100);
        assert_eq!(rate.sample_at(0.5), 22_050);

        let odd = SampleRate::new(1_000.5).expect("a rate");
        assert_eq!(odd.sample_at(2.0), 2_001);
    }
}
