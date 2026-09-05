//! The bar map: which bar and beat a position falls in, where a bar starts, and
//! which signature is in force there.
//!
//! A signature steps at a bar line and is never interpolated (ARCHITECTURE.md
//! §2.5), so a mark is addressed by the bar it takes effect at rather than by a
//! position — a mark that cannot be spelled off a bar line has no invariant left
//! to survive a merge. Positions come out of the map by accumulation instead.
//!
//! Built on one side and read on the other, as [`crate::tempo`] is and for the
//! same reason. The arithmetic differs in one way worth knowing: there is no
//! `f64` anywhere in it. A bar line is a whole number of ticks, so nothing here
//! drifts, and a position that goes out as a bar and a beat comes back as the
//! tick it started on.

use core::fmt;

use crate::{Position, Span, TICKS_PER_QUARTER};

/// Ticks in a whole note, which is what a signature's denominator divides.
const TICKS_PER_WHOLE: i64 = 4 * TICKS_PER_QUARTER;

/// Where the counting starts.
///
/// Bar numbers are read off a transport by a person, and a person starts at one.
/// The map does the arithmetic on the inside so that no caller has to remember
/// the offset — the one that forgets is the one that draws the ruler.
pub const FIRST_BAR: i64 = 1;

/// A time signature: `numerator` notes of one `denominator`th to the bar.
///
/// Constructed rather than written, because the type carries a promise: a bar is
/// a whole number of ticks. That holds only while the denominator divides a
/// whole note, and checking it once here is what keeps every later division
/// exact and every later divisor above zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meter {
    numerator: u16,
    denominator: u16,
}

impl Meter {
    /// Four quarters, where a project starts and stays until told otherwise.
    pub const FOUR_FOUR: Self = Self {
        numerator: 4,
        denominator: 4,
    };

    /// `None` for a signature this grid cannot hold exactly, rather than the
    /// nearest one that fits.
    ///
    /// Refused: a denominator that does not divide a whole note — every power of
    /// two through 512 does, and so do thirds, fifths, sevenths, elevenths and
    /// thirteenths, which is past anything a signature has ever asked for — and
    /// a bar of no beats, which has no length to divide by. Rounding either
    /// would answer a question nobody asked, the way
    /// [`Span::quarter_fraction`](crate::Span::quarter_fraction) declines to.
    #[must_use]
    pub const fn new(numerator: u16, denominator: u16) -> Option<Self> {
        if numerator == 0 || denominator == 0 {
            return None;
        }
        if TICKS_PER_WHOLE % denominator as i64 != 0 {
            return None;
        }
        Some(Self {
            numerator,
            denominator,
        })
    }

    /// Beats to the bar — the number on top.
    #[must_use]
    pub const fn numerator(self) -> u16 {
        self.numerator
    }

    /// What one of them is — the number underneath.
    #[must_use]
    pub const fn denominator(self) -> u16 {
        self.denominator
    }

    /// One beat: a single unit of the denominator, so 6/8 has six of them.
    ///
    /// **Not the beat [`tempo::Mark::beats_per_minute`](crate::tempo::Mark) counts**,
    /// which is a quarter note whatever the signature says (§2.5). The two maps
    /// are independent precisely because those two beats are different things —
    /// make this one the unit of tempo and every conversion to seconds has to
    /// consult this map first.
    #[must_use]
    pub const fn beat(self) -> Span {
        // Exact by construction, and the reason `new` is the only way in.
        Span::from_ticks(TICKS_PER_WHOLE / self.denominator as i64)
    }

    /// One bar: [`Meter::numerator`] beats of it.
    #[must_use]
    pub const fn bar(self) -> Span {
        // A whole note is under 2^25 ticks and the numerator under 2^16, so the
        // widest bar expressible is around 2^41 — the multiplication cannot
        // overflow, whatever a document hands to `new`.
        Span::from_ticks(self.beat().ticks() * self.numerator as i64)
    }
}

impl Default for Meter {
    fn default() -> Self {
        Self::FOUR_FOUR
    }
}

impl fmt::Display for Meter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.numerator, self.denominator)
    }
}

