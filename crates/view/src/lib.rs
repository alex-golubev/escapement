//! Access to the shared region for the side that does not own the memory.
//!
//! `Atomics` over a typed-array view of the worklet's `memory.buffer`, which is
//! the only way into another module's linear memory from here
//! (ARCHITECTURE.md §3). Everything above the access — the header, the ring,
//! the state block — is [`escapement_protocol`], written once and used by both
//! ends; this crate is the half of it that speaks JavaScript.
//!
//! Five methods and nothing else overridden: everything `Atomics` does is
//! sequentially consistent, so [`Cells`]'s barriers have nothing left to order,
//! and a bulk read spelled out of them would be one more line that only a
//! browser can check.

use core::fmt;

use js_sys::{Atomics, Reflect, Uint32Array};
use wasm_bindgen::{JsValue, UnwrapThrowExt};

use escapement_protocol::Cells;

/// Bytes per word. The region is addressed in words on both sides (§3); this is
/// the one place that has to know what a word costs, because the view is built
/// from a byte offset.
const BYTES: usize = 4;

/// The region seen from outside, as a view onto someone else's memory.
#[derive(Clone, Debug)]
pub struct View {
    cells: Uint32Array,
    words: usize,
}

impl View {
    /// Builds a view of everything from `byte_offset` to the end of `buffer`.
    ///
    /// `buffer` is the worklet's `memory.buffer` and `byte_offset` what
    /// `escapement_region_ptr` returned — the two halves of the handshake
    /// message. How far the view reaches is not taken on trust from either: it
    /// is what the buffer turns out to hold, which is what
    /// [`read_header`](escapement_protocol::Layout::read_header) then checks
    /// the header against (§3).
    ///
    /// # Errors
    ///
    /// [`ViewError`], for anything that would otherwise make the typed-array
    /// constructor throw. A throw here does not come back as an error — it
    /// leaves through the JavaScript that called us, and this module with it.
    pub fn new(buffer: &JsValue, byte_offset: usize) -> Result<Self, ViewError> {
        let byte_length = byte_length(buffer).ok_or(ViewError::NotABuffer)?;
        let words = reach(byte_offset, byte_length)?;

        Ok(Self {
            // Lossless: `reach` accepted the offset, so it is inside a buffer
            // whose own length was a `u32`.
            cells: Uint32Array::new_with_byte_offset(buffer, byte_offset as u32),
            words,
        })
    }

    fn at(&self, word: usize) -> u32 {
        // As in `Pointers`: offsets reach here from a `Layout` the handshake
        // has already checked against `words`, so this cannot fire. It is here
        // to name a layout mistake in a debug build rather than let `Atomics`
        // throw in a release one.
        debug_assert!(word < self.words, "word {word} outside the region");

        // Lossless in both directions: the words are `u32` and `Atomics` speak
        // `i32`, so the bits survive and only their reading changes. Р3 keeps
        // every calculation on this side of the boundary for exactly this
        // reason — nothing in JavaScript ever does arithmetic on them.
        Atomics::load(&self.cells, word as u32).unwrap_throw() as u32
    }

    fn put(&self, word: usize, value: u32) {
        debug_assert!(word < self.words, "word {word} outside the region");

        Atomics::store(&self.cells, word as u32, value as i32).unwrap_throw();
    }
}

/// Everything about a view that can be decided without JavaScript.
///
/// Separated so that it can be tested on the host: the arithmetic is where a
/// mistake hides, and what is left around it is five calls that a browser has
/// to answer for anyway.
fn reach(byte_offset: usize, byte_length: usize) -> Result<usize, ViewError> {
    if byte_offset % BYTES != 0 {
        return Err(ViewError::Misaligned { byte_offset });
    }
    if byte_offset > byte_length {
        return Err(ViewError::Outside {
            byte_offset,
            byte_length,
        });
    }

    Ok((byte_length - byte_offset) / BYTES)
}

