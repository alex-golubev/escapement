//! A curve, and what it moves.
//!
//! §2.4 names this as the place a naive CRDT explodes: one drag of the mouse is
//! hundreds of operations a second. So the shape is the one that survives it —
//! points keyed by name, never listed (§2.6) — and the soft lock that keeps two
//! people out of one curve is presence rather than document state, which puts
//! it outside this crate altogether.
//!
//! **What the curve does between two points is not settled here.** §2.5 has a
//! straight line between two tempo marks, and FL has a tension on every
//! segment; which of them this is wants a decision of its own, and the shape it
//! would take is already visible in [`tempo::Mark`](escapement_time::tempo) —
//! what follows a point belongs to the point. Until then a curve is where it
//! passes through, and evaluating it belongs where the parameter is applied,
//! not here: the audio thread reads a flattened snapshot rather than this
//! document (§3), and a second evaluator on this side would be a second answer.

use std::collections::BTreeMap;

use escapement_time::Position;

use crate::bounded::within;
use crate::mixer::{Channel, Insert};
use crate::Id;

/// How far between the ends of whatever is being moved.
///
/// Normalized rather than held in the parameter's own units, so that one point
/// type serves every parameter and cannot hold a value the parameter would
/// refuse. Where the ends are — what a gain of one is, and how the travel
/// between them is shaped — belongs to the parameter and to the interface
/// drawing its fader.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Level(f32);

impl Level {
    /// All the way down.
    pub const BOTTOM: Self = Self(0.0);

    /// All the way up.
    pub const TOP: Self = Self(1.0);

    /// `None` outside the two ends, and for what is not a number.
    #[must_use]
    pub fn new(fraction: f32) -> Option<Self> {
        within(fraction, 0.0..=1.0).map(Self)
    }

    /// How far up.
    #[must_use]
    pub fn fraction(self) -> f32 {
        self.0
    }
}

/// Which entity a curve reaches into.
///
/// Either name may resolve to nothing, and a curve whose target is gone moves
/// nothing rather than moving something else (§2.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Channel(Id<Channel>),
    Insert(Id<Insert>),
}

/// Which of the target's parameters.
///
/// The two both entities have. A device's parameters are named by the device
/// (§2.3), so the variant that carries a key arrives with the device interface
/// rather than being guessed at now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Parameter {
    Gain,
    Pan,
}

/// What a curve moves: one parameter of one entity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Address {
    target: Target,
    parameter: Parameter,
}

impl Address {
    #[must_use]
    pub const fn new(target: Target, parameter: Parameter) -> Self {
        Self { target, parameter }
    }

    #[must_use]
    pub const fn target(self) -> Target {
        self.target
    }

    #[must_use]
    pub const fn parameter(self) -> Parameter {
        self.parameter
    }
}

/// One point a curve passes through.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    at: Position,
    level: Level,
}

impl Point {
    #[must_use]
    pub const fn new(at: Position, level: Level) -> Self {
        Self { at, level }
    }

    /// Where on the timeline of whatever holds this curve.
    #[must_use]
    pub const fn at(self) -> Position {
        self.at
    }

    #[must_use]
    pub const fn level(self) -> Level {
        self.level
    }
}

/// A curve: what it moves, and the points it passes through.
#[derive(Clone, Debug, PartialEq)]
pub struct Automation {
    address: Address,
    points: BTreeMap<Id<Point>, Point>,
}

impl Automation {
    #[must_use]
    pub fn new(address: Address, points: impl IntoIterator<Item = (Id<Point>, Point)>) -> Self {
        Self {
            address,
            points: points.into_iter().collect(),
        }
    }

    #[must_use]
    pub const fn address(&self) -> Address {
        self.address
    }

    /// One point by name, or nothing if it is not here.
    #[must_use]
    pub fn point(&self, name: Id<Point>) -> Option<&Point> {
        self.points.get(&name)
    }

    /// Every point, in the order their names give.
    pub fn points(&self) -> impl Iterator<Item = (Id<Point>, &Point)> {
        self.points.iter().map(|(name, point)| (*name, point))
    }

    /// Every point in the order a curve is read in.
    ///
    /// The map is keyed by name, because that is what a merge needs; time is
    /// what a reader needs, and the two have nothing to do with each other. The
    /// name breaks a tie, and there will be ties: two people drawing at once
    /// converge on two points at one moment, which is legal and has to come out
    /// the same way twice.
    #[must_use]
    pub fn in_time_order(&self) -> Vec<(Id<Point>, &Point)> {
        let mut points: Vec<_> = self.points().collect();
        points.sort_by_key(|(name, point)| (point.at(), *name));
        points
    }
}

