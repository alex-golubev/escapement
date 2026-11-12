//! A plugin's memory fades through denormal numbers in silence, and on x86 they take tens of times longer to compute
//! with. WebAssembly can't make the processor flush them to zero, so plugins do it themselves.

/// Far below hearing (−300 dB) and far above the denormals (below ~1.2e-38).
pub const THRESHOLD: f32 = 1e-15;

/// For each value a plugin keeps from one sample to the next.
#[inline]
#[must_use]
pub fn flush(value: f32) -> f32 {
    if value.abs() < THRESHOLD { 0.0 } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_only_what_is_far_below_hearing() {
        for silent in [1e-20, -1e-20, f32::MIN_POSITIVE / 2.0] {
            assert_eq!(flush(silent), 0.0, "{silent}");
        }
        for kept in [THRESHOLD, -THRESHOLD, 1e-6, -0.5, 0.0] {
            assert_eq!(flush(kept), kept);
        }
    }
}
