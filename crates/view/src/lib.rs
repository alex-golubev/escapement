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
use std::collections::VecDeque;

use js_sys::{Atomics, Reflect, Uint32Array};
use wasm_bindgen::{JsValue, UnwrapThrowExt};

use escapement_protocol::{Cells, HandshakeError, Layout, Producer, Subscriber};

// What a caller needs in order to say anything to the engine or read anything
// back, so that reaching it is one import rather than two. The protocol's own
// facade exists for the same reason.
pub use escapement_protocol::{Command, CommandKind, EngineState};

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
            // With the length: given none, the constructor demands a whole
            // number of words of the *buffer* rather than of the part `reach`
            // measured, and answers a remainder by throwing.
            //
            // Lossless: `reach` accepted the offset, so it and the words it
            // counted are inside a buffer whose own length was a `u32`.
            cells: Uint32Array::new_with_byte_offset_and_length(
                buffer,
                byte_offset as u32,
                words as u32,
            ),
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
/// The outside end of the shared region: what the interface holds, before and
/// after there is a region to hold it to.
///
/// Built empty and connected later, because that is the order things happen in:
/// an `AudioContext` starts only on a user gesture, so the interface is alive
/// and can be clicked at for some time before the worklet exists. Commands sent
/// in that time wait here and leave when it does (§3).
///
/// The worklet's mirror of this is its `Processor`.
pub struct Link {
    region: Option<Region>,
    outbox: VecDeque<Command>,
}

/// The two halves that only exist once the handshake has happened.
struct Region {
    commands: Producer<View, Command>,
    state: Subscriber<View>,
}

impl Link {
    /// Not connected to anything yet, and already able to take commands.
    #[must_use]
    pub fn new() -> Self {
        Self {
            region: None,
            outbox: VecDeque::new(),
        }
    }

    /// The handshake: `buffer` is the worklet's `memory.buffer` and
    /// `byte_offset` what `escapement_region_ptr` returned.
    ///
    /// Whatever is waiting stays waiting; the next [`Link::flush`] sends it.
    ///
    /// # Errors
    ///
    /// [`ConnectError`] — the address is not one a view can be built at, or
    /// what is there is not a region this build can speak to. The link is left
    /// unconnected and still takes commands.
    pub fn connect(&mut self, buffer: &JsValue, byte_offset: usize) -> Result<(), ConnectError> {
        let cells = View::new(buffer, byte_offset)?;
        let layout = Layout::read_header(&cells)?;

        self.region = Some(Region {
            commands: Producer::new(cells.clone(), layout.commands()),
            state: Subscriber::new(cells, layout.state()),
        });
        Ok(())
    }

    /// Whether the handshake has happened.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.region.is_some()
    }

    /// Takes a command. Cannot fail, and that is the point (§3).
    ///
    /// A full ring is not something a user action can be told about:
    /// `Atomics.wait` is forbidden on the main thread, so the alternative to
    /// queueing here is dropping what someone clicked. This queue is in memory
    /// that grows, so it holds whatever it has to.
    pub fn send(&mut self, command: Command) {
        self.outbox.push_back(command);
    }

    /// Moves what fits into the ring, and returns how many went. Once a frame.
    ///
    /// A command can wait a frame. Worth remembering while debugging, and not
    /// worth avoiding: the ring holds a frame's worth of traffic many times
    /// over, so what usually waits is nothing.
    pub fn flush(&mut self) -> usize {
        let Some(region) = self.region.as_mut() else {
            return 0;
        };

        let mut sent = 0;
        while let Some(command) = self.outbox.front() {
            if region.commands.push(command).is_err() {
                break;
            }
            self.outbox.pop_front();
            sent += 1;
        }
        sent
    }

    /// What the engine says about itself. `None` before the handshake, and also
    /// when the writer was in the way every time — keep the previous frame's
    /// values, the next frame is 16 ms away.
    #[must_use]
    pub fn state(&self) -> Option<EngineState> {
        self.region.as_ref()?.state.read()
    }

    /// Commands still waiting for room, or for a region to put them in.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.outbox.len()
    }
}

impl Default for Link {
    fn default() -> Self {
        Self::new()
    }
}

/// Why a handshake did not connect a [`Link`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectError {
    /// No view could be built at that address.
    Address(ViewError),
    /// A view was built, and what it found is not a region this build can use.
    Region(HandshakeError),
}

impl From<ViewError> for ConnectError {
    fn from(error: ViewError) -> Self {
        Self::Address(error)
    }
}

impl From<HandshakeError> for ConnectError {
    fn from(error: HandshakeError) -> Self {
        Self::Region(error)
    }
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Address(error) => write!(f, "{error}"),
            Self::Region(error) => write!(f, "{error}"),
        }
    }
}

