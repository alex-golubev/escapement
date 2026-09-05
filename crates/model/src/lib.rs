//! Project model: entities, musical time, CRDT document. The single source of
//! truth, read by the UI thread and — through an immutable snapshot — by the
//! audio thread.
//!
//! See ARCHITECTURE.md §2.4-2.6 for the entity shapes, the time model and why
//! neither can be changed later.

#![forbid(unsafe_code)]

#[cfg(test)]
mod fixtures;

mod asset;
mod id;
pub mod mixer;
pub mod pattern;

pub use asset::{Asset, AssetHash};
pub use id::{Entropy, Id};
