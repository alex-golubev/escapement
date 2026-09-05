//! A pattern, and the notes in it.
//!
//! A pattern is an entity with a lifetime of its own and not a clip with notes
//! inside it (ARCHITECTURE.md §2.6). The playlist points at it, so editing it
//! changes all twenty places it plays — which is the difference between this
//! product's shape and Ableton's, and the thing §2.6 exists to keep.
//!
//! **Notes are a map keyed by name, never a list** (§2.6). Nothing about a note
//! is third; it has a position. In a list every addition would have to be
//! merged at an index neither person chose, and two people writing into one bar
//! would collide over a place that means nothing. In a map they cannot collide,
//! and moving a note is editing two of its fields.
//!
//! **A note names its channel; the pattern does not hold a map for each.**
//! Nesting by channel would make "add a note" sometimes also create the
//! container it goes in, so two people adding the first note for one channel
//! would race to create it. Flat, an addition is an addition.
//!
//! Positions here are the pattern's own: a note sits so far from where the
//! pattern begins, and where *that* is on the timeline is the clip's to say.

use std::collections::BTreeMap;

use escapement_time::{Position, Span};

use crate::bounded::within;
use crate::mixer::Channel;
use crate::Id;

/// Which note of the twelve, in the octave it belongs to — a semitone, counted
/// as MIDI counts them.
///
/// Discrete because it is: between two adjacent keys there is no key, and
/// tuning is a property of an instrument rather than of the note asking for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Key(u8);

impl Key {
    /// Middle C, as MIDI numbers it.
    pub const MIDDLE_C: Self = Self(60);

    /// The highest key there is.
    pub const HIGHEST: u8 = 127;

    /// `None` above [`Key::HIGHEST`], which is where the numbering stops.
    #[must_use]
    pub const fn new(semitone: u8) -> Option<Self> {
        if semitone > Self::HIGHEST {
            return None;
        }
        Some(Self(semitone))
    }

    /// The semitone.
    #[must_use]
    pub const fn semitone(self) -> u8 {
        self.0
    }
}

/// How hard the note was struck, from silence to full.
///
/// A fraction rather than one of 128 steps, which is what MIDI would impose:
/// the sampler multiplies by this and chooses a layer with it, and nothing in
/// the product needs the quantisation. What comes in over MIDI is divided at
/// the edge, once.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Velocity(f32);

impl Velocity {
    /// Struck as hard as it goes.
    pub const FULL: Self = Self(1.0);

    /// `None` outside the two ends, and for what is not a number — refused
    /// rather than clamped, as a pan is and for the same reason.
    #[must_use]
    pub fn new(fraction: f32) -> Option<Self> {
        within(fraction, 0.0..=1.0).map(Self)
    }

    /// How hard, as a fraction of as hard as it goes.
    #[must_use]
    pub fn fraction(self) -> f32 {
        self.0
    }
}

/// One note: which channel plays it, where it sits in the pattern, how long it
/// lasts, and how it was struck.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Note {
    channel: Id<Channel>,
    start: Position,
    length: Span,
    key: Key,
    velocity: Velocity,
}

impl Note {
    /// Built whole. A note of no length is allowed through: it is inaudible
    /// rather than malformed, and refusing it here would make a drag that
    /// briefly passes through zero a thing the document cannot hold.
    #[must_use]
    pub const fn new(
        channel: Id<Channel>,
        start: Position,
        length: Span,
        key: Key,
        velocity: Velocity,
    ) -> Self {
        Self {
            channel,
            start,
            length,
            key,
            velocity,
        }
    }

    /// The channel that plays it.
    ///
    /// The name may resolve to nothing — somebody can delete a channel while
    /// somebody else writes a note for it (§2.6). A note whose channel is gone
    /// is not played and is not an error.
    #[must_use]
    pub const fn channel(self) -> Id<Channel> {
        self.channel
    }