/// A signature mark: from this bar, this signature, until the next mark.
///
/// The bar rather than a position, and that is the decision §2.5 records: bars
/// before it can be made longer or shorter without this mark landing somewhere a
/// signature cannot start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    /// The first bar it applies to.
    pub from_bar: i64,
    /// What that bar is in.
    pub meter: Meter,
}

/// Where something sits, the way a transport says it: bar, beat, and how far
/// past the beat.
///
/// Bars and beats both count from one. `into_beat` is what is left, which is
/// what makes the address exact rather than a label — a note off the grid has
/// one too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BarBeat {
    /// Counting from [`FIRST_BAR`], and below it before the origin.
    pub bar: i64,
    /// Counting from one, in units of the signature's denominator.
    pub beat: i64,
    /// Past the start of that beat.
    pub into_beat: Span,
}

/// One stretch of the map, with everything a lookup needs already worked out.
///
/// Produced by [`build`], and public only because the caller owns the buffer
/// these are written into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    start: Position,
    start_bar: i64,
    bar: Span,
    beat: Span,
    meter: Meter,
}

impl Segment {
    const fn new(start: Position, start_bar: i64, meter: Meter) -> Self {
        Self {
            start,
            start_bar,
            bar: meter.bar(),
            beat: meter.beat(),
            meter,
        }
    }
}

/// A segment that says nothing and is usable anyway. Two places need one: the
/// spare room in a caller's buffer, and a lookup against a map with no segments
/// — which [`build`] refuses to produce, so that one is the second lock rather
/// than the first.
///
/// Usable rather than blank, and that is not decoration: a lookup divides by a
/// bar and by a beat, and an integer division by zero panics — which nothing
/// reachable from the audio thread may do (`.claude/rules/rt-safety.md`).
const UNMARKED: Segment = Segment::new(Position::ZERO, FIRST_BAR, Meter::FOUR_FOUR);

impl Default for Segment {
    fn default() -> Self {
        UNMARKED
    }
}

/// A bar map, read-only, over segments someone else is holding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeterMap<'a> {
    segments: &'a [Segment],
}

impl MeterMap<'_> {
    /// Which bar and beat `position` falls in.
    ///
    /// Before the map's first bar the first signature is held rather than
    /// stopped at, giving bar zero and the ones below it — the same answer
    /// [`TempoMap`](crate::tempo::TempoMap) gives a count-in, for the same
    /// reason: something has to be counted in.
    #[must_use]
    pub fn bar_beat_at(&self, position: Position) -> BarBeat {
        let segment = self.segment_at(position);
        let into_segment = (position - segment.start).ticks();

        // Floored rather than truncated, and that is the whole of what makes a
        // count-in work: truncation rounds towards zero, which would put the bar
        // before the first one at bar one as well, twice over.
        let bars = into_segment.div_euclid(segment.bar.ticks());
        let into_bar = into_segment.rem_euclid(segment.bar.ticks());

        BarBeat {
            bar: segment.start_bar.saturating_add(bars),
            beat: into_bar / segment.beat.ticks() + 1,
            into_beat: Span::from_ticks(into_bar % segment.beat.ticks()),
        }
    }

    /// Where `address` is — the inverse of [`MeterMap::bar_beat_at`], exactly.
    ///
    /// A beat past the end of its bar is not refused: it runs on in beats of
    /// *that* bar, so bar 1 beat 5 of a map in 4/4 is where bar 2 starts. The
    /// address is unambiguous, and a transport stepping a beat at a time is
    /// better served by an answer than by an error.
    #[must_use]
    pub fn position_at(&self, address: BarBeat) -> Position {
        let segment = self.segment_for_bar(address.bar);
        let bars = address.bar.saturating_sub(segment.start_bar);
        let beats = address.beat.saturating_sub(1);

        segment.start + segment.bar * bars + segment.beat * beats + address.into_beat
    }

    /// Where bar `bar` starts — what a grid is drawn on and a pattern is
    /// measured in.
    ///
    /// The first beat of it, asked for that way rather than counted again: how
    /// bars accumulate is one piece of arithmetic and wants one copy.
    #[must_use]
    pub fn bar_start(&self, bar: i64) -> Position {
        self.position_at(BarBeat {
            bar,
            beat: 1,
            into_beat: Span::ZERO,
        })
    }

    /// The signature in force at `position` — which beat a metronome accents,
    /// and what a ruler writes above the bar line.
    #[must_use]
    pub fn meter_at(&self, position: Position) -> Meter {
        self.segment_at(position).meter
    }

    fn segment_at(&self, position: Position) -> &Segment {
        let found = self
            .segments
            .partition_point(|segment| segment.start <= position)
            .saturating_sub(1);
        self.segments.get(found).unwrap_or(&UNMARKED)
    }

    fn segment_for_bar(&self, bar: i64) -> &Segment {
        let found = self
            .segments
            .partition_point(|segment| segment.start_bar <= bar)
            .saturating_sub(1);
        self.segments.get(found).unwrap_or(&UNMARKED)
    }
}

