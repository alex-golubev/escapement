//! Canvas renderer for the playlist and the piano roll.
//!
//! Must not depend on the UI framework: state in, mouse events out, no framework
//! types in the public API. Both surfaces share most of their machinery — design
//! for reuse rather than copying the playlist later.
