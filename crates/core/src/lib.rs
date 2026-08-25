//! Audio core: graph, nodes, mixer, DSP.
//!
//! Runs on the real-time thread: no allocation, locks, panics, I/O or logging on
//! the processing path. Allocation is allowed only while building the graph.
//!
//! `no_std` is what turns the first of those from discipline into a compiler
//! error: with no allocator in this crate's graph there is nothing here to
//! allocate with. It costs one dependency — `f32::sin` lives in `std` — and on
//! wasm that costs nothing at all, see `Cargo.toml`.

#![no_std]

// The tests want a heap and a harness. Asked for here rather than by weakening
// the attribute above, as `escapement-protocol` does.
#[cfg(test)]
extern crate std;

/// Render quantum fixed by the Web Audio spec. Internal block sizes are multiples
/// of it.
pub const RENDER_QUANTUM: usize = 128;

/// Phase is counted in **turns** rather than radians, so wrapping a period is a
/// subtraction of exactly `1.0` and never accumulates the error that wrapping
/// against 2π does over hours of playback.
pub struct Sine {
    phase: f32,
    /// Turns per sample.
    step: f32,
}

impl Sine {
    /// Build the graph with this, not the processing path — it divides.
    pub fn new(frequency_hz: f32, sample_rate_hz: f32) -> Self {
        Self {
            phase: 0.0,
            step: frequency_hz / sample_rate_hz,
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

    #[test]
    fn render_quantum_is_spec_mandated() {
        assert_eq!(RENDER_QUANTUM, 128);
    }

    #[test]
    fn sine_stays_inside_full_scale() {
        let mut sine = Sine::new(440.0, 48_000.0);
        let mut block = [0.0f32; RENDER_QUANTUM];
        for _ in 0..100 {
            sine.process(&mut block);
            for sample in block {
                assert!((-1.0..=1.0).contains(&sample), "{sample} left full scale");
            }
        }
    }

    #[test]
    fn sine_starts_at_zero_and_rises() {
        let mut sine = Sine::new(440.0, 48_000.0);
        let mut block = [0.0f32; 4];
        sine.process(&mut block);
        assert_eq!(block[0], 0.0);
        assert!(block[1] > block[0]);
    }

    #[test]
    fn sine_completes_a_period() {
        let mut sine = Sine::new(1.0, 48_000.0);
        let mut one_second = [0.0f32; 48_000];
        sine.process(&mut one_second);
        assert!(sine.phase.abs() < 1e-3, "phase drifted to {}", sine.phase);
    }

    #[test]
    fn sine_has_the_frequency_asked_for() {
        let mut sine = Sine::new(100.0, 48_000.0);
        let mut one_second = [0.0f32; 48_000];
        sine.process(&mut one_second);
        let rising_zero_crossings = one_second
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        assert_eq!(rising_zero_crossings, 100);
    }
}
