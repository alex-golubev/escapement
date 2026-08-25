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

/// A state stamped with its generation in every word it takes on the wire.
///
/// The torn-read tests rebuild a whole state from one field and compare, so a
/// word carrying the same bits in every generation could not betray a tear that
/// landed on it. `commands_applied` is the field they rebuild from, and `n` is
/// its width rather than the wider one of the fields below it: narrowing on the
/// way in would hand back a different generation without saying so.
///
/// `sample(0)` is what an untouched block reads as.
pub(crate) fn sample(n: u32) -> EngineState {
    let wide = u64::from(n);
    EngineState {
        // A clock counting quanta at 128 samples never reaches the high word
        // inside a test, so the generation goes there directly.
        clock: wide * 128 + (wide << 32),
        quanta: wide + (wide << 32),
        peak: n as f32,
        playing: n % 2 == 1,
        commands_applied: n,
        // A different multiple, so the last two words never agree either.
        commands_unknown: n.wrapping_mul(3),
    }
}
