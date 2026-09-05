//! Musical time: where something sits on the timeline, how far it is from
//! something else, what either is in seconds, and which bar and beat that is.
//!
//! Positions are held in musical time and never in samples (ARCHITECTURE.md
//! §2.5), which makes these types ones both ends need: `escapement-core`
//! converts on the audio thread, `escapement-model` stores in the CRDT
//! document. `core` is `no_std` and cannot name a type living in a crate that
//! pulls `std`, so they cannot live in the model — they live here, one crate for
//! both ends, the same shape `escapement-protocol` has for the same reason.
//!
//! The tick count is private, and that is the insurance §2.5 buys with it: the
//! representation stays revisitable only for as long as nothing outside this
//! crate does arithmetic on the raw integer.
//!
//! Nothing here allocates, so [`tempo::build`] and [`meter::build`] write into a
//! buffer the caller owns. That is what lets the expensive half of a map be
//! worked out in the model, where a `Vec` is allowed, and the cheap half be read
//! on the audio thread, where it is not.
//!
//! **Two maps, and they do not consult each other.** [`tempo`] turns a position
//! into seconds; [`meter`] turns it into a bar and a beat. What keeps them apart
//! is that tempo counts quarter notes whatever the signature says (§2.5) — so
//! the word `beat` means one thing in one module and another in the other, and
//! that is the whole of their independence rather than an oversight. Both are
//! reached through their module for the same reason: `tempo::Mark` and
//! `meter::Mark` are different marks, and a crate root holding one of each would
//! have to invent names for what the modules already name.

#![no_std]
// Nothing here needs it, unlike `escapement-protocol`, which has one module
// that does. `forbid` rather than `deny` says there is no exception to find.
#![forbid(unsafe_code)]

// The tests want a harness, which wants a heap. Asked for here rather than by
// weakening the attribute above, as `escapement-core` does.
#[cfg(test)]
extern crate std;

/// Ticks in a quarter note — the grid every position lands on.
///
/// 2^7 · 3^2 · 5 · 7 · 11 · 13, and generous because being wrong is asymmetric:
/// a finer grid is reachable from a coarser one by multiplication, while a
/// coarser one has already lost what it cannot hold (§2.5).
pub const TICKS_PER_QUARTER: i64 = 5_765_760;

// What §2.5 claims about that number, checked rather than remembered: every
// tuplet up to thirteen, and binary subdivision down to a 512th note, land on a
// whole tick. A number edited without this in mind fails to compile.
//
// Six divisors carry the whole promise: 128 brings every binary subdivision and
// with it 2, 4 and 8; 9 brings 3 and 6; 5, 7, 11 and 13 are their own. The rest
// of one to thirteen are products of those and need no line here.
//
// Spelled out rather than looped, and that is the part to keep while editing: a
// loop has a bound, and a bound moved to nothing takes the assertion with it
// while still compiling. Six separate claims have nothing to move.
const _: () = {
    assert!(
        TICKS_PER_QUARTER % 128 == 0,
        "the resolution no longer reaches a 512th note"
    );
    assert!(
        TICKS_PER_QUARTER % 9 == 0,
        "the resolution no longer divides nested triplets"
    );
    assert!(
        TICKS_PER_QUARTER % 5 == 0,
        "the resolution no longer divides quintuplets"
    );
    assert!(
        TICKS_PER_QUARTER % 7 == 0,
        "the resolution no longer divides septuplets"
    );
    assert!(
        TICKS_PER_QUARTER % 11 == 0,
        "the resolution no longer divides elevenths"
    );
    assert!(
        TICKS_PER_QUARTER % 13 == 0,
        "the resolution no longer divides thirteenths"
    );
};

pub mod meter;
mod position;
pub mod tempo;

pub use position::{Position, Span};