    /// Where it starts, counted from where the pattern starts.
    #[must_use]
    pub const fn start(self) -> Position {
        self.start
    }

    /// How long it lasts.
    #[must_use]
    pub const fn length(self) -> Span {
        self.length
    }

    /// Where it stops sounding.
    #[must_use]
    pub fn end(self) -> Position {
        self.start + self.length
    }

    #[must_use]
    pub const fn key(self) -> Key {
        self.key
    }

    #[must_use]
    pub const fn velocity(self) -> Velocity {
        self.velocity
    }
}

/// A named collection of notes, played wherever the playlist puts it.
#[derive(Clone, Debug, PartialEq)]
pub struct Pattern {
    name: String,
    notes: BTreeMap<Id<Note>, Note>,
}

impl Pattern {
    /// Built whole, from names that were minted rather than counted.
    #[must_use]
    pub fn new(name: String, notes: impl IntoIterator<Item = (Id<Note>, Note)>) -> Self {
        Self {
            name,
            notes: notes.into_iter().collect(),
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// One note by name, or nothing if it is not here — which is the ordinary
    /// answer for a note somebody else deleted.
    #[must_use]
    pub fn note(&self, name: Id<Note>) -> Option<&Note> {
        self.notes.get(&name)
    }

    /// Every note, in an order that does not move between two readings of the
    /// same document.
    pub fn notes(&self) -> impl Iterator<Item = (Id<Note>, &Note)> {
        self.notes.iter().map(|(name, note)| (*name, note))
    }

    /// The notes one channel plays.
    ///
    /// A scan, because the notes are held flat and this is a question about a
    /// field. An index over it is derived state and belongs to whoever is
    /// drawing, not to the document.
    pub fn notes_on(&self, channel: Id<Channel>) -> impl Iterator<Item = (Id<Note>, &Note)> {
        self.notes()
            .filter(move |(_, note)| note.channel() == channel)
    }

    /// How long the pattern is: from its start to the end of the note that
    /// finishes last.
    ///
    /// Derived rather than stored. A length in the document is a second thing
    /// to keep true, and two people — one adding a note past the end, one
    /// dragging the end in — would merge into a pattern whose length disagrees
    /// with its contents. What loops and what is trimmed is the clip's, not
    /// this.
    #[must_use]
    pub fn length(&self) -> Span {
        self.notes
            .values()
            .map(|note| note.end() - Position::ZERO)
            .max()
            .unwrap_or(Span::ZERO)
            .max(Span::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Counter;

    fn note(channel: Id<Channel>, start: Position, length: Span) -> Note {
        Note::new(channel, start, length, Key::MIDDLE_C, Velocity::FULL)
    }

    /// A pattern of `notes`, and the names minted for them, so that a test can
    /// ask for one back.
    fn pattern(notes: Vec<Note>) -> (Pattern, Vec<Id<Note>>) {
        let mut entropy = Counter::new();
        let named: Vec<_> = notes
            .into_iter()
            .map(|note| (Id::mint(&mut entropy), note))
            .collect();
        let names = named.iter().map(|(name, _)| *name).collect();

        (Pattern::new("Verse".to_owned(), named), names)
    }

    #[test]
    fn a_key_stops_where_the_numbering_does() {
        assert_eq!(Key::new(0).map(Key::semitone), Some(0));
        assert_eq!(Key::new(127).map(Key::semitone), Some(127), "the last key");
        assert_eq!(Key::new(128), None, "past the last key");
        assert_eq!(Key::new(u8::MAX), None);
        assert_eq!(Key::MIDDLE_C.semitone(), 60);
    }

    #[test]
    fn a_velocity_runs_from_silence_to_full_and_no_further() {
        assert_eq!(Velocity::FULL.fraction(), 1.0);
        assert_eq!(Velocity::new(0.0).map(Velocity::fraction), Some(0.0));
        assert_eq!(Velocity::new(0.5).map(Velocity::fraction), Some(0.5));
        assert_eq!(Velocity::new(1.0), Some(Velocity::FULL));
        assert_eq!(Velocity::new(-0.1), None, "quieter than silence");
        assert_eq!(Velocity::new(1.1), None, "harder than as hard as it goes");
        assert_eq!(Velocity::new(f32::NAN), None, "not a number");
        assert_eq!(Velocity::new(f32::INFINITY), None, "infinite");
    }

    #[test]
    fn a_note_holds_what_it_was_built_from() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);
        let quiet = Velocity::new(0.25).expect("a quarter is a velocity");
        let note = Note::new(
            channel,
            Position::quarters(2),
            Span::QUARTER,
            Key::new(64).expect("64 is a key"),
            quiet,
        );

        assert_eq!(note.channel(), channel);
        assert_eq!(note.start(), Position::quarters(2));
        assert_eq!(note.length(), Span::QUARTER);
        assert_eq!(note.key().semitone(), 64);
        assert_eq!(note.velocity(), quiet);
    }

    #[test]
    fn a_note_stops_a_length_after_it_starts() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);

        assert_eq!(
            note(channel, Position::quarters(2), Span::QUARTER).end(),
            Position::quarters(3)
        );
        assert_eq!(
            note(channel, Position::quarters(2), Span::ZERO).end(),
            Position::quarters(2),
            "a note of no length is inaudible, not malformed"
        );
    }

