//! The protocol both wasm modules speak through the worklet's linear memory.
//!
//! The worklet owns that memory and reaches it with pointers; the interface and
//! the workers reach it from outside, through a typed-array view and `Atomics`
//! (ARCHITECTURE.md §3). Only the access differs — everything below is written
//! once and used by both ends.
//!
//! Three mechanisms, not one, because the traffic has three shapes:
//!
//! - a **queue** ([`ring`]) for commands: ordered, lossless, drained by the
//!   reader;
//! - a **latest value** ([`state`]) for meters and the playhead: written every
//!   quantum, read once a frame, skipped values do not exist as a concept;
//! - **double buffering** for the project snapshot — not here yet, slice 2.
//!
//! Everything is addressed in 32-bit words rather than bytes. `Atomics` index a
//! view by element, so words remove a class of alignment mistakes on the outside
//! and remove byte order from the encoding on both.

#![no_std]
// Exactly one module is allowed to break this, and it is named where it is let
// through: `access::pointers`.
#![deny(unsafe_code)]

// The crate is `no_std` unconditionally, so that neither half can reach for an
// allocator by accident. The unit tests want threads and a heap, and ask for
// them here rather than by weakening the attribute above: a conditional
// `no_std` leaves the crate with two different shapes, and tooling that picks
// the wrong combination of the two reports errors `cargo` never sees.
#[cfg(test)]
extern crate std;

#[cfg(test)]
#[cfg(loom)]
mod interleavings;

pub mod access;
pub mod command;
pub mod ring;
pub mod state;

pub use access::Cells;
pub use command::{Command, CommandKind};
pub use ring::{Consumer, Producer, Slot};
pub use state::{EngineState, Publisher, Subscriber};

use core::fmt;

/// A `u64` takes two words, low first.
///
/// In one place because the two ends have to agree on that order, and nothing
/// would notice if they quietly stopped.
pub(crate) fn put_u64(into: &mut [u32], at: usize, value: u64) {
    into[at] = value as u32;
    into[at + 1] = (value >> 32) as u32;
}

pub(crate) fn get_u64(from: &[u32], at: usize) -> u64 {
    u64::from(from[at]) | (u64::from(from[at + 1]) << 32)
}

/// `"ESCP"`. Read out of a memory dump it is the one word that says which
/// project this region belongs to.
pub const MAGIC: u32 = 0x4553_4350;

/// Raise on any change to the layout, the slot encoding or the state block.
///
/// The two modules are fetched and cached by the browser separately, so a new
/// interface meeting a stale worklet is an ordinary afternoon. The version turns
/// that into a message instead of a silent misread.
pub const VERSION: u32 = 1;

/// A region is a control block, not a heap.
///
/// The ceiling is what keeps every offset read out of a header inside 32-bit
/// arithmetic: `usize` is 32 bits on the target, and a base of `u32::MAX` would
/// overflow the first sum it takes part in. A host test cannot catch that — there
/// `usize` is 64 bits and the same sum simply fits.
pub const MAX_REGION_WORDS: usize = 1 << 24;

/// Words reserved for the header. Generous on purpose: it is described by
/// itself, so growing it later costs nothing, while moving the rings does.
pub const HEADER_WORDS: usize = 32;

const HEADER_MAGIC: usize = 0;
const HEADER_VERSION: usize = 1;
const HEADER_WORDS_TOTAL: usize = 2;
const HEADER_COMMANDS_BASE: usize = 3;
const HEADER_COMMANDS_CAPACITY: usize = 4;
const HEADER_COMMANDS_SLOT_WORDS: usize = 5;
const HEADER_STATE_BASE: usize = 6;
const HEADER_STATE_WORDS: usize = 7;

/// Where everything sits inside the shared region.
///
/// Computed by [`Layout::new`] on the owning side and written into the header;
/// the outside side reads it back rather than being compiled with a copy of the
/// same constants. One source of truth for offsets, so they cannot drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    words: usize,
    commands: ring::RingLayout,
    state: state::BlockLayout,
}

impl Layout {
    /// `command_slots` must be a power of two; called in a `const` context, as
    /// the owning side does, that is checked at compile time.
    pub const fn new(command_slots: u32) -> Self {
        let commands = ring::RingLayout::new(HEADER_WORDS, command_slots, Command::WORDS);
        let state = state::BlockLayout::new(commands.end());
        Self {
            words: state.end(),
            commands,
            state,
        }
    }

    /// Size of the whole region, in words.
    pub const fn words(&self) -> usize {
        self.words
    }

    pub const fn commands(&self) -> ring::RingLayout {
        self.commands
    }

    pub const fn state(&self) -> state::BlockLayout {
        self.state
    }

    /// Writes the header. The owning side calls this once, before publishing the
    /// region's address; nothing else may touch the region until it has.
    pub fn write_header<C: Cells>(&self, cells: &C) {
        cells.store_relaxed(HEADER_WORDS_TOTAL, self.words as u32);
        cells.store_relaxed(HEADER_COMMANDS_BASE, self.commands.base() as u32);
        cells.store_relaxed(HEADER_COMMANDS_CAPACITY, self.commands.capacity());
        cells.store_relaxed(
            HEADER_COMMANDS_SLOT_WORDS,
            self.commands.slot_words() as u32,
        );
        cells.store_relaxed(HEADER_STATE_BASE, self.state.base() as u32);
        cells.store_relaxed(HEADER_STATE_WORDS, EngineState::WORDS as u32);
        cells.store_relaxed(HEADER_VERSION, VERSION);

        // Last, and with release ordering: the magic is what the other side
        // waits for, so everything above must already be visible behind it.
        cells.store_release(HEADER_MAGIC, MAGIC);
    }

