//! Audio core: graph, nodes, mixer, DSP.
//!
//! Runs on the real-time thread: no allocation, locks, panics, I/O or logging on
//! the processing path. Allocation is allowed only while building the graph.

/// Render quantum fixed by the Web Audio spec. Internal block sizes are multiples
/// of it.
pub const RENDER_QUANTUM: usize = 128;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_quantum_is_spec_mandated() {
        assert_eq!(RENDER_QUANTUM, 128);
    }
}
