//! Where something sits on the timeline, and how far it is from something else.
//!
//! Positions are held in musical time and never in samples (ARCHITECTURE.md
//! §2.5), which makes this a type both ends need: `escapement-core` converts on
//! the audio thread, `escapement-model` stores in the CRDT document. `core` is
//! `no_std` and cannot name a type living in a crate that pulls `std`, so the
//! type cannot live in the model — it lives here, one crate for both ends, the
//! same shape `escapement-protocol` has for the same reason.
//!
//! The tick count is private, and that is the insurance §2.5 buys with it: the
//! representation stays revisitable only for as long as nothing outside this
//! crate does arithmetic on the raw integer.

#![no_std]
// Nothing here needs it, unlike `escapement-protocol`, which has one module
// that does. `forbid` rather than `deny` says there is no exception to find.
#![forbid(unsafe_code)]

// The tests want a harness, which wants a heap. Asked for here rather than by
// weakening the attribute above, as `escapement-core` does.
#[cfg(test)]
extern crate std;

use core::ops::{Add, Mul, Neg, Sub};

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

/// A point on the timeline, in ticks from the origin.
///
/// Signed, because a count-in sits before the first bar: the origin is zero
/// rather than the earliest moment this can hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position(i64);

/// The distance between two positions, in ticks.
///
/// The same integer as a [`Position`] and deliberately not the same type. A
/// point and a distance combine in some ways and not others — two positions
/// subtract but do not add — and keeping them apart is what makes the ones that
/// do not combine fail to compile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Span(i64);

impl Position {
    /// The origin. Bar one, beat one.
    pub const ZERO: Self = Self(0);

    /// From a raw tick count.
    ///
    /// This and [`Position::ticks`] are the serialization boundary — what comes
    /// out of a document and what goes back in. Not an invitation to compute on
    /// the integer: doing that outside this crate is what would make §2.5's
    /// choice of representation expensive to revisit.
    #[must_use]
    pub const fn from_ticks(ticks: i64) -> Self {
        Self(ticks)
    }

    /// The raw tick count. See [`Position::from_ticks`].
    #[must_use]
    pub const fn ticks(self) -> i64 {
        self.0
    }

    /// `quarters` quarter notes from the origin.
    #[must_use]
    pub const fn quarters(quarters: i64) -> Self {
        Self(quarters.saturating_mul(TICKS_PER_QUARTER))
    }
}

impl Span {
    /// No distance at all.
    pub const ZERO: Self = Self(0);

    /// One quarter note.
    pub const QUARTER: Self = Self(TICKS_PER_QUARTER);

    /// From a raw tick count. See [`Position::from_ticks`] for what this is and
    /// is not for.
    #[must_use]
    pub const fn from_ticks(ticks: i64) -> Self {
        Self(ticks)
    }

    /// The raw tick count.
    #[must_use]
    pub const fn ticks(self) -> i64 {
        self.0
    }

    /// `quarters` quarter notes.
    #[must_use]
    pub const fn quarters(quarters: i64) -> Self {
        Self(quarters.saturating_mul(TICKS_PER_QUARTER))
    }

    /// `numerator`/`denominator` of a quarter note — a triplet eighth is
    /// `quarter_fraction(1, 3)`, a sixteenth `quarter_fraction(1, 4)`.
    ///
    /// The reason the resolution is what it is, and the only way to reach a
    /// subdivision without dividing the constant by hand outside this crate.
    ///
    /// `None` rather than the nearest tick when the subdivision does not land on
    /// one. Rounding here would hand back a position one tick from the one asked
    /// for and say nothing, and the caller — a piano roll, an importer — is the
    /// side that knows whether that is acceptable. Also `None` on a zero
    /// denominator and on an overflow, neither of which may panic here.
    #[must_use]
    pub const fn quarter_fraction(numerator: i64, denominator: i64) -> Option<Self> {
        if denominator == 0 {
            return None;
        }
        let Some(scaled) = TICKS_PER_QUARTER.checked_mul(numerator) else {
            return None;
        };
        if scaled % denominator != 0 {
            return None;
        }
        Some(Self(scaled / denominator))
    }
}

// Saturating throughout, and not a matter of taste. `escapement-core` may not
// panic on the processing path (CLAUDE.md), which rules out the checked
// arithmetic that panics in a debug build; wrapping would answer "past the end
// of time" with "the distant past", which is worse than staying at the end. And
// the clamp is unreachable in any case: at this resolution an `i64` holds some
// 1.6 x 10^12 quarter notes, twenty-five thousand years at 120 bpm.
impl Add<Span> for Position {
    type Output = Self;

    fn add(self, span: Span) -> Self {
        Self(self.0.saturating_add(span.0))
    }
}

impl Sub<Span> for Position {
    type Output = Self;

    fn sub(self, span: Span) -> Self {
        Self(self.0.saturating_sub(span.0))
    }
}

/// The distance from `earlier` to `self`, negative if `self` is the earlier one.
impl Sub for Position {
    type Output = Span;

    fn sub(self, earlier: Self) -> Span {
        Span(self.0.saturating_sub(earlier.0))
    }
}

impl Add for Span {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self(self.0.saturating_add(other.0))
    }
}

impl Sub for Span {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        Self(self.0.saturating_sub(other.0))
    }
}

impl Neg for Span {
    type Output = Self;

