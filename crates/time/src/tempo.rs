//! The tempo map: what a musical position is in seconds, and what a moment in
//! seconds is as a musical position.
//!
//! A ramp is linear in beats per minute (ARCHITECTURE.md §2.5), which makes the
//! elapsed time a logarithm of the position and the inverse an exponential.
//!
//! Built on one side, read on the other. [`build`] does the deciding and the
//! arithmetic that only has to happen once — which of two forms a stretch takes,
//! and how many seconds stand in front of it — into a buffer the caller owns, so
//! that this crate allocates nothing and the model can hold the buffer in a
//! `Vec`. Reading is then a search and one formula, which is what the audio
//! thread can afford.

use core::fmt;

use crate::{Position, Span, TICKS_PER_QUARTER};

/// What the tempo does between one mark and the next.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Curve {
    /// Hold this tempo until the next mark, then step to it.
    #[default]
    Hold,
    /// Travel to the next mark's tempo, linearly in beats per minute (§2.5).
    Ramp,
}

/// A tempo mark: from here, this tempo, reaching the next mark by `curve`.
///
/// A beat is a quarter note, as it is on every tempo display — the time
/// signature has no say in it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mark {
    /// Where it takes effect.
    pub at: Position,
    /// Quarter notes per minute. Must be finite and above zero.
    pub beats_per_minute: f64,
    /// What happens between here and the next mark.
    pub curve: Curve,
}

/// Below this relative change in tempo, a ramp is built as a steady stretch.
///
/// Not a tolerance — a crossover. The logarithmic form divides by the rate of
/// change, so it loses precision as that rate approaches zero, and below this
/// point a straight line is the more accurate of the two answers as well as the
/// one that cannot produce a NaN. Whoever moves this number should measure both
/// forms against exact arithmetic first; the commit that set it did.
const FLAT: f64 = 1e-9;

/// One stretch of the map, with everything a lookup needs already worked out.
///
/// Produced by [`build`] and not by hand: which form applies is decided there,
/// where deciding is allowed. Public only because the caller owns the buffer
/// these are written into.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Segment {
    start: Position,
    /// Seconds from the origin to `start`. The running total that makes a
    /// lookup cost one stretch rather than all the ones before it.
    seconds_at_start: f64,
    /// Seconds to a quarter at `start`. The whole answer for a steady stretch,
    /// and what anything reaching back before the map uses.
    seconds_per_quarter: f64,
    shape: Shape,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Shape {
    /// `seconds = seconds_per_quarter * quarters`.
    #[default]
    Steady,
    /// `seconds = scale * ln(1 + rate * quarters)`, and `rate` is never zero —
    /// [`build`] is what guarantees that (§2.5).
    Ramp { scale: f64, rate: f64 },
}

impl Segment {
    /// Seconds from `start` to `quarters` past it. Negative behind it, which is
    /// how the map answers for anything before its first mark.
    fn elapsed(&self, quarters: f64) -> f64 {
        match self.shape {
            Shape::Steady => self.seconds_per_quarter * quarters,
            // Behind its own start a ramp is held rather than run backwards:
            // extrapolating one takes the tempo through zero and the logarithm
            // with it. A count-in wants the tempo it counts in at anyway.
            Shape::Ramp { .. } if quarters < 0.0 => self.seconds_per_quarter * quarters,
            Shape::Ramp { scale, rate } => scale * libm::log(1.0 + rate * quarters),
        }
    }

    /// The inverse: quarters from `start` after `seconds` of it.
    fn quarters_after(&self, seconds: f64) -> f64 {
        match self.shape {
            Shape::Steady => seconds / self.seconds_per_quarter,
            // The other side of the rule above.
            Shape::Ramp { .. } if seconds < 0.0 => seconds / self.seconds_per_quarter,
            Shape::Ramp { scale, rate } => (libm::exp(seconds / scale) - 1.0) / rate,
        }
    }
}

/// A tempo map, read-only, over segments someone else is holding.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TempoMap<'a> {
    segments: &'a [Segment],
}

