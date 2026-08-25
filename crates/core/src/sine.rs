/// A sine oscillator.
///
/// Phase is counted in **turns** rather than radians, so wrapping a period is a
/// subtraction of exactly `1.0` and never accumulates the error that wrapping
/// against 2π does over hours of playback.
pub struct Sine {
    phase: f32,
    /// Turns per sample.
    step: f32,
    /// Kept because the frequency can change while playing, and rebuilding the
    /// oscillator to change it would reset the phase — which is a click.
    sample_rate_hz: f32,
}

impl Sine {
    /// Build the graph with this, not the processing path — it divides.
    #[must_use]
    pub fn new(frequency_hz: f32, sample_rate_hz: f32) -> Self {
        let mut sine = Self {
            phase: 0.0,
            step: 0.0,
            sample_rate_hz,
        };
        sine.set_frequency(frequency_hz);
        sine
    }

    /// Ignores a frequency this oscillator cannot produce: the last good value
    /// stands. The value crossed a boundary from a module that may be a
    /// different build, and there is nothing on the audio thread to report an
    /// error to.
    ///
    /// Each clause earns its place. `NaN` would poison the phase permanently,
    /// and no later command could undo it. At exactly Nyquist the samples land
    /// on 0, π, 2π and the tone is silence, so clamping to it would answer "too
    /// high" with something indistinguishable from a broken engine.
    ///
    /// Divides, so not for the per-sample loop.
    pub fn set_frequency(&mut self, hz: f32) {
        if hz.is_finite() && hz > 0.0 && hz < self.sample_rate_hz / 2.0 {
            self.step = hz / self.sample_rate_hz;
        }
    }

    /// Overwrites every element of `out`; previous contents are not read.
    pub fn process(&mut self, out: &mut [f32]) {
        for sample in out.iter_mut() {
            *sample = libm::sinf(self.phase * core::f32::consts::TAU);
            self.phase += self.step;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{rising_zero_crossings, RATE, RATE_HZ};
    use crate::RENDER_QUANTUM;

    #[test]
    fn stays_inside_full_scale() {
        let mut sine = Sine::new(440.0, RATE);
        let mut block = [0.0f32; RENDER_QUANTUM];
        for _ in 0..100 {
            sine.process(&mut block);
            for sample in block {
                assert!((-1.0..=1.0).contains(&sample), "{sample} left full scale");
            }
        }
    }

    #[test]
    fn starts_at_zero_and_rises() {
        let mut sine = Sine::new(440.0, RATE);
        let mut block = [0.0f32; 4];
        sine.process(&mut block);
        assert_eq!(block[0], 0.0);
        assert!(block[1] > block[0]);
    }

    #[test]
    fn completes_a_period() {
        let mut sine = Sine::new(1.0, RATE);
        let mut one_second = [0.0f32; RATE_HZ];
        sine.process(&mut one_second);
        assert!(sine.phase.abs() < 1e-3, "phase drifted to {}", sine.phase);
    }

    #[test]
    fn has_the_frequency_asked_for() {
        let mut sine = Sine::new(100.0, RATE);
        let mut one_second = [0.0f32; RATE_HZ];
        sine.process(&mut one_second);
        assert_eq!(rising_zero_crossings(&one_second), 100);
    }

    #[test]
    fn a_new_frequency_takes_effect_without_resetting_the_phase() {
        let mut sine = Sine::new(100.0, RATE);
        let mut block = [0.0f32; 100];
        sine.process(&mut block);
        let phase = sine.phase;

        sine.set_frequency(200.0);
        assert_eq!(sine.phase, phase, "changing the frequency moved the phase");

        let mut one_second = [0.0f32; RATE_HZ];
        sine.process(&mut one_second);
        assert_eq!(rising_zero_crossings(&one_second), 200);
    }

    /// The value crossed a boundary, so every one of these is reachable from
    /// outside. `NaN` is the one that cannot be recovered from once accepted.
    #[test]
    fn a_frequency_that_is_not_one_leaves_the_last_good_one_standing() {
        for bad in [f32::NAN, 0.0, -440.0, f32::INFINITY] {
            let mut sine = Sine::new(100.0, RATE);
            sine.set_frequency(bad);

            let mut one_second = [0.0f32; RATE_HZ];
            sine.process(&mut one_second);
            assert_eq!(
                rising_zero_crossings(&one_second),
                100,
                "{bad} was believed"
            );
        }
    }

    /// At Nyquist the samples land on 0, π, 2π and the tone is silence; above
    /// it there is no such sine at all. Both are refused, so what stays audible
    /// is the frequency that was working.
    #[test]
    fn a_frequency_at_or_above_nyquist_is_refused_rather_than_produced() {
        for unreachable in [RATE / 2.0, RATE] {
            let mut sine = Sine::new(100.0, RATE);
            sine.set_frequency(unreachable);

            let mut one_second = [0.0f32; RATE_HZ];
            sine.process(&mut one_second);
            assert_eq!(
                rising_zero_crossings(&one_second),
                100,
                "{unreachable} was believed"
            );
        }
    }
}