/// Works `marks` out into `into`, and hands back a map over what was written.
///
/// The half that accumulates: a mark says which bar it starts at, and where that
/// bar falls depends on every signature in front of it. Doing it here is what
/// leaves a lookup a search and two divisions.
///
/// `into` needs one [`Segment`] per mark.
///
/// # Errors
///
/// [`BuildError`], for marks that do not describe a map: none at all, not
/// starting at [`FIRST_BAR`], out of order, or a buffer too small to hold the
/// answer. Not for a signature that makes no sense — [`Meter::new`] is where
/// that is turned away, so a `Meter` that exists is one a bar can be built from.
pub fn build<'a>(marks: &[Mark], into: &'a mut [Segment]) -> Result<MeterMap<'a>, BuildError> {
    let Some(first) = marks.first() else {
        return Err(BuildError::Empty);
    };
    if into.len() < marks.len() {
        return Err(BuildError::TooSmall {
            marks: marks.len(),
            room: into.len(),
        });
    }
    if first.from_bar != FIRST_BAR {
        return Err(BuildError::NotAtFirstBar { at: first.from_bar });
    }
    for (index, mark) in marks.iter().enumerate() {
        if index > 0 && mark.from_bar <= marks[index - 1].from_bar {
            return Err(BuildError::OutOfOrder { index });
        }
    }

    let mut start = Position::ZERO;
    for (index, mark) in marks.iter().enumerate() {
        let segment = Segment::new(start, mark.from_bar, mark.meter);
        into[index] = segment;

        if let Some(next) = marks.get(index + 1) {
            // Saturating, and unreachable in the same breath: an `i64` of ticks
            // holds four hundred billion bars of 4/4, so the clamp is what
            // happens past the end of time rather than in a song.
            start = start + segment.bar * next.from_bar.saturating_sub(mark.from_bar);
        }
    }

    Ok(MeterMap {
        segments: &into[..marks.len()],
    })
}

/// Why marks did not describe a bar map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildError {
    /// No marks at all. A map has to say what the signature is somewhere.
    Empty,
    /// The first mark is not at [`FIRST_BAR`], so the start of the timeline has
    /// no signature.
    NotAtFirstBar {
        /// Which bar the first mark was at.
        at: i64,
    },
    /// A mark at or before the one in front of it.
    OutOfOrder {
        /// Which mark.
        index: usize,
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
            Self::Empty => f.write_str("a bar map needs at least one signature"),
            Self::NotAtFirstBar { at } => write!(
                f,
                "the first signature is at bar {at}, leaving the start of the timeline without one"
            ),
            Self::OutOfOrder { index } => {
                write!(f, "signature {index} is not after the one before it")
            }
            Self::TooSmall { marks, room } => write!(
                f,
                "{marks} marks need {marks} segments and there is room for {room}"
            ),
        }
    }
}