impl TempoMap<'_> {
    /// Seconds from the origin to `position`, negative before it.
    ///
    /// A position before the map's first mark needs no case of its own: the
    /// search lands on the first stretch either way, and the quarters into it
    /// come out negative, which is where [`Segment::elapsed`] holds the tempo
    /// instead of running a ramp backwards.
    #[must_use]
    pub fn seconds_at(&self, position: Position) -> f64 {
        let found = self
            .segments
            .partition_point(|segment| segment.start <= position)
            .saturating_sub(1);
        let Some(segment) = self.segments.get(found) else {
            return 0.0;
        };
        segment.seconds_at_start + segment.elapsed(quarters(position - segment.start))
    }

    /// The musical position `seconds` from the origin — the inverse of
    /// [`TempoMap::seconds_at`], to the nearest tick.
    ///
    /// A moment that is not a number has no position, and the origin is
    /// returned rather than a NaN allowed onward: cast to an integer it would
    /// become tick zero anyway, and silently (§2.5).
    #[must_use]
    pub fn position_at(&self, seconds: f64) -> Position {
        if seconds.is_nan() {
            return Position::ZERO;
        }

        let found = self
            .segments
            .partition_point(|segment| segment.seconds_at_start <= seconds)
            .saturating_sub(1);
        let Some(segment) = self.segments.get(found) else {
            return Position::ZERO;
        };
        segment.start + span(segment.quarters_after(seconds - segment.seconds_at_start))
    }
}

/// Works `marks` out into `into`, and hands back a map over what was written.
///
/// The expensive half of the map, and the half that gets to decide things: this
/// is where a ramp too shallow to be one becomes a steady stretch, so that the
/// audio thread never compares a rate against a threshold (§2.5).
///
/// `into` needs one [`Segment`] per mark.
///
/// # Errors
///
/// [`BuildError`], for marks that do not describe a map: none at all, not
/// starting at the origin, out of order, a tempo that is not one, or a buffer
/// too small to hold the answer.
pub fn build<'a>(marks: &[Mark], into: &'a mut [Segment]) -> Result<TempoMap<'a>, BuildError> {
    let Some(first) = marks.first() else {
        return Err(BuildError::Empty);
    };
    if into.len() < marks.len() {
        return Err(BuildError::TooSmall {
            marks: marks.len(),
            room: into.len(),
        });
    }
    if first.at != Position::ZERO {
        return Err(BuildError::NotAtOrigin { at: first.at });
    }
    for (index, mark) in marks.iter().enumerate() {
        if !mark.beats_per_minute.is_finite() || mark.beats_per_minute <= 0.0 {
            return Err(BuildError::Tempo {
                index,
                beats_per_minute: mark.beats_per_minute,
            });
        }
        if index > 0 && mark.at <= marks[index - 1].at {
            return Err(BuildError::OutOfOrder { index });
        }
    }

    let mut seconds = 0.0;
    for (index, mark) in marks.iter().enumerate() {
        let seconds_per_quarter = 60.0 / mark.beats_per_minute;
        let next = marks.get(index + 1);

        // A ramp needs somewhere to ramp to, an instruction to do it, and a
        // tempo far enough away to be worth the logarithm. Anything else is a
        // steady stretch, and deciding that here is the whole point (§2.5).
        let ramping = next.filter(|next| {
            mark.curve == Curve::Ramp
                && (next.beats_per_minute - mark.beats_per_minute).abs()
                    > mark.beats_per_minute * FLAT
        });

        let shape = match ramping {
            Some(next) => {
                let length = quarters(next.at - mark.at);
                // Beats per minute per quarter note. Non-zero: the tempi differ
                // by more than `FLAT` of one of them, and `length` is above zero
                // because the marks were checked to be increasing.
                let rate_per_quarter = (next.beats_per_minute - mark.beats_per_minute) / length;
                Shape::Ramp {
                    scale: 60.0 / rate_per_quarter,
                    rate: rate_per_quarter / mark.beats_per_minute,
                }
            }
            None => Shape::Steady,
        };

        into[index] = Segment {
            start: mark.at,
            seconds_at_start: seconds,
            seconds_per_quarter,
            shape,
        };

        if let Some(next) = next {
            seconds += into[index].elapsed(quarters(next.at - mark.at));
        }
    }

    Ok(TempoMap {
        segments: &into[..marks.len()],
    })
}

/// A span as a number of quarter notes.
fn quarters(span: Span) -> f64 {
    // Lossless well past any project: an `f64` carries whole numbers to 2^53,
    // and a ten-hour project at 120 bpm is under 10^11 ticks.
    span.ticks() as f64 / TICKS_PER_QUARTER as f64
}

