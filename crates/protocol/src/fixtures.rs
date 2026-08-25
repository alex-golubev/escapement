//! What the ordinary tests and the `loom` models both need.
//!
//! They live under opposite `cfg`s and so cannot see each other's test modules;
//! anything both want lands here rather than in each of them once.

use crate::state::EngineState;

/// Measured from the last item that moved, not from the start, so a slow machine
/// is not mistaken for a stuck ring. A test that hangs is worse than one that
/// fails: it reports nothing and holds the job until some outer limit gives up
/// on it.
///
/// Miri interprets rather than runs, some hundreds of times slower, so it waits
/// longer before calling something stuck.
#[cfg(not(loom))]
pub(crate) const STUCK: core::time::Duration =
    core::time::Duration::from_secs(if cfg!(miri) { 60 } else { 2 });

/// A state whose fields agree with each other, so that nothing but a torn read
/// could produce one where they do not. `sample(0)` is also what an untouched
/// block reads as.
pub(crate) fn sample(n: u64) -> EngineState {
    EngineState {
        playhead: n * 128,
        quanta: n,
        peak: n as f32,
        playing: n % 2 == 1,
        commands_applied: n as u32,
        commands_unknown: 0,
    }
}