impl core::error::Error for ConnectError {}

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
    use escapement_protocol::{Consumer, Layout, Producer, Publisher, Subscriber};
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

    /// The other half of `a_partial_word_at_the_end_is_not_counted`: what
    /// `reach` accepts the constructor has to accept too, and left to itself it
    /// does not.
    #[wasm_bindgen_test]
    fn a_buffer_that_is_not_a_whole_number_of_words_is_still_reachable() {
        const SPARE: usize = 2;
        let buffer = SharedArrayBuffer::new((OFFSET + 4 * BYTES + SPARE) as u32);
        let cells = View::new(&buffer.into(), OFFSET).expect("an aligned offset");

        assert_eq!(cells.words(), 4, "the remainder was counted as a word");
        cells.store_relaxed(3, 7);
        assert_eq!(cells.load_relaxed(3), 7, "the last whole word");
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

    /// A region with a header in it, as the worklet leaves one, and the buffer
    /// to reach it by — which is the pair a handshake is handed.
    fn region_with_header(slots: u32) -> (JsValue, Layout) {
        let layout = Layout::new(slots);
        let bytes = OFFSET + layout.words() * BYTES;
        let buffer: JsValue = SharedArrayBuffer::new(bytes as u32).into();

        let cells = View::new(&buffer, OFFSET).expect("an aligned offset");
        layout.write_header(&cells);
        (buffer, layout)
    }

    fn engine(buffer: &JsValue, layout: Layout) -> Consumer<View, Command> {
        let cells = View::new(buffer, OFFSET).expect("an aligned offset");
        Consumer::new(cells, layout.commands())
    }

    /// The order things actually happen in: an `AudioContext` starts on a
    /// gesture, so the interface is clickable before there is anywhere to put
    /// what was clicked.
    #[wasm_bindgen_test]
    fn what_was_sent_before_the_handshake_still_arrives() {
        let mut link = Link::new();
        link.send(Command::now(CommandKind::Start));
        link.send(Command::now(CommandKind::SetGain(0.25)));

        assert_eq!(link.flush(), 0, "there is nowhere to flush to yet");
        assert_eq!(link.pending(), 2);
        assert!(!link.is_connected());
        assert_eq!(link.state(), None, "no region, no state");

        let (buffer, layout) = region_with_header(8);
        link.connect(&buffer, OFFSET).expect("a header is there");

        assert!(link.is_connected());
        assert_eq!(link.flush(), 2);
        assert_eq!(link.pending(), 0);

        let mut engine = engine(&buffer, layout);
        assert_eq!(engine.pop().map(|c| c.kind), Some(CommandKind::Start));
        assert_eq!(
            engine.pop().map(|c| c.kind),
            Some(CommandKind::SetGain(0.25))
        );
    }

    /// Р5, and the reason the queue exists at all: a full ring must delay a
    /// user action, never lose it. `Atomics.wait` is forbidden on this thread,
    /// so waiting for room is not among the options.
    #[wasm_bindgen_test]
    fn a_full_ring_delays_rather_than_drops() {
        const SLOTS: u32 = 2;
        let (buffer, layout) = region_with_header(SLOTS);

        let mut link = Link::new();
        link.connect(&buffer, OFFSET).expect("a header is there");
        for step in 0..5u8 {
            link.send(Command::now(CommandKind::SetFrequency(f32::from(step))));
        }

        assert_eq!(link.flush(), SLOTS as usize, "only what fits");
        assert_eq!(link.pending(), 3);

        let mut engine = engine(&buffer, layout);
        assert_eq!(
            engine.pop().map(|c| c.kind),
            Some(CommandKind::SetFrequency(0.0))
        );
        assert_eq!(
            engine.pop().map(|c| c.kind),
            Some(CommandKind::SetFrequency(1.0))
        );

        assert_eq!(link.flush(), 2, "room for two more");
        assert_eq!(link.pending(), 1);
        assert_eq!(
            engine.pop().map(|c| c.kind),
            Some(CommandKind::SetFrequency(2.0)),
            "and in the order they were sent"
        );
    }

    /// What the engine publishes reaches the same value the interface polls.
    #[wasm_bindgen_test]
    fn the_state_block_reaches_the_link() {
        let (buffer, layout) = region_with_header(8);
        let mut link = Link::new();
        link.connect(&buffer, OFFSET).expect("a header is there");

        let published = EngineState {
            clock: 96_000,
            quanta: 750,
            peak: 0.25,
            playing: true,
            commands_applied: 3,
            commands_unknown: 0,
        };
        let cells = View::new(&buffer, OFFSET).expect("an aligned offset");
        Publisher::new(cells, layout.state()).publish(&published);

        assert_eq!(link.state(), Some(published));
    }

    /// A page can be pointed at the wrong address, and what it had queued is
    /// not the address's fault.
    #[wasm_bindgen_test]
    fn a_refused_handshake_leaves_the_link_taking_commands() {
        let mut link = Link::new();
        link.send(Command::now(CommandKind::Start));

        let empty: JsValue = SharedArrayBuffer::new(256).into();
        assert!(matches!(
            link.connect(&empty, 0),
            Err(ConnectError::Region(HandshakeError::Magic { .. }))
        ));
        assert!(matches!(
            link.connect(&empty, 3),
            Err(ConnectError::Address(ViewError::Misaligned { .. }))
        ));

        assert!(!link.is_connected());
        assert_eq!(link.pending(), 1, "what was waiting is still waiting");
    }

    /// These are read by a person looking at a page that will not start.
    #[wasm_bindgen_test]
    fn a_refusal_says_which_half_refused() {
        for error in [
            ConnectError::Address(ViewError::NotABuffer),
            ConnectError::Region(HandshakeError::Shape),
        ] {
            assert!(format!("{error}").len() > 20, "{error:?} says nothing");
        }
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

    /// An address inside the memory but too near its end for a header: nothing
    /// the view can refuse, since the words behind it really are reachable, and
    /// a throw rather than an error if it reaches the read.
    #[wasm_bindgen_test]
    fn an_address_with_no_room_for_a_header_is_refused_rather_than_thrown() {
        const END: usize = 256;
        let buffer: JsValue = SharedArrayBuffer::new(END as u32).into();

        for byte_offset in [END, END - BYTES] {
            let mut link = Link::new();
            assert!(
                matches!(
                    link.connect(&buffer, byte_offset),
                    Err(ConnectError::Region(HandshakeError::TooSmall { .. }))
                ),
                "byte {byte_offset} was taken for a region"
            );
        }
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