/// Quarter notes back to a span, at the nearest tick.
fn span(quarters: f64) -> Span {
    let ticks = libm::round(quarters * TICKS_PER_QUARTER as f64);
    // `as` saturates at the ends and answers NaN with zero. The first is the
    // honest answer for a moment past the end of time; the second is why
    // `position_at` turns a NaN away before it reaches here.
    Span::from_ticks(ticks as i64)
}

/// Why marks did not describe a tempo map.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BuildError {
    /// No marks at all. A map has to say what the tempo is somewhere.
    Empty,
    /// The first mark is not at the origin, so part of the timeline has no
    /// tempo.
    NotAtOrigin {
        /// Where the first mark was.
        at: Position,
    },
    /// A mark at or before the one in front of it.
    OutOfOrder {
        /// Which mark.
        index: usize,
    },
    /// A tempo that is not a tempo — zero, negative, infinite or not a number.
    ///
    /// The one variant carrying a value that may be a NaN, so two of these can
    /// describe the same refusal and still compare unequal. Match on it, or
    /// compare the bits.
    Tempo {
        /// Which mark.
        index: usize,
        /// What it said.
        beats_per_minute: f64,
    },
    /// The buffer cannot hold a segment per mark.
    TooSmall {
        /// Marks given.
        marks: usize,
        /// Segments the buffer holds.
        room: usize,
    },
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("a tempo map needs at least one mark"),
            Self::NotAtOrigin { at } => write!(
                f,
                "the first tempo mark is at tick {}, leaving the start of the timeline without one",
                at.ticks()
            ),
            Self::OutOfOrder { index } => {
                write!(f, "tempo mark {index} is not after the one before it")
            }
            Self::Tempo {
                index,
                beats_per_minute,
            } => write!(f, "tempo mark {index} is {beats_per_minute} beats a minute"),
            Self::TooSmall { marks, room } => {
                write!(
                    f,
                    "{marks} marks need {marks} segments and there is room for {room}"
                )
            }
        }
    }
}

impl core::error::Error for BuildError {}

#[cfg(test)]
mod tests {
    use super::*;

    const STEADY: f64 = 120.0;

    fn mark(quarters: i64, beats_per_minute: f64, curve: Curve) -> Mark {
        Mark {
            at: Position::quarters(quarters),
            beats_per_minute,
            curve,
        }
    }