/// Asked of the value rather than of a type it was cast to: `memory.buffer` is
/// a `SharedArrayBuffer`, an ordinary `ArrayBuffer` answers the same question,
/// and their getters are not interchangeable.
fn byte_length(buffer: &JsValue) -> Option<usize> {
    let length = Reflect::get(buffer, &JsValue::from_str("byteLength")).ok()?;

    // `as` on an `f64` saturates rather than wrapping, and a `byteLength` is a
    // non-negative integer well inside the range either way.
    Some(length.as_f64()? as usize)
}

/// Why a view could not be built. Everything here would otherwise be a throw
/// out of the typed-array constructor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewError {
    /// The handshake handed over something that is not a buffer at all.
    NotABuffer,
    /// A view of 32-bit words has to start on a four-byte boundary.
    Misaligned {
        /// Where the region was said to start.
        byte_offset: usize,
    },
    /// The region starts past the end of the memory it was said to be in.
    Outside {
        /// Where the region was said to start.
        byte_offset: usize,
        /// How large the buffer turned out to be.
        byte_length: usize,
    },
}

impl fmt::Display for ViewError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotABuffer => f.write_str("the handshake did not carry a buffer"),
            Self::Misaligned { byte_offset } => {
                write!(f, "a region at byte {byte_offset} is not word-aligned")
            }
            Self::Outside {
                byte_offset,
                byte_length,
            } => write!(
                f,
                "a region at byte {byte_offset} in a buffer of {byte_length} bytes"
            ),
        }
    }
}

impl core::error::Error for ViewError {}

impl Cells for View {
    fn words(&self) -> usize {
        self.words
    }

    fn load_relaxed(&self, word: usize) -> u32 {
        self.at(word)
    }

    fn load_acquire(&self, word: usize) -> u32 {
        self.at(word)
    }

    fn store_relaxed(&self, word: usize, value: u32) {
        self.put(word, value);
    }

    fn store_release(&self, word: usize, value: u32) {
        self.put(word, value);
    }
}

// One attribute, unlike the test modules in `escapement-protocol`: the second
// one there keeps them out of the `loom` build, and `loom` never reaches this
// crate — it runs against the protocol, which does not depend on this.
#[cfg(test)]
mod tests {
    use super::*;

    /// A region at the very start and one that ends exactly at the end of the
    /// buffer are both legitimate, and both are off-by-one bait.
    #[test]
    fn a_view_reaches_what_is_left_of_the_buffer() {
        assert_eq!(reach(0, 64), Ok(16));
        assert_eq!(reach(32, 64), Ok(8));
        assert_eq!(reach(64, 64), Ok(0), "a region starting at the last byte");
    }

    /// A buffer whose length is not a whole number of words: the words that
    /// fit are reachable and the remainder is not part of the region.
    #[test]
    fn a_partial_word_at_the_end_is_not_counted() {
        assert_eq!(reach(0, 66), Ok(16));
    }

    #[test]
    fn an_unaligned_region_is_refused_rather_than_rounded() {
        for byte_offset in [1, 2, 3, 33] {
            assert_eq!(
                reach(byte_offset, 64),
                Err(ViewError::Misaligned { byte_offset }),
                "byte {byte_offset} was accepted"
            );
        }
    }

    /// Caught here rather than by the subtraction below it, which would
    /// underflow into a view of most of the address space.
    #[test]
    fn a_region_past_the_end_is_refused() {
        assert_eq!(
            reach(96, 64),
            Err(ViewError::Outside {
                byte_offset: 96,
                byte_length: 64,
            })
        );
    }

    /// Read by a person looking at a page that will not start, as with
    /// `HandshakeError`.
    #[test]
    fn every_view_error_says_what_went_wrong() {
        for error in [
            ViewError::NotABuffer,
            ViewError::Misaligned { byte_offset: 3 },
            ViewError::Outside {
                byte_offset: 96,
                byte_length: 64,
            },
        ] {
            assert!(format!("{error}").len() > 20, "{error:?} says nothing");
        }
    }

    #[test]
    fn the_failure_is_an_error() {
        const fn assert_error<E: core::error::Error>() {}
        assert_error::<ViewError>();
    }
}
