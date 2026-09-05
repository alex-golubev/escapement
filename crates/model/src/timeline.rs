//! The tempo and the signature, as the document holds them.
//!
//! **Both maps are keyed, never listed** (§2.5): signatures by bar, tempi by
//! position. A merge can put two marks in one place and neither `build` takes
//! two of them, so under a list that duplicate is representable — and what it
//! produces is a project that stops opening, for both people at once, because
//! they converged on it.
//!
//! **The mark that opens each map is a field rather than an entry**, and that
//! is the second half of the same problem. Both maps must begin at the
//! beginning: `tempo::build` refuses marks that do not start at the origin, and
//! `meter::build` refuses marks that do not start at the first bar. As an entry
//! the opening mark is one somebody can move or delete — one edit, merged, and
//! the project no longer opens. As a field there is nothing to delete.
//!
//! Between the two, and with a tempo that cannot be built holding a value that
//! is not a tempo, **no document reachable from here produces a map that
//! refuses to build**. That is the property worth having, and it is structural
//! rather than checked.
//!
//! A key is an address, and the value under it does not repeat it: what a merge
//! could then disagree with itself about is exactly what `build` reads.

use std::collections::BTreeMap;

use escapement_time::meter::{self, Meter, FIRST_BAR};
use escapement_time::tempo::{self, Curve};
use escapement_time::Position;

/// A tempo, and what it does on the way to the next one.
///
/// Held apart from [`tempo::Mark`] because a mark carries the position it takes
/// effect at, and here that position is the key.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tempo {
    beats_per_minute: f64,
    curve: Curve,
}

impl Tempo {
    /// Where a project starts until somebody says otherwise.
    pub const DEFAULT: Self = Self {
        beats_per_minute: 120.0,
        curve: Curve::Hold,
    };

    /// `None` for what is not a tempo: zero, negative, infinite, or not a
    /// number.
    ///
    /// Turned away here because `tempo::build` turns it away too, and there it
    /// is a map that will not build — which is to say a project that will not
    /// open. Refused at the door, the refusal costs one entry rather than the
    /// document.
    #[must_use]
    pub fn new(beats_per_minute: f64, curve: Curve) -> Option<Self> {
        if beats_per_minute.is_finite() && beats_per_minute > 0.0 {
            Some(Self {
                beats_per_minute,
                curve,
            })
        } else {
            None
        }
    }

    /// Quarter notes per minute, whatever the signature says (§2.5).
    #[must_use]
    pub fn beats_per_minute(self) -> f64 {
        self.beats_per_minute
    }

    /// What happens between here and the next mark.
    #[must_use]
    pub fn curve(self) -> Curve {
        self.curve
    }
}

/// What the project's clock does: where it starts, and where it changes.
#[derive(Clone, Debug, PartialEq)]
pub struct Timeline {
    tempo: Tempo,
    tempo_changes: BTreeMap<Position, Tempo>,
    meter: Meter,
    meter_changes: BTreeMap<i64, Meter>,
}

impl Timeline {
    /// One tempo and one signature, from the origin onwards.
    #[must_use]
    pub fn new(tempo: Tempo, meter: Meter) -> Self {
        Self {
            tempo,
            tempo_changes: BTreeMap::new(),
            meter,
            meter_changes: BTreeMap::new(),
        }
    }

    /// The same, with the changes that follow.
    #[must_use]
    pub fn with_changes(
        tempo: Tempo,
        tempo_changes: BTreeMap<Position, Tempo>,
        meter: Meter,
        meter_changes: BTreeMap<i64, Meter>,
    ) -> Self {
        Self {
            tempo,
            tempo_changes,
            meter,
            meter_changes,
        }
    }

    /// The tempo the project opens at.
    #[must_use]
    pub fn tempo(&self) -> Tempo {
        self.tempo
    }

    /// The signature it opens in.
    #[must_use]
    pub fn meter(&self) -> Meter {
        self.meter
    }

    /// The marks a tempo map is built from, in the order `build` wants them.
    ///
    /// The opening mark first, then the changes after the origin. **A change at
    /// or before the origin is dropped**, and that is not a repair: the opening
    /// mark is already there, so a second one at the origin is two marks in one
    /// place, and one before it is a tempo for a stretch of timeline the map
    /// holds behind its first mark anyway.
    #[must_use]
    pub fn tempo_marks(&self) -> Vec<tempo::Mark> {
        let opening = tempo::Mark {
            at: Position::ZERO,
            beats_per_minute: self.tempo.beats_per_minute(),
            curve: self.tempo.curve(),
        };

        core::iter::once(opening)
            .chain(
                self.tempo_changes
                    .iter()
                    .filter(|(at, _)| **at > Position::ZERO)
                    .map(|(at, tempo)| tempo::Mark {
                        at: *at,
                        beats_per_minute: tempo.beats_per_minute(),
                        curve: tempo.curve(),
                    }),
            )
            .collect()
    }

    /// The marks a bar map is built from, in the order `build` wants them.
    ///
    /// The opening signature first, then the changes after the first bar, and a
    /// change at or before it dropped for the reason above.
    #[must_use]
    pub fn meter_marks(&self) -> Vec<meter::Mark> {
        let opening = meter::Mark {
            from_bar: FIRST_BAR,
            meter: self.meter,
        };

        core::iter::once(opening)
            .chain(
                self.meter_changes
                    .iter()
                    .filter(|(bar, _)| **bar > FIRST_BAR)
                    .map(|(bar, meter)| meter::Mark {
                        from_bar: *bar,
                        meter: *meter,
                    }),
            )
            .collect()
    }
}