    /// A quarter at 120 beats a minute is half a second, so a whole map of it
    /// is arithmetic anyone can check by hand.
    #[test]
    fn a_steady_map_is_a_straight_line() {
        let marks = [mark(0, STEADY, Curve::Hold)];
        let mut room = [Segment::default(); 1];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.seconds_at(Position::ZERO), 0.0);
        assert_eq!(map.seconds_at(Position::quarters(1)), 0.5);
        assert_eq!(map.seconds_at(Position::quarters(8)), 4.0);
    }

    /// The other kind of tempo change, and the more common one: no ramp, a step
    /// at the mark. Four quarters at 120 then four at 60 is two seconds then
    /// four.
    #[test]
    fn a_held_tempo_steps_at_the_mark() {
        let marks = [mark(0, 120.0, Curve::Hold), mark(4, 60.0, Curve::Hold)];
        let mut room = [Segment::default(); 2];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.seconds_at(Position::quarters(4)), 2.0);
        assert_eq!(map.seconds_at(Position::quarters(8)), 6.0);
    }

    /// The closed form against brute force. Elapsed time is the integral of the
    /// period over the position, so a hundred thousand small steps have to land
    /// where the logarithm says — otherwise the formula is a plausible one
    /// rather than the right one.
    #[test]
    fn a_ramp_matches_the_integral_it_came_from() {
        const LENGTH: f64 = 16.0;
        const FROM: f64 = 120.0;
        const TO: f64 = 140.0;
        const STEPS: usize = 100_000;

        let marks = [mark(0, FROM, Curve::Ramp), mark(16, TO, Curve::Hold)];
        let mut room = [Segment::default(); 2];
        let map = build(&marks, &mut room).unwrap();

        let step = LENGTH / STEPS as f64;
        let mut brute = 0.0;
        for n in 0..STEPS {
            // Midpoint of each slice, which is what makes this converge fast
            // enough to be a check rather than another approximation.
            let quarters = (n as f64 + 0.5) * step;
            brute += 60.0 / (FROM + (TO - FROM) * quarters / LENGTH) * step;
        }

        let closed = map.seconds_at(Position::quarters(16));
        assert!(
            (closed - brute).abs() < 1e-6,
            "closed form {closed} against integration {brute}"
        );
    }

    /// The pair §2.5 asks for, and the one that has to be right to a tick: a
    /// position through seconds and back is the position it started as.
    #[test]
    fn a_position_survives_the_trip_through_seconds() {
        let marks = [
            mark(0, 120.0, Curve::Ramp),
            mark(16, 140.0, Curve::Hold),
            mark(32, 90.0, Curve::Ramp),
            mark(64, 200.0, Curve::Hold),
        ];
        let mut room = [Segment::default(); 4];
        let map = build(&marks, &mut room).unwrap();

        let mut worst = 0i64;
        for tick in (0..80 * TICKS_PER_QUARTER).step_by(TICKS_PER_QUARTER as usize / 97) {
            let there = Position::from_ticks(tick);
            let back = map.position_at(map.seconds_at(there));
            worst = worst.max((back - there).ticks().abs());
        }
        assert_eq!(worst, 0, "a position came back {worst} ticks away");
    }

    /// A ramp needs somewhere to go. Marked as one and pointed at its own
    /// tempo, it is the degenerate case §2.5 turns into a second formula rather
    /// than an edge case — and this is where that is decided.
    #[test]
    fn a_ramp_that_goes_nowhere_is_built_as_a_steady_stretch() {
        let marks = [mark(0, 120.0, Curve::Ramp), mark(16, 120.0, Curve::Hold)];
        let mut room = [Segment::default(); 2];
        // Exactly eight seconds, not nearly: the logarithmic form cannot
        // produce that here, it produces a NaN. The shape below says the same
        // thing directly, and is read after the map's last use because the map
        // borrows the buffer it was written into.
        let map = build(&marks, &mut room).unwrap();
        assert_eq!(map.seconds_at(Position::quarters(16)), 8.0);

        assert_eq!(
            room[0].shape,
            Shape::Steady,
            "a rate of zero reached the map"
        );
    }

    /// And a ramp too shallow to be worth a logarithm goes the same way — below
    /// the crossover a straight line is the more accurate of the two answers,
    /// so the choice is made here rather than per quantum.
    #[test]
    fn a_ramp_below_the_crossover_is_built_as_a_steady_stretch() {
        let mut room = [Segment::default(); 2];

        let shallow = 120.0 + 120.0 * FLAT / 2.0;
        let marks = [mark(0, 120.0, Curve::Ramp), mark(16, shallow, Curve::Hold)];
        let seconds = build(&marks, &mut room)
            .unwrap()
            .seconds_at(Position::quarters(16));
        assert!(seconds.is_finite(), "the shallow ramp gave {seconds}");
        assert_eq!(room[0].shape, Shape::Steady);

        // And just above it the logarithm is still what runs, so the crossover
        // is a crossover rather than a floor everything falls through.
        let steep = 120.0 + 120.0 * FLAT * 100.0;
        let marks = [mark(0, 120.0, Curve::Ramp), mark(16, steep, Curve::Hold)];
        build(&marks, &mut room).unwrap();
        assert!(matches!(room[0].shape, Shape::Ramp { .. }));
    }

    /// Running a ramp backwards would take the tempo through zero and the
    /// logarithm with it. A count-in wants the tempo it counts in at anyway.
    #[test]
    fn before_the_first_mark_the_first_tempo_is_held() {
        let marks = [mark(0, 120.0, Curve::Ramp), mark(16, 140.0, Curve::Hold)];
        let mut room = [Segment::default(); 2];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.seconds_at(Position::quarters(-4)), -2.0);
        assert_eq!(map.position_at(-2.0), Position::quarters(-4));
    }

    /// Time only goes forwards, whatever the tempo does.
    #[test]
    fn seconds_never_go_backwards() {
        let marks = [
            mark(0, 200.0, Curve::Ramp),
            mark(8, 40.0, Curve::Hold),
            mark(24, 300.0, Curve::Ramp),
            mark(32, 41.0, Curve::Hold),
        ];
        let mut room = [Segment::default(); 4];
        let map = build(&marks, &mut room).unwrap();

        let mut previous = f64::NEG_INFINITY;
        for tick in (-8 * TICKS_PER_QUARTER..48 * TICKS_PER_QUARTER)
            .step_by(TICKS_PER_QUARTER as usize / 13)
        {
            let seconds = map.seconds_at(Position::from_ticks(tick));
            assert!(seconds.is_finite(), "tick {tick} gave {seconds}");
            assert!(seconds > previous, "time went backwards at tick {tick}");
            previous = seconds;
        }
    }

    /// The value §2.5 named as the one that must never reach a position: it is
    /// false against everything, sorts nowhere, and becomes tick zero silently.
    #[test]
    fn a_moment_that_is_not_a_number_does_not_become_one() {
        let marks = [mark(0, 120.0, Curve::Ramp), mark(16, 140.0, Curve::Hold)];
        let mut room = [Segment::default(); 2];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.position_at(f64::NAN), Position::ZERO);
        // The infinities are not refused: past the end of time is a direction,
        // and saturating is the honest answer to it.
        assert_eq!(map.position_at(f64::INFINITY).ticks(), i64::MAX);
        assert_eq!(map.position_at(f64::NEG_INFINITY).ticks(), i64::MIN);
    }

    #[test]
    fn marks_that_do_not_describe_a_map_are_refused() {
        let mut room = [Segment::default(); 4];

        assert_eq!(build(&[], &mut room), Err(BuildError::Empty));

        let late = [mark(4, 120.0, Curve::Hold)];
        assert_eq!(
            build(&late, &mut room),
            Err(BuildError::NotAtOrigin {
                at: Position::quarters(4)
            })
        );

        for backwards in [
            [mark(0, 120.0, Curve::Hold), mark(0, 130.0, Curve::Hold)],
            [mark(0, 120.0, Curve::Hold), mark(-4, 130.0, Curve::Hold)],
        ] {
            assert_eq!(
                build(&backwards, &mut room),
                Err(BuildError::OutOfOrder { index: 1 })
            );
        }

        for bad in [0.0, -120.0, f64::NAN, f64::INFINITY] {
            let marks = [mark(0, 120.0, Curve::Hold), mark(4, bad, Curve::Hold)];
            // Compared by bits rather than by value, because one of these is a
            // NaN and a NaN is not equal to itself — which is why it is on the
            // list of tempi to refuse in the first place.
            match build(&marks, &mut room) {
                Err(BuildError::Tempo {
                    index: 1,
                    beats_per_minute,
                }) if beats_per_minute.to_bits() == bad.to_bits() => {}
                other => panic!("{bad} was answered with {other:?}"),
            }
        }

        let marks = [mark(0, 120.0, Curve::Hold), mark(4, 130.0, Curve::Hold)];
        let mut cramped = [Segment::default(); 1];
        assert_eq!(
            build(&marks, &mut cramped),
            Err(BuildError::TooSmall { marks: 2, room: 1 })
        );
    }

    /// Read by whoever is looking at a project that will not open, as with the
    /// handshake's errors in `escapement-protocol`.
    #[test]
    fn every_build_error_says_what_went_wrong() {
        for error in [
            BuildError::Empty,
            BuildError::NotAtOrigin {
                at: Position::quarters(4),
            },
            BuildError::OutOfOrder { index: 2 },
            BuildError::Tempo {
                index: 1,
                beats_per_minute: 0.0,
            },
            BuildError::TooSmall { marks: 4, room: 2 },
        ] {
            assert!(std::format!("{error}").len() > 20, "{error:?} says nothing");
        }
    }

    #[test]
    fn the_failure_is_an_error() {
        const fn assert_error<E: core::error::Error>() {}
        assert_error::<BuildError>();
    }

    /// A buffer longer than the marks is not an error, and the map must cover
    /// what was written rather than what was offered.
    ///
    /// Asked of the answers rather than of a length, because that is where it
    /// would go wrong: an untouched segment starts at the origin like the first
    /// one and carries no tempo at all, so a map that reached into the spare
    /// room would find one of those, divide by its zero and answer infinity.
    #[test]
    fn a_roomy_buffer_leaves_the_map_the_size_of_its_marks() {
        let marks = [mark(0, 120.0, Curve::Hold), mark(4, 60.0, Curve::Hold)];
        let mut room = [Segment::default(); 8];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.seconds_at(Position::quarters(2)), 1.0);
        assert_eq!(map.seconds_at(Position::quarters(8)), 6.0);
    }
}