    /// Reads the header back. The outside side calls this once, at the
    /// handshake.
    pub fn read_header<C: Cells>(cells: &C) -> Result<Self, HandshakeError> {
        let magic = cells.load_acquire(HEADER_MAGIC);
        if magic != MAGIC {
            return Err(HandshakeError::Magic { found: magic });
        }
        let version = cells.load_relaxed(HEADER_VERSION);
        if version != VERSION {
            return Err(HandshakeError::Version {
                found: version,
                expected: VERSION,
            });
        }

        let words = cells.load_relaxed(HEADER_WORDS_TOTAL) as usize;
        let commands_base = cells.load_relaxed(HEADER_COMMANDS_BASE) as usize;
        let capacity = cells.load_relaxed(HEADER_COMMANDS_CAPACITY);
        let slot_words = cells.load_relaxed(HEADER_COMMANDS_SLOT_WORDS) as usize;
        let state_base = cells.load_relaxed(HEADER_STATE_BASE) as usize;
        let payload_words = cells.load_relaxed(HEADER_STATE_WORDS) as usize;

        // The version says the two sides agree; this says the compiled types do.
        // They can part company without the version being touched — an edited
        // enum, a rebuilt half.
        let encodings_match = slot_words == Command::WORDS && payload_words == EngineState::WORDS;

        // Everything here came out of shared memory. `RingLayout::new` asserts,
        // which is what makes it a compile-time check on the side that owns the
        // layout and would be a panic on this one — so it is only reached once
        // the values are known to be ones it accepts.
        let sizes_are_sane = capacity.is_power_of_two()
            && capacity <= ring::MAX_CAPACITY
            && (HEADER_WORDS..MAX_REGION_WORDS).contains(&commands_base)
            && state_base < MAX_REGION_WORDS
            && words <= MAX_REGION_WORDS;

        if !encodings_match || !sizes_are_sane {
            return Err(HandshakeError::Shape);
        }

        let commands = ring::RingLayout::new(commands_base, capacity, slot_words);
        let state = state::BlockLayout::new(state_base);
        if state_base < commands.end() || words < state.end() {
            return Err(HandshakeError::Shape);
        }

        Ok(Self {
            words,
            commands,
            state,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// Nothing has written a header here, or the address is wrong.
    Magic {
        found: u32,
    },
    Version {
        found: u32,
        expected: u32,
    },
    /// Same version, but the region described is not one this build can use.
    Shape,
}

impl fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Magic { found } => {
                write!(f, "no protocol header here (magic {found:#010x})")
            }
            Self::Version { found, expected } => write!(
                f,
                "protocol version {found}, expected {expected} — one side is stale, reload"
            ),
            Self::Shape => f.write_str("protocol version agrees but the region described does not"),
        }
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use super::*;
    use crate::access::testing::Words;

    const LAYOUT: Layout = Layout::new(8);

    fn written() -> Words {
        let words = Words::new(LAYOUT.words());
        LAYOUT.write_header(&&words);
        words
    }

    #[test]
    fn header_round_trips() {
        assert_eq!(Layout::read_header(&&written()), Ok(LAYOUT));
    }

    #[test]
    fn empty_region_is_not_mistaken_for_a_header() {
        let words = Words::new(LAYOUT.words());
        assert_eq!(
            Layout::read_header(&&words),
            Err(HandshakeError::Magic { found: 0 })
        );
    }

    #[test]
    fn a_stale_half_is_named_as_such() {
        let words = written();
        (&words).store_relaxed(HEADER_VERSION, VERSION + 1);
        assert_eq!(
            Layout::read_header(&&words),
            Err(HandshakeError::Version {
                found: VERSION + 1,
                expected: VERSION,
            })
        );
    }

    #[test]
    fn same_version_different_encoding_is_caught() {
        let words = written();
        (&words).store_relaxed(HEADER_COMMANDS_SLOT_WORDS, Command::WORDS as u32 + 1);
        assert_eq!(Layout::read_header(&&words), Err(HandshakeError::Shape));
    }

    /// A header is read before anything in it has been trusted, so every field
    /// gets to be nonsense without taking the reader down with it.
    #[test]
    fn nonsense_in_the_header_is_refused_rather_than_believed() {
        for (word, value) in [
            (HEADER_COMMANDS_CAPACITY, 7),
            (HEADER_COMMANDS_CAPACITY, u32::MAX),
            (HEADER_COMMANDS_CAPACITY, ring::MAX_CAPACITY * 2),
            (HEADER_COMMANDS_BASE, 0),
            (HEADER_COMMANDS_BASE, u32::MAX),
            (HEADER_WORDS_TOTAL, u32::MAX),
            (HEADER_STATE_BASE, 0),
            (HEADER_STATE_BASE, u32::MAX),
            (HEADER_STATE_WORDS, 0),
            (HEADER_WORDS_TOTAL, 0),
        ] {
            let words = written();
            (&words).store_relaxed(word, value);
            assert_eq!(
                Layout::read_header(&&words),
                Err(HandshakeError::Shape),
                "word {word} = {value} was believed"
            );
        }
    }

    /// These are read by a person looking at a page that will not start, so an
    /// error that says nothing is the same as no error at all.
    #[test]
    fn every_handshake_error_says_what_went_wrong() {
        for error in [
            HandshakeError::Magic { found: 0 },
            HandshakeError::Version {
                found: 2,
                expected: 1,
            },
            HandshakeError::Shape,
        ] {
            assert!(std::format!("{error}").len() > 20, "{error:?} says nothing");
        }
    }

    #[test]
    fn nothing_overlaps_and_everything_fits() {
        let commands = LAYOUT.commands();
        let state = LAYOUT.state();
        assert!(commands.base() >= HEADER_WORDS);
        assert!(state.base() >= commands.end());
        assert!(LAYOUT.words() >= state.end());
    }
}
