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
    // `wasm-bindgen-test-runner` executes only what it generated, so an
    // ordinary `#[test]` compiles for the target and never runs there.
    // Aliasing the attribute is what makes these run in both places, and that
    // is what lets one mutation run answer for the whole crate — measured:
    // without it each of the two runs leaves the other's half alive, 14 and 2.
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

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

// Two attributes rather than one `all(...)`, for the reason `escapement-protocol`
// gives at every test module in it: `cargo-mutants` reads the source without
// evaluating `cfg`, and only a bare `#[cfg(test)]` reads to it as test code.
#[cfg(test)]
#[cfg(target_arch = "wasm32")]
mod browser {
    use escapement_protocol::{
        Command, CommandKind, Consumer, EngineState, Layout, Producer, Publisher, Subscriber,
    };
    use js_sys::SharedArrayBuffer;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    use super::*;

    // A browser, not node: `Atomics` over a `SharedArrayBuffer` is the thing
    // being checked, and node would answer for a different engine than the one
    // this ships to. The runner serves with the isolation headers, so the
    // buffer below is a real shared one rather than a stand-in.
    wasm_bindgen_test_configure!(run_in_browser);

    /// Non-zero, so that an offset dropped somewhere in the arithmetic cannot
    /// give the same answer as one honoured.
    const OFFSET: usize = 64;

    fn region(words: usize) -> View {
        let bytes = OFFSET + words * BYTES;
        let buffer = SharedArrayBuffer::new(bytes as u32);
        View::new(&buffer.into(), OFFSET).expect("a shared buffer and an aligned offset")
    }

    /// What no header can say about itself, and the one thing the handshake
    /// checks against the memory instead (§3).
    #[wasm_bindgen_test]
    fn a_view_reaches_what_lies_behind_its_offset() {
        assert_eq!(region(16).words(), 16);
        assert_eq!(region(1).words(), 1);
    }

    /// The same shape as the `Pointers` test: neighbours are named, because a
    /// write that lands one word over passes every check that only reads back
    /// what it wrote.
    #[wasm_bindgen_test]
    fn each_word_is_its_own_cell() {
        let cells = region(4);

        cells.store_relaxed(1, 7);
        cells.store_release(2, 9);

        assert_eq!(cells.load_relaxed(1), 7);
        assert_eq!(cells.load_acquire(2), 9);
        assert_eq!(cells.load_relaxed(0), 0, "a neighbour was written");
        assert_eq!(cells.load_relaxed(3), 0, "a neighbour was written");
    }

    /// `Atomics` speak `i32` and the region is `u32`. Nothing in between may
    /// reinterpret them, so the word with the top bit set is the one to ask
    /// about.
    #[wasm_bindgen_test]
    fn a_word_survives_the_signed_boundary() {
        let cells = region(2);

        cells.store_relaxed(0, u32::MAX);
        cells.store_relaxed(1, 0x8000_0000);

        assert_eq!(cells.load_relaxed(0), u32::MAX);
        assert_eq!(cells.load_relaxed(1), 0x8000_0000);
    }

    /// The bulk paths are `Cells`'s own, spelled out of the five methods above
    /// — this is what says they were spelled correctly over this backend.
    #[wasm_bindgen_test]
    fn a_block_lands_where_it_was_put() {
        let cells = region(8);

        cells.write_words(2, &[10, 20, 30]);
        let mut read = [0u32; 3];
        cells.read_words(2, &mut read);

        assert_eq!(read, [10, 20, 30]);
        assert_eq!(cells.load_relaxed(1), 0, "a neighbour was written");
        assert_eq!(cells.load_relaxed(5), 0, "a neighbour was written");
    }

    /// The point of the whole crate: the protocol is one piece of code, and
    /// this is the half of it that had never run over this access. Both halves
    /// on one thread, which is not how it ships — what ships is checked by the
    /// host tests and by `loom`. What only a browser can answer is whether
    /// `Atomics` carry it at all.
    #[wasm_bindgen_test]
    fn the_protocol_travels_over_a_view() {
        const LAYOUT: Layout = Layout::new(8);
        let cells = region(LAYOUT.words());

        LAYOUT.write_header(&cells);
        let seen = Layout::read_header(&cells).expect("the header just written");
        assert_eq!(seen, LAYOUT);

        let mut interface = Producer::new(cells.clone(), seen.commands());
        interface
            .push(&Command::now(CommandKind::SetFrequency(440.0)))
            .expect("an empty ring");
        // Annotated because `pop` is the only thing naming the slot type here,
        // and it returns an `Option` of whatever the ring was built for.
        let taken: Command = Consumer::new(cells.clone(), seen.commands())
            .pop()
            .expect("what was just pushed");
        assert_eq!(taken.kind, CommandKind::SetFrequency(440.0));

        let published = EngineState {
            clock: 1 << 40,
            quanta: 7,
            peak: 0.5,
            playing: true,
            commands_applied: 1,
            commands_unknown: 0,
        };
        Publisher::new(cells.clone(), seen.state()).publish(&published);
        assert_eq!(
            Subscriber::new(cells, seen.state()).read(),
            Some(published),
            "the state block did not survive the crossing"
        );
    }

    /// The handshake is handed whatever the page sends it, and a page is not a
    /// type system.
    #[wasm_bindgen_test]
    fn a_value_that_is_not_a_buffer_is_refused() {
        assert_eq!(
            View::new(&JsValue::NULL, 0).unwrap_err(),
            ViewError::NotABuffer
        );
    }

    /// `reach` is tested on the host; this is the wiring between it and the
    /// constructor, which is what would otherwise let a throw out of
    /// `Uint32Array` past us.
    #[wasm_bindgen_test]
    fn a_bad_offset_is_refused_rather_than_thrown() {
        let buffer: JsValue = SharedArrayBuffer::new(64).into();

        assert_eq!(
            View::new(&buffer, 3).unwrap_err(),
            ViewError::Misaligned { byte_offset: 3 }
        );
        assert_eq!(
            View::new(&buffer, 96).unwrap_err(),
            ViewError::Outside {
                byte_offset: 96,
                byte_length: 64,
            }
        );
    }
}
