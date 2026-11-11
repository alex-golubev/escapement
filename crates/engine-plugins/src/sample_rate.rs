//! How fast the engine plays: whole frames a second, as an audio device runs.

use std::num::NonZeroU32;

/// Whole frames a second, from 1 up to 2²⁴: up to there every whole number is an exact `f32`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SampleRate(NonZeroU32);

impl SampleRate {
    /// Above this, [`Self::hz`] would round.
    pub const MAX: u32 = 1 << f32::MANTISSA_DIGITS;

    /// None for 0 and past [`Self::MAX`].
    #[must_use]
    pub const fn new(hz: u32) -> Option<Self> {
        match NonZeroU32::new(hz) {
            Some(hz) if hz.get() <= Self::MAX => Some(Self(hz)),
            _ => None,
        }
    }

    /// As the page has it, a JavaScript number: none unless whole and from 1 to [`Self::MAX`].
    #[must_use]
    pub fn from_hz(hz: f64) -> Option<Self> {
        (hz.fract() == 0.0 && (0.0..=f64::from(Self::MAX)).contains(&hz))
            .then_some(hz as u32)
            .and_then(Self::new)
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0.get()
    }

    /// For DSP's arithmetic; exact.
    #[must_use]
    pub const fn hz(self) -> f32 {
        self.0.get() as f32
    }

    /// The frames `seconds` take, the nearest whole number: none for less than half a frame, or for what isn't a
    /// number.
    #[must_use]
    pub const fn frames(self, seconds: f32) -> u32 {
        (seconds * self.hz()).round() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rate_is_whole_frames_a_second_from_1_to_where_f32_stays_exact() {
        assert_eq!(SampleRate::new(0), None);
        assert_eq!(SampleRate::new(1).map(SampleRate::get), Some(1));
        assert_eq!(SampleRate::new(48_000).map(SampleRate::hz), Some(48_000.0));
        let max = SampleRate::new(SampleRate::MAX).unwrap();
        assert_eq!(max.hz(), 16_777_216.0);
        assert_eq!(SampleRate::new(SampleRate::MAX + 1), None);
    }

    #[test]
    fn a_rate_from_the_page_is_taken_only_whole_and_in_range() {
        assert_eq!(SampleRate::from_hz(44_100.0), SampleRate::new(44_100));
        let max = f64::from(SampleRate::MAX);
        assert_eq!(SampleRate::from_hz(max), SampleRate::new(SampleRate::MAX));
        for refused in [48_000.5, 0.0, -48_000.0, max + 1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(SampleRate::from_hz(refused), None, "{refused}");
        }
    }

    #[test]
    fn seconds_take_the_nearest_whole_frames_and_none_below_0() {
        let rate = SampleRate::new(48_000).unwrap();
        assert_eq!(rate.frames(1.0), 48_000);
        assert_eq!(rate.frames(0.02), 960);
        assert_eq!(rate.frames(0.000_01), 0);
        assert_eq!(rate.frames(0.000_011), 1);
        for nothing in [-1.0, f32::NAN] {
            assert_eq!(rate.frames(nothing), 0, "{nothing}");
        }
    }
}
