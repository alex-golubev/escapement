//! Parameter smoothing: a straight line on the parameter's scale to each new value, instead of a click.

use crate::{ParamDescription, SampleRate, Scale};

/// Yields the value for each next sample, endlessly.
pub struct Smoothed {
    /// Whether a sample has taken a value yet.
    sounded: bool,
    current: f32,
    target: f32,
    /// In `f64`, so even a long ramp doesn't drift: rounding stays far below what an `f32` holds.
    ramp: f64,
    /// Multiplied by on each sample on a logarithmic scale, added on any other.
    step: f64,
    /// The ramp's ends: rounding can't carry a value past them.
    low: f32,
    high: f32,
    remaining: u32,
    ramp_samples: u32,
    scale: Scale,
}

/// A change of `ramp_seconds` takes this many samples; at least one.
#[must_use]
pub fn ramp_samples(ramp_seconds: f32, sample_rate: SampleRate) -> u32 {
    sample_rate.frames(ramp_seconds).max(1)
}

impl Smoothed {
    /// Evenly in the value; also for values derived from a parameter, such as filter coefficients.
    #[must_use]
    pub fn new(value: f32, ramp_seconds: f32, sample_rate: SampleRate) -> Self {
        Self::on_scale(value, ramp_seconds, sample_rate, Scale::Linear)
    }

    /// The parameter itself: from its default, at its smoothing time, on its scale, so a change sounds like a quick
    /// turn of its knob.
    #[must_use]
    pub fn for_param(param: &ParamDescription, sample_rate: SampleRate) -> Self {
        Self::on_scale(
            param.default,
            param.smoothing_seconds,
            sample_rate,
            param.scale,
        )
    }

    fn on_scale(value: f32, ramp_seconds: f32, sample_rate: SampleRate, scale: Scale) -> Self {
        Self {
            sounded: false,
            current: value,
            target: value,
            ramp: value.into(),
            step: 0.0,
            low: value,
            high: value,
            remaining: 0,
            ramp_samples: ramp_samples(ramp_seconds, sample_rate),
            scale,
        }
    }

    /// Heads for `target` from the current value. Before the first sample it jumps there:
    /// that's how a node gets its initial state.
    pub fn set(&mut self, target: f32) {
        if !self.sounded {
            self.current = target;
            self.target = target;
            self.remaining = 0;
            return;
        }
        self.target = target;
        self.low = self.current.min(target);
        self.high = self.current.max(target);
        self.remaining = self.ramp_samples;
        self.ramp = self.current.into();
        let (from, to, samples) = (self.ramp, f64::from(target), f64::from(self.ramp_samples));
        self.step = match self.scale {
            Scale::Linear | Scale::Volume | Scale::Time => (to - from) / samples,
            Scale::Logarithmic => (to / from).powf(samples.recip()),
        };
    }

    /// The value every next sample takes while no change comes, or none while it is on its way: a caller may then skip
    /// the samples. It counts as a sample taken.
    pub fn steady(&mut self) -> Option<f32> {
        self.sounded = true;
        (self.remaining == 0).then_some(self.current)
    }
}