    #[test]
    fn a_note_is_found_by_name_and_a_deleted_one_is_not() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);
        let (pattern, names) = pattern(vec![note(channel, Position::ZERO, Span::QUARTER)]);
        let gone = Id::mint(&mut entropy);

        assert_eq!(pattern.name(), "Verse");
        assert_eq!(
            pattern.note(names[0]).map(|note| note.start()),
            Some(Position::ZERO)
        );
        assert_eq!(pattern.note(gone), None, "a name nothing here holds");
    }

    #[test]
    fn the_notes_of_one_channel_are_the_ones_naming_it() {
        let mut entropy = Counter::new();
        let kick = Id::mint(&mut entropy);
        let snare = Id::mint(&mut entropy);
        let (pattern, _) = pattern(vec![
            note(kick, Position::ZERO, Span::QUARTER),
            note(snare, Position::quarters(1), Span::QUARTER),
            note(kick, Position::quarters(2), Span::QUARTER),
        ]);

        let kicks: Vec<_> = pattern
            .notes_on(kick)
            .map(|(_, note)| note.start())
            .collect();
        assert_eq!(kicks, [Position::ZERO, Position::quarters(2)]);
        assert_eq!(pattern.notes_on(snare).count(), 1);
        assert_eq!(pattern.notes().count(), 3, "and all three are still here");
    }

    #[test]
    fn a_pattern_is_as_long_as_the_note_that_finishes_last() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);
        let (pattern, _) = pattern(vec![
            note(channel, Position::quarters(3), Span::QUARTER),
            note(channel, Position::ZERO, Span::QUARTER),
        ]);

        assert_eq!(
            pattern.length(),
            Span::quarters(4),
            "the last note to finish is not the last one added"
        );
    }

    #[test]
    fn a_pattern_with_no_notes_has_no_length() {
        let (empty, _) = pattern(vec![]);

        assert_eq!(empty.length(), Span::ZERO);
    }

    /// A note before the pattern's own start has no reading, and it is a
    /// merge away: one person moves a note to the very beginning while another
    /// moves the whole thing. A negative length would be worse than none.
    #[test]
    fn a_pattern_whose_notes_end_before_it_begins_has_no_length() {
        let mut entropy = Counter::new();
        let channel = Id::mint(&mut entropy);
        let (pattern, _) = pattern(vec![note(channel, Position::quarters(-4), Span::QUARTER)]);

        assert_eq!(pattern.length(), Span::ZERO);
    }
}
