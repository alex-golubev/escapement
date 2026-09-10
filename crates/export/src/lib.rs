//! Rendering outside real time, and the file it goes into.
//!
//! The same [`Engine`](escapement_core::Engine) the worklet drives, in blocks
//! of this side's choosing (ARCHITECTURE.md §7). Nothing here is a second
//! engine, and the test that says so lives in `escapement-worklet`, next to the
//! online path it compares against.
//!
//! Allocating and `std`, unlike everything it drives.

mod render;
pub mod wav;

pub use render::{render, render_to_wav, ExportError, Settings};
