//! One guard, for the values that have two ends.

use core::ops::RangeInclusive;

/// `value`, if it lies between the two ends.
///
/// **The range comparison is the whole of the check.** It answers false for a
/// `NaN` and for either infinity without being asked, so an `is_finite` in
/// front of it is a second guard for the cases this one already refuses.
///
/// A gain is not here, and that is the reason: it has no upper end, so the
/// comparison it needs is against one bound, where an infinity does pass and
/// has to be turned away on its own.
#[must_use]
pub(crate) fn within(value: f32, ends: RangeInclusive<f32>) -> Option<f32> {
    ends.contains(&value).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_between_the_ends_comes_back_and_the_ends_are_inside() {
        assert_eq!(within(0.5, 0.0..=1.0), Some(0.5));
        assert_eq!(within(0.0, 0.0..=1.0), Some(0.0));
        assert_eq!(within(1.0, 0.0..=1.0), Some(1.0));
        assert_eq!(within(-1.0, -1.0..=1.0), Some(-1.0));
    }

    #[test]
    fn a_value_outside_them_does_not() {
        assert_eq!(within(1.5, 0.0..=1.0), None);
        assert_eq!(within(-0.5, 0.0..=1.0), None);
    }

    /// The claim the docs above make, and the reason there is no `is_finite`
    /// beside any of the three callers.
    #[test]
    fn what_is_not_a_number_is_not_between_anything() {
        assert_eq!(within(f32::NAN, 0.0..=1.0), None, "not a number");
        assert_eq!(within(f32::INFINITY, 0.0..=1.0), None, "infinite");
        assert_eq!(within(f32::NEG_INFINITY, 0.0..=1.0), None, "infinite");
    }
}