    fn neg(self) -> Self {
        Self(self.0.saturating_neg())
    }
}

/// Repetition — sixteen sixteenths, four bars of the same length.
impl Mul<i64> for Span {
    type Output = Self;

    fn mul(self, times: i64) -> Self {
        Self(self.0.saturating_mul(times))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The consequence of the resolution, from the outside: every tuplet §2.5
    /// promises is reachable, and reaching it is exact. The constant itself is
    /// checked at compile time above; this is the half a caller can see.
    #[test]
    fn every_tuplet_the_resolution_promises_lands_on_a_whole_tick() {
        for tuplet in 1..=13 {
            // One assertion rather than an `expect` and then a comparison:
            // `expect` does not format, so the tuplet would be lost from the
            // message of the half that failed first.
            let part = Span::quarter_fraction(1, tuplet);
            assert_eq!(
                part.map(|part| part * tuplet),
                Some(Span::QUARTER),
                "a quarter split {tuplet} ways does not come back whole"
            );
        }
    }

    /// Binary subdivision, which goes deeper than the tuplets do: a 512th note
    /// is a quarter over 128.
    #[test]
    fn binary_subdivision_reaches_a_512th_note() {
        let shortest = Span::quarter_fraction(1, 128).expect("128 does not divide");
        assert_eq!(shortest * 128, Span::QUARTER);
    }

    /// A subdivision off the grid is the one case where an answer would have to
    /// be invented, so there is no answer instead.
    #[test]
    fn a_subdivision_off_the_grid_is_refused_rather_than_rounded() {
        for denominator in [17, 19, 23] {
            assert_eq!(
                Span::quarter_fraction(1, denominator),
                None,
                "{denominator} was rounded to something"
            );
        }
    }

    /// Both reach this function from a caller, and neither may panic here.
    #[test]
    fn a_nonsense_subdivision_is_refused_rather_than_fatal() {
        assert_eq!(Span::quarter_fraction(1, 0), None, "divided by zero");
        assert_eq!(Span::quarter_fraction(i64::MAX, 1), None, "overflowed");
    }

    /// What a document holds is the integer, so what goes in has to come back —
    /// for both types, since both cross that boundary.
    #[test]
    fn both_types_round_trip_through_their_ticks() {
        for ticks in [0, 1, -1, TICKS_PER_QUARTER, i64::MIN, i64::MAX] {
            assert_eq!(Position::from_ticks(ticks).ticks(), ticks);
            assert_eq!(Span::from_ticks(ticks).ticks(), ticks);
        }
    }

    /// Spans add and subtract among themselves, which positions do not. A
    /// dotted note is the note plus half of it, and that shape — build a length
    /// out of lengths — is most of what this arithmetic will ever be asked for.
    #[test]
    fn spans_combine_into_the_lengths_between_them() {
        let quarter = Span::QUARTER;
        let eighth = Span::quarter_fraction(1, 2).expect("a quarter halves");
        let dotted = quarter + eighth;

        assert_eq!(dotted.ticks(), quarter.ticks() + eighth.ticks());
        assert_eq!(dotted - eighth, quarter);
        assert_eq!(dotted - quarter, eighth);
        assert_eq!(quarter - quarter, Span::ZERO);
    }

    #[test]
    fn a_quarter_note_is_the_resolution() {
        assert_eq!(Position::quarters(1).ticks(), TICKS_PER_QUARTER);
        assert_eq!(Position::quarters(0), Position::ZERO);
        assert_eq!(Span::quarters(1), Span::QUARTER);
    }

    /// The three ways a point and a distance combine, against each other: the
    /// span between two positions is the one that carries the first to the
    /// second, and taking it away again returns where it started.
    #[test]
    fn a_span_carries_one_position_to_another_and_back() {
        let start = Position::quarters(4);
        let end = Position::quarters(7);

        let between = end - start;
        assert_eq!(between, Span::quarters(3));
        assert_eq!(start + between, end);
        assert_eq!(end - between, start);
    }

    /// Order is the whole reason a sequencer can look at this type at all.
    #[test]
    fn positions_and_spans_order_by_time() {
        assert!(Position::quarters(-1) < Position::ZERO);
        assert!(Position::ZERO < Position::quarters(1));
        assert!(Span::quarter_fraction(1, 4).unwrap() < Span::QUARTER);
    }

    #[test]
    fn a_distance_runs_both_ways() {
        let span = Span::quarters(3);
        assert_eq!(-span, Span::quarters(-3));
        assert_eq!(Position::quarters(7) - Position::quarters(4), span);
        assert_eq!(Position::quarters(4) - Position::quarters(7), -span);
    }

    /// The clamp is unreachable in any real project, but the audio thread may
    /// not panic, so what happens at the edge has to be defined rather than
    /// left to a debug build's overflow check.
    #[test]
    fn arithmetic_clamps_rather_than_panicking() {
        let far = Position::from_ticks(i64::MAX);
        assert_eq!(far + Span::QUARTER, far, "ran past the end of time");

        let back = Position::from_ticks(i64::MIN);
        assert_eq!(back - Span::QUARTER, back, "ran past the start of time");

        assert_eq!(Span::from_ticks(i64::MAX) * 2, Span::from_ticks(i64::MAX));
        assert_eq!(Position::quarters(i64::MAX).ticks(), i64::MAX);
    }
}
