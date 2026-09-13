//! Project model: entities, musical time, CRDT document. The single source of
//! truth, read by the UI thread and — through an immutable snapshot — by the
//! audio thread.
//!
//! See ARCHITECTURE.md §2.4-2.6 for the entity shapes, the time model and why
//! neither can be changed later.

#![forbid(unsafe_code)]

#[cfg(test)]
mod fixtures;

pub mod asset;
pub mod automation;
mod bounded;
pub mod document;
mod id;
pub mod mixer;
pub mod pattern;
pub mod playback;
pub mod playlist;
pub mod project;
mod rank;
pub mod timeline;

// `Frames` is deliberately not among these and is reached as `asset::Frames`,
// the way `playlist::Lane` and `meter::Mark` are reached — the module carries
// the distinction so the type need not repeat it. Here it also removes a
// collision: `escapement_core::Frames` is a borrowed buffer of samples, this one
// is a count of frames in a source file, and they are two of the three counts
// `.claude/rules/musical-time.md` exists to keep apart. `escapement-app` links
// both crates.
pub use asset::{Asset, AssetHash};
pub use id::{Entropy, Id};
pub use project::Project;