#[cfg(test)]
mod tests {
    use escapement_time::Span;

    use super::*;
    use crate::fixtures::Counter;

    fn curve(ats: &[Position]) -> (Automation, Vec<Id<Point>>) {
        let mut entropy = Counter::new();
        let target = Target::Insert(Id::mint(&mut entropy));
        let named: Vec<_> = ats
            .iter()
            .map(|at| (Id::mint(&mut entropy), Point::new(*at, Level::TOP)))
            .collect();
        let names = named.iter().map(|(name, _)| *name).collect();

        (
            Automation::new(Address::new(target, Parameter::Gain), named),
            names,
        )
    }

    #[test]
    fn a_level_runs_between_its_two_ends_and_no_further() {
        assert_eq!(Level::BOTTOM.fraction(), 0.0);
        assert_eq!(Level::TOP.fraction(), 1.0);
        assert_eq!(Level::new(0.0), Some(Level::BOTTOM));
        assert_eq!(Level::new(1.0), Some(Level::TOP));
        assert_eq!(Level::new(0.25).map(Level::fraction), Some(0.25));
        assert_eq!(Level::new(-0.1), None, "below the bottom");
        assert_eq!(Level::new(1.1), None, "above the top");
        assert_eq!(Level::new(f32::NAN), None, "not a number");
    }

    #[test]
    fn an_address_holds_what_it_was_built_from() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);
        let address = Address::new(Target::Channel(channel), Parameter::Pan);

        assert_eq!(address.target(), Target::Channel(channel));
        assert_eq!(address.parameter(), Parameter::Pan);
    }

    /// Two targets and two parameters, so that neither field can be the other's
    /// constant: an address naming a channel's pan is not the same address as
    /// one naming an insert's gain.
    #[test]
    fn two_addresses_differ_where_they_are_different() {
        let mut entropy = Counter::new();
        let name = Id::mint(&mut entropy);
        let gain = Address::new(Target::Channel(name), Parameter::Gain);

        assert_ne!(gain, Address::new(Target::Channel(name), Parameter::Pan));
        assert_ne!(
            gain,
            Address::new(Target::Insert(Id::from_bits(name.bits())), Parameter::Gain)
        );
    }

    #[test]
    fn a_point_holds_where_and_how_far_up() {
        let point = Point::new(Position::quarters(3), Level::BOTTOM);

        assert_eq!(point.at(), Position::quarters(3));
        assert_eq!(point.level(), Level::BOTTOM);
    }

    #[test]
    fn a_point_is_found_by_name_and_a_deleted_one_is_not() {
        let (curve, names) = curve(&[Position::ZERO]);
        let gone = Id::from_bits(u128::MAX);

        assert_eq!(
            curve.point(names[0]).map(|point| point.at()),
            Some(Position::ZERO)
        );
        assert_eq!(curve.point(gone), None);
        assert_eq!(curve.address().parameter(), Parameter::Gain);
    }

    #[test]
    fn a_curve_reads_in_time_order_whatever_order_it_was_written_in() {
        let (curve, _) = curve(&[Position::quarters(4), Position::ZERO, Position::quarters(2)]);

        let ats: Vec<_> = curve
            .in_time_order()
            .into_iter()
            .map(|(_, point)| point.at())
            .collect();

        assert_eq!(
            ats,
            [Position::ZERO, Position::quarters(2), Position::quarters(4)]
        );
        assert_eq!(curve.points().count(), 3, "and none were lost on the way");
    }

    /// Two people drawing at once converge on two points in one moment. That is
    /// legal, so what it must not do is come out differently on two readings —
    /// or on two machines, which is the same requirement wearing a worse hat.
    #[test]
    fn points_at_one_moment_come_out_in_the_same_order_twice() {
        let (curve, names) = curve(&[Position::ZERO, Position::ZERO, Position::quarters(1)]);

        let order: Vec<_> = curve
            .in_time_order()
            .into_iter()
            .map(|(name, _)| name)
            .collect();

        assert_eq!(
            order,
            curve
                .in_time_order()
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>()
        );
        assert_eq!(order[..2], [names[0].min(names[1]), names[0].max(names[1])]);
    }

    /// A position before the origin is where a count-in lives, and a curve may
    /// be read there.
    #[test]
    fn a_point_before_the_origin_sorts_before_one_after_it() {
        let (curve, _) = curve(&[Position::ZERO, Position::ZERO - Span::QUARTER]);

        let first = curve.in_time_order()[0].1.at();
        assert_eq!(first, Position::ZERO - Span::QUARTER);
    }
}