impl Default for Timeline {
    fn default() -> Self {
        Self::new(Tempo::DEFAULT, Meter::FOUR_FOUR)
    }
}

#[cfg(test)]
mod tests {
    use escapement_time::Span;

    use super::*;

    fn tempo(beats_per_minute: f64) -> Tempo {
        Tempo::new(beats_per_minute, Curve::Hold).expect("a tempo is a tempo")
    }

    fn three_four() -> Meter {
        Meter::new(3, 4).expect("three quarters is a signature")
    }

    /// The property the whole module is shaped around: whatever is in the
    /// document, both maps build.
    fn both_maps_build(timeline: &Timeline) {
        let mut tempi = [tempo::Segment::default(); 8];
        let mut bars = [meter::Segment::default(); 8];

        assert!(
            tempo::build(&timeline.tempo_marks(), &mut tempi).is_ok(),
            "the tempo map refused to build"
        );
        assert!(
            meter::build(&timeline.meter_marks(), &mut bars).is_ok(),
            "the bar map refused to build"
        );
    }

    #[test]
    fn a_project_opens_at_a_hundred_and_twenty_in_four_four() {
        let timeline = Timeline::default();

        assert_eq!(timeline.tempo().beats_per_minute(), 120.0);
        assert_eq!(timeline.tempo().curve(), Curve::Hold);
        assert_eq!(timeline.meter(), Meter::FOUR_FOUR);
        both_maps_build(&timeline);
    }

    #[test]
    fn what_is_not_a_tempo_is_refused() {
        assert_eq!(Tempo::new(0.0, Curve::Hold), None, "zero");
        assert_eq!(Tempo::new(-120.0, Curve::Hold), None, "negative");
        assert_eq!(Tempo::new(f64::INFINITY, Curve::Hold), None, "infinite");
        assert_eq!(Tempo::new(f64::NAN, Curve::Hold), None, "not a number");
        assert_eq!(tempo(120.0).beats_per_minute(), 120.0);
    }

    #[test]
    fn a_ramp_is_carried_as_written() {
        let ramp = Tempo::new(90.0, Curve::Ramp).expect("a tempo is a tempo");

        assert_eq!(ramp.curve(), Curve::Ramp);
        assert_eq!(Tempo::DEFAULT.curve(), Curve::Hold);
    }

    #[test]
    fn the_first_mark_of_each_map_is_the_one_the_project_opens_with() {
        let timeline = Timeline::new(tempo(90.0), three_four());

        assert_eq!(timeline.tempo().beats_per_minute(), 90.0);
        assert_eq!(
            timeline.meter(),
            three_four(),
            "and not the signature a project opens in by default"
        );

        let tempi = timeline.tempo_marks();
        assert_eq!(tempi.len(), 1);
        assert_eq!(tempi[0].at, Position::ZERO);
        assert_eq!(tempi[0].beats_per_minute, 90.0);

        let bars = timeline.meter_marks();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].from_bar, FIRST_BAR);
        assert_eq!(bars[0].meter, three_four());
    }

    #[test]
    fn changes_follow_the_opening_mark_in_order() {
        let timeline = Timeline::with_changes(
            tempo(120.0),
            BTreeMap::from([
                (Position::quarters(16), tempo(150.0)),
                (Position::quarters(8), tempo(90.0)),
            ]),
            Meter::FOUR_FOUR,
            BTreeMap::from([
                (9, three_four()),
                (5, Meter::new(7, 8).expect("a signature")),
            ]),
        );

        let tempi: Vec<_> = timeline
            .tempo_marks()
            .into_iter()
            .map(|mark| (mark.at, mark.beats_per_minute))
            .collect();
        assert_eq!(
            tempi,
            [
                (Position::ZERO, 120.0),
                (Position::quarters(8), 90.0),
                (Position::quarters(16), 150.0),
            ]
        );

        let bars: Vec<_> = timeline
            .meter_marks()
            .into_iter()
            .map(|mark| mark.from_bar)
            .collect();
        assert_eq!(bars, [FIRST_BAR, 5, 9]);

        both_maps_build(&timeline);
    }

    /// The merge this shape exists for: somebody writes a change where the
    /// opening mark already is. Two marks in one place is what `build` refuses,
    /// so the entry loses and the document still opens.
    #[test]
    fn a_change_where_the_opening_mark_already_is_is_dropped() {
        let timeline = Timeline::with_changes(
            tempo(120.0),
            BTreeMap::from([(Position::ZERO, tempo(200.0))]),
            Meter::FOUR_FOUR,
            BTreeMap::from([(FIRST_BAR, three_four())]),
        );

        assert_eq!(timeline.tempo_marks().len(), 1);
        assert_eq!(timeline.tempo_marks()[0].beats_per_minute, 120.0);
        assert_eq!(timeline.meter_marks().len(), 1);
        assert_eq!(timeline.meter_marks()[0].meter, Meter::FOUR_FOUR);
        both_maps_build(&timeline);
    }

    /// And the same before the beginning, where a count-in lives. Both maps
    /// hold their opening mark behind it already (§2.5), so a mark there says
    /// nothing that is not already said.
    #[test]
    fn a_change_before_the_beginning_is_dropped() {
        let timeline = Timeline::with_changes(
            tempo(120.0),
            BTreeMap::from([(Position::ZERO - Span::quarters(4), tempo(200.0))]),
            Meter::FOUR_FOUR,
            BTreeMap::from([(FIRST_BAR - 2, three_four())]),
        );

        assert_eq!(timeline.tempo_marks().len(), 1);
        assert_eq!(timeline.meter_marks().len(), 1);
        both_maps_build(&timeline);
    }
}