impl Iterator for Smoothed {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        self.sounded = true;
        if self.remaining > 0 {
            self.remaining -= 1;
            self.current = if self.remaining == 0 {
                self.target
            } else {
                self.ramp = match self.scale {
                    Scale::Linear | Scale::Volume | Scale::Time => self.ramp + self.step,
                    Scale::Logarithmic => self.ramp * self.step,
                };
                (self.ramp as f32).clamp(self.low, self.high)
            };
        }
        Some(self.current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{SAMPLE_RATE, rate};
    use crate::{Unit, Values};

    fn take(smoothed: &mut Smoothed, samples: usize) -> Vec<f32> {
        smoothed.take(samples).collect()
    }

    /// Already sounding, so changes are smoothed.
    fn sounding(value: f32) -> Smoothed {
        let mut smoothed = Smoothed::new(value, 0.02, SAMPLE_RATE);
        smoothed.next();
        smoothed
    }

    #[test]
    fn takes_a_value_set_before_the_first_sample_at_once() {
        let mut volume = Smoothed::new(0.5, 0.02, SAMPLE_RATE);
        volume.set(0.0);
        assert_eq!(take(&mut volume, 3), [0.0; 3]);
    }

    #[test]
    fn is_steady_until_a_change_and_again_once_the_change_is_over() {
        let mut volume = Smoothed::new(0.5, 0.02, SAMPLE_RATE);
        assert_eq!(volume.steady(), Some(0.5));
        // Asked, it has sounded: a change glides.
        volume.set(1.0);
        assert_eq!(volume.steady(), None);
        assert!(volume.next().unwrap() < 0.51);
        take(&mut volume, 959);
        assert_eq!(volume.steady(), Some(1.0));
    }

    #[test]
    fn ramp_length_is_a_time() {
        assert_eq!(Smoothed::new(0.0, 0.02, rate(48_000)).ramp_samples, 960);
        assert_eq!(Smoothed::new(0.0, 0.02, rate(44_100)).ramp_samples, 882);
        assert_eq!(Smoothed::new(0.0, 0.0, rate(48_000)).ramp_samples, 1);
    }

    #[test]
    fn a_parameter_starts_at_its_default_and_ramps_for_its_smoothing_time() {
        let param = ParamDescription {
            id: "volume",
            label: "Volume",
            group: None,
            unit: None,
            scale: Scale::Linear,
            values: Values::Any,
            min: 0.0,
            max: 1.0,
            default: 0.5,
            smoothing_seconds: 0.02,
        };
        let mut volume = Smoothed::for_param(&param, SAMPLE_RATE);
        assert_eq!(volume.ramp_samples, 960);
        assert_eq!(take(&mut volume, 3), [0.5; 3]);
    }

    #[test]
    fn reaches_the_target_exactly_at_the_end_of_the_ramp() {
        let mut volume = sounding(0.0);
        volume.set(1.0);
        let values = take(&mut volume, 960);
        assert!(values[..959].iter().all(|&v| v < 1.0));
        assert_eq!(values[959], 1.0);
        assert_eq!(take(&mut volume, 10), [1.0; 10]);
    }

    #[test]
    fn moves_in_equal_steps() {
        let mut volume = sounding(0.2);
        volume.set(0.8);
        let values = take(&mut volume, 960);
        let step = 0.6 / 960.0;
        assert!((values[0] - 0.2 - step).abs() < 1e-6);
        assert!(
            values
                .windows(2)
                .all(|pair| (pair[1] - pair[0] - step).abs() < 1e-6)
        );
    }

    #[test]
    fn a_volume_moves_evenly_in_the_value_from_silence_and_back() {
        let param = ParamDescription {
            id: "volume",
            label: "Volume",
            group: None,
            unit: Some(Unit::Gain),
            scale: Scale::Volume,
            values: Values::Any,
            min: 0.0,
            max: 1.0,
            default: 0.0,
            smoothing_seconds: 0.02,
        };
        let mut volume = Smoothed::for_param(&param, SAMPLE_RATE);
        volume.next();
        volume.set(0.6);
        let up = take(&mut volume, 960);
        assert!((up[479] - 0.3).abs() < 1e-6, "{}", up[479]);
        assert_eq!(up[959], 0.6);
        volume.set(0.0);
        let down = take(&mut volume, 960);
        assert!((down[479] - 0.3).abs() < 1e-6, "{}", down[479]);
        assert_eq!(down[959], 0.0);
    }

    /// Already sounding at its default.
    fn cutoff(smoothing_seconds: f32) -> Smoothed {
        let param = ParamDescription {
            id: "cutoff",
            label: "Cutoff",
            group: None,
            unit: Some(Unit::Hertz),
            scale: Scale::Logarithmic,
            values: Values::Any,
            min: 20.0,
            max: 20_000.0,
            default: 20_000.0,
            smoothing_seconds,
        };
        let mut cutoff = Smoothed::for_param(&param, SAMPLE_RATE);
        cutoff.next();
        cutoff
    }

    #[test]
    fn a_logarithmic_parameter_moves_evenly_in_octaves_and_ends_on_its_target() {
        let mut cutoff = cutoff(0.02);
        cutoff.set(100.0);
        let values = take(&mut cutoff, 960);
        // Halfway in octaves, where 10 kHz would be halfway in hertz.
        let halfway = (20_000.0f32 * 100.0).sqrt();
        assert!(
            (values[479] / halfway - 1.0).abs() < 1e-4,
            "{}",
            values[479]
        );
        let ratio = (100.0f32 / 20_000.0).powf(1.0 / 960.0);
        let even = values[..959]
            .windows(2)
            .all(|pair| (pair[1] / pair[0] / ratio - 1.0).abs() < 1e-5);
        assert!(even);
        assert_eq!(values[959], 100.0);
        assert_eq!(take(&mut cutoff, 10), [100.0; 10]);
    }

    #[test]
    fn a_long_ramp_stays_between_its_ends_and_keeps_moving() {
        let mut long = cutoff(10.0);
        long.set(20.0);
        let values = take(&mut long, 480_000);
        assert!(values.iter().all(|value| (20.0..=20_000.0).contains(value)));
        assert!(values.windows(2).all(|pair| pair[1] <= pair[0]));
        assert_eq!(values[479_999], 20.0);
        // The last step is as small as the rest, not a jump onto the target.
        let ratio = (20.0f32 / 20_000.0).powf(1.0 / 480_000.0);
        assert!((values[479_998] * ratio / 20.0 - 1.0).abs() < 1e-5);
    }

    #[test]
    fn a_change_too_small_for_one_multiplication_still_moves_a_float_step_at_a_time() {
        let mut tiny = cutoff(0.02);
        // 16 steps of an `f32` apart: per sample, the ratio is too close to 1 for an `f32` to hold.
        let target = f32::from_bits(20_000.0f32.to_bits() + 16);
        tiny.set(target);
        let values = take(&mut tiny, 960);
        let float_steps = values
            .windows(2)
            .map(|pair| pair[1].to_bits() - pair[0].to_bits());
        assert!(float_steps.into_iter().all(|steps| steps <= 1));
        assert_eq!(values[959], target);
    }

    #[test]
    fn a_new_target_starts_from_the_current_value() {
        let mut volume = sounding(0.0);
        volume.set(1.0);
        let halfway = *take(&mut volume, 480).last().unwrap();
        volume.set(0.0);
        let values = take(&mut volume, 960);
        assert!((values[0] - (halfway - halfway / 960.0)).abs() < 1e-6);
        assert_eq!(values[959], 0.0);
    }
}
