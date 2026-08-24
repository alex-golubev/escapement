//! Project model: entities, musical time, CRDT document. The single source of
//! truth, read by the UI thread and — through an immutable snapshot — by the
//! audio thread.
//!
//! Positions are stored in musical time, never in samples.
//!
//! See ARCHITECTURE.md §2.4-2.6 for the entity shapes and why they cannot be
//! changed later.