impl core::error::Error for BuildError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn meter(numerator: u16, denominator: u16) -> Meter {
        Meter::new(numerator, denominator).expect("a signature the grid holds")
    }

    fn mark(from_bar: i64, numerator: u16, denominator: u16) -> Mark {
        Mark {
            from_bar,
            meter: meter(numerator, denominator),
        }
    }

    /// Three signatures, one of them odd and one of them compound, so that the
    /// bars after a change are somewhere the arithmetic of the bars before it
    /// would not have put them.
    fn marks() -> [Mark; 3] {
        [mark(1, 4, 4), mark(5, 7, 8), mark(9, 3, 4)]
    }

    #[test]
    fn a_signature_says_how_long_a_bar_and_a_beat_are() {
        assert_eq!(Meter::FOUR_FOUR.beat(), Span::QUARTER);
        assert_eq!(Meter::FOUR_FOUR.bar(), Span::quarters(4));

        let eighth = Span::quarter_fraction(1, 2).expect("a quarter halves");
        assert_eq!(meter(6, 8).beat(), eighth);
        assert_eq!(meter(6, 8).bar(), Span::quarters(3));
        assert_eq!(meter(7, 8).bar(), eighth * 7);
    }

    /// The claim §2.5's resolution makes, from the outside: a bar is a whole
    /// number of ticks for every signature anyone writes. 512 is where the
    /// binary half of that runs out, and running out is the interesting end.
    #[test]
    fn every_denominator_a_signature_uses_divides_a_whole_note() {
        let mut denominator: u16 = 1;
        while denominator <= 512 {
            let signature = meter(4, denominator);
            assert_eq!(
                signature.beat() * i64::from(denominator),
                Span::quarters(4),
                "a whole note does not divide into {denominator}ths"
            );
            denominator *= 2;
        }

        // Not only powers of two: the resolution's odd factors are signatures a
        // score can ask for, and they land as well.
        for odd in [3, 5, 7, 11, 13] {
            assert_eq!(
                meter(4, odd).beat() * i64::from(odd),
                Span::quarters(4),
                "a whole note does not divide into {odd}ths"
            );
        }
    }

    /// A signature says what it was made of — the pair a ruler writes above the
    /// bar line and a metronome counts in. Trivial, and untested until a mutant
    /// pointed out that a denominator of one would have gone unnoticed.
    #[test]
    fn a_signature_reports_the_pair_it_was_made_of() {
        for (numerator, denominator) in [(4, 4), (7, 8), (3, 4), (12, 8), (1, 512)] {
            let signature = meter(numerator, denominator);
            assert_eq!(signature.numerator(), numerator);
            assert_eq!(signature.denominator(), denominator);
        }
    }

    /// The other side of it, and the reason `Meter` is constructed rather than
    /// written: past the grid there is no bar length to round to.
    #[test]
    fn a_signature_the_grid_cannot_hold_is_refused() {
        for denominator in [1024, 2048, 0] {
            assert_eq!(
                Meter::new(4, denominator),
                None,
                "a bar of {denominator}ths was invented"
            );
        }
        assert_eq!(Meter::new(0, 4), None, "a bar of no beats");
    }

    #[test]
    fn the_origin_is_bar_one_beat_one() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        assert_eq!(
            map.bar_beat_at(Position::ZERO),
            BarBeat {
                bar: FIRST_BAR,
                beat: 1,
                into_beat: Span::ZERO,
            }
        );
        assert_eq!(map.bar_start(FIRST_BAR), Position::ZERO);
    }

    /// What a signature change is for, in numbers anyone can check: four bars of
    /// four quarters, then four of seven eighths, then threes.
    #[test]
    fn a_signature_change_moves_every_bar_after_it() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        assert_eq!(map.bar_start(5), Position::quarters(16));
        assert_eq!(map.bar_start(9), Position::quarters(30));
        assert_eq!(map.bar_start(10), Position::quarters(33));

        // And the bar line is where the address says it is, which is the half a
        // ruler and a transport have to agree on.
        for bar in [1, 2, 5, 6, 9, 12] {
            assert_eq!(
                map.bar_beat_at(map.bar_start(bar)),
                BarBeat {
                    bar,
                    beat: 1,
                    into_beat: Span::ZERO,
                },
                "bar {bar} does not start at its own bar line"
            );
        }
    }

    /// A beat is one unit of the denominator (§2.5), so 6/8 is six beats and not
    /// two dotted ones. The grouping a compound signature is felt in is accent
    /// and drawing; it is not this.
    #[test]
    fn a_beat_is_one_unit_of_the_denominator() {
        let marks = [mark(1, 6, 8)];
        let mut room = [Segment::default(); 1];
        let map = build(&marks, &mut room).unwrap();

        let last = map.bar_beat_at(map.bar_start(2) - Span::from_ticks(1));
        assert_eq!(last.bar, 1);
        assert_eq!(
            last.beat, 6,
            "6/8 was counted in something other than eighths"
        );
    }

    /// The pair §2.5 asks of a time model, in this map's units: a position out
    /// as a bar and a beat comes back the tick it was. Exact rather than close,
    /// because none of this is floating point.
    #[test]
    fn a_position_survives_the_trip_through_bars_and_beats() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        for tick in (-8 * TICKS_PER_QUARTER..40 * TICKS_PER_QUARTER)
            .step_by(TICKS_PER_QUARTER as usize / 97)
        {
            let there = Position::from_ticks(tick);
            let address = map.bar_beat_at(there);
            assert_eq!(
                map.position_at(address),
                there,
                "tick {tick} came back elsewhere"
            );

            // And the address is one a display can show: the beat is inside its
            // bar and the remainder inside its beat, at every tick rather than
            // only on the ones that land on a line.
            let signature = map.meter_at(there);
            assert!(
                (1..=i64::from(signature.numerator())).contains(&address.beat),
                "tick {tick} is beat {} of a {signature}",
                address.beat
            );
            assert!(
                address.into_beat < signature.beat(),
                "tick {tick} spills its beat"
            );
            assert!(
                address.into_beat >= Span::ZERO,
                "tick {tick} sits behind its beat"
            );
        }
    }

    /// And the other direction, which is what typing a bar into a transport
    /// does.
    #[test]
    fn an_address_survives_the_trip_through_a_position() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        for bar in 1..=12 {
            let signature = map.meter_at(map.bar_start(bar));
            for beat in 1..=i64::from(signature.numerator()) {
                let address = BarBeat {
                    bar,
                    beat,
                    into_beat: Span::from_ticks(signature.beat().ticks() / 3),
                };
                assert_eq!(map.bar_beat_at(map.position_at(address)), address);
            }
        }
    }

    /// A count-in sits before the first bar, so the map answers there rather
    /// than stopping — the same rule the tempo map follows behind its first
    /// mark, and the reason the division is floored.
    #[test]
    fn bars_before_the_first_hold_the_first_signature() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        assert_eq!(map.bar_start(0), Position::quarters(-4));
        assert_eq!(map.bar_start(-1), Position::quarters(-8));
        assert_eq!(map.meter_at(Position::quarters(-4)), Meter::FOUR_FOUR);

        // One tick before the origin is the last tick of bar zero, not the
        // first of bar one over again.
        assert_eq!(
            map.bar_beat_at(Position::from_ticks(-1)),
            BarBeat {
                bar: 0,
                beat: 4,
                into_beat: Span::from_ticks(TICKS_PER_QUARTER - 1),
            }
        );
    }

    /// Documented behaviour rather than an accident: an address past the end of
    /// its bar runs on in that bar's beats.
    #[test]
    fn a_beat_past_the_end_of_its_bar_runs_on() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        for (bar, beat, lands_on) in [(1, 5, 2), (4, 5, 5), (5, 8, 6)] {
            let address = BarBeat {
                bar,
                beat,
                into_beat: Span::ZERO,
            };
            assert_eq!(
                map.position_at(address),
                map.bar_start(lands_on),
                "bar {bar} beat {beat} is not where bar {lands_on} starts"
            );
        }
    }

    /// The signature a metronome accents and a ruler labels, which is the one in
    /// force rather than the one that comes next.
    #[test]
    fn the_signature_in_force_is_the_last_one_marked() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        assert_eq!(map.meter_at(Position::ZERO), meter(4, 4));
        assert_eq!(
            map.meter_at(map.bar_start(5) - Span::from_ticks(1)),
            meter(4, 4)
        );
        assert_eq!(map.meter_at(map.bar_start(5)), meter(7, 8));
        assert_eq!(map.meter_at(map.bar_start(9)), meter(3, 4));
    }

    /// Nothing here is floating point, so the ten-thousandth bar is exactly
    /// where counting says and not a tick beside it. The claim the whole design
    /// rests on, asked far enough out that drift would show.
    #[test]
    fn a_bar_line_far_out_is_exactly_where_counting_puts_it() {
        let marks = [mark(1, 4, 4), mark(2, 7, 8)];
        let mut room = [Segment::default(); 2];
        let map = build(&marks, &mut room).unwrap();

        let bars = 100_000;
        let expected = Position::quarters(4) + meter(7, 8).bar() * (bars - 1);
        assert_eq!(map.bar_start(bars + 1), expected);
        assert_eq!(map.bar_beat_at(expected).bar, bars + 1);
    }

    #[test]
    fn marks_that_do_not_describe_a_map_are_refused() {
        let mut room = [Segment::default(); 4];

        assert_eq!(build(&[], &mut room), Err(BuildError::Empty));

        let late = [mark(4, 4, 4)];
        assert_eq!(
            build(&late, &mut room),
            Err(BuildError::NotAtFirstBar { at: 4 })
        );

        for backwards in [
            [mark(1, 4, 4), mark(1, 3, 4)],
            [mark(1, 4, 4), mark(0, 3, 4)],
        ] {
            assert_eq!(
                build(&backwards, &mut room),
                Err(BuildError::OutOfOrder { index: 1 })
            );
        }

        let marks = [mark(1, 4, 4), mark(5, 3, 4)];
        let mut cramped = [Segment::default(); 1];
        assert_eq!(
            build(&marks, &mut cramped),
            Err(BuildError::TooSmall { marks: 2, room: 1 })
        );
    }

    /// Read by whoever is looking at a project that will not open.
    #[test]
    fn every_build_error_says_what_went_wrong() {
        for error in [
            BuildError::Empty,
            BuildError::NotAtFirstBar { at: 4 },
            BuildError::OutOfOrder { index: 2 },
            BuildError::TooSmall { marks: 4, room: 2 },
        ] {
            assert!(std::format!("{error}").len() > 20, "{error:?} says nothing");
        }
        assert_eq!(std::format!("{}", meter(7, 8)), "7/8");
    }

    #[test]
    fn the_failure_is_an_error() {
        const fn assert_error<E: core::error::Error>() {}
        assert_error::<BuildError>();
    }

    /// A buffer longer than the marks is not an error, and the map must cover
    /// what was written rather than what was offered — an untouched segment
    /// starts at bar one like the first one does.
    #[test]
    fn a_roomy_buffer_leaves_the_map_the_size_of_its_marks() {
        let marks = [mark(1, 4, 4), mark(5, 7, 8)];
        let mut room = [Segment::default(); 8];
        let map = build(&marks, &mut room).unwrap();

        assert_eq!(map.bar_start(5), Position::quarters(16));
        assert_eq!(map.bar_start(6), Position::quarters(16) + meter(7, 8).bar());
        assert_eq!(map.meter_at(Position::quarters(20)), meter(7, 8));
    }

    /// Unreachable in any project — four hundred billion bars of 4/4 fit — but
    /// the audio thread may not panic, so the edge is defined rather than left
    /// to an overflow check that only exists in a debug build.
    #[test]
    fn arithmetic_clamps_rather_than_panicking() {
        let mut room = [Segment::default(); 3];
        let map = build(&marks(), &mut room).unwrap();

        assert_eq!(map.bar_start(i64::MAX).ticks(), i64::MAX);
        assert_eq!(map.bar_start(i64::MIN).ticks(), i64::MIN);
        assert_eq!(
            map.position_at(BarBeat {
                bar: i64::MAX,
                beat: i64::MAX,
                into_beat: Span::from_ticks(i64::MAX),
            })
            .ticks(),
            i64::MAX
        );

        // Far out but short of the edge, the address is still the bar holding
        // the position — asked of the map against itself rather than against a
        // number worked out here, which would only restate the arithmetic.
        let far = Position::from_ticks(i64::MAX / 2);
        let address = map.bar_beat_at(far);
        assert!(map.bar_start(address.bar) <= far);
        assert!(far < map.bar_start(address.bar + 1));

        // And at the edge itself nothing wraps into the distant past, which is
        // the failure saturation exists to prevent.
        assert!(map.bar_beat_at(Position::from_ticks(i64::MAX)).bar > 0);
        assert!(map.bar_beat_at(Position::from_ticks(i64::MIN)).bar < 0);
    }
}
