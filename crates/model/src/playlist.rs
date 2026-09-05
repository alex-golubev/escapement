//! The playlist: lanes to look at, and the clips laid out on them.
//!
//! **A lane is visual and carries no routing** (ARCHITECTURE.md §2.6). A
//! pattern, a file and a curve can go on any of them, and where the sound goes
//! afterwards is the channel's business and never the lane's. So a lane holds a
//! name and nothing else — a colour and a height are cosmetic, and arrive as
//! registers on the day the interface wants them. What is deliberately absent
//! is anything about routing, which is what makes a lane a lane rather than a
//! track in the Ableton sense.
//!
//! **A clip holds its lane**, not the other way about (§2.6): a lane listing
//! its clips merges two people's drags into one clip on two lanes, while one
//! field converges on the lane one of them chose.
//!
//! **A clip refers to what it plays and never copies it** (§2.6). Editing a
//! pattern changes all twenty places it appears because there is only ever the
//! one pattern; the clip carries where it sits and how much of it is heard.

use escapement_time::{Position, Span};

use crate::asset::Frames;
use crate::automation::Automation;
use crate::pattern::Pattern;
use crate::{AssetHash, Id};

/// A row of the arrangement, which is a place to look and nothing more.
#[derive(Clone, Debug, PartialEq)]
pub struct Lane {
    name: String,
}

impl Lane {
    #[must_use]
    pub const fn new(name: String) -> Self {
        Self { name }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// What a clip plays, and where it starts inside it.
///
/// The two offsets here are in different counts and cannot be swapped, which is
/// the point of them being different types (§2.5): a pattern is musical and
/// slides by a span of ticks, while a file is a file and slides by its own
/// frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ClipSource {
    /// A pattern, from `offset` into it — which is how the same pattern plays
    /// from its second bar in one place and its first in another.
    Pattern { pattern: Id<Pattern>, offset: Span },
    /// A file, from `trim` frames into it.
    Audio { asset: AssetHash, trim: Frames },
    /// A curve. It has no offset: the points carry their own positions, and
    /// sliding a curve inside its clip is not a thing anyone asks for.
    Automation { automation: Id<Automation> },
}

/// One thing on the timeline: where it is, how long it sounds, and what it
/// plays.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clip {
    lane: Id<Lane>,
    start: Position,
    length: Span,
    source: ClipSource,
}

impl Clip {
    /// Built whole. A clip of no length is allowed through for the reason a
    /// note of no length is: a drag passes through zero on its way somewhere.
    #[must_use]
    pub const fn new(lane: Id<Lane>, start: Position, length: Span, source: ClipSource) -> Self {
        Self {
            lane,
            start,
            length,
            source,
        }
    }

    /// The lane it sits on — one, and the whole of what a lane means here.
    ///
    /// The name may resolve to nothing, in which case the clip is nowhere to be
    /// drawn rather than everywhere (§2.6).
    #[must_use]
    pub const fn lane(self) -> Id<Lane> {
        self.lane
    }

    /// Where it starts on the timeline.
    #[must_use]
    pub const fn start(self) -> Position {
        self.start
    }

    /// How long it sounds for — which is the clip's and not the pattern's. A
    /// clip shorter than what it plays trims it; a longer one repeats it.
    #[must_use]
    pub const fn length(self) -> Span {
        self.length
    }

    /// Where it stops.
    #[must_use]
    pub fn end(self) -> Position {
        self.start + self.length
    }

    #[must_use]
    pub const fn source(self) -> ClipSource {
        self.source
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Counter;

    fn clip(lane: Id<Lane>, source: ClipSource) -> Clip {
        Clip::new(lane, Position::quarters(4), Span::quarters(8), source)
    }

    #[test]
    fn a_lane_is_a_name_and_nothing_that_routes() {
        assert_eq!(Lane::new("Drums".to_owned()).name(), "Drums");
    }

    #[test]
    fn a_clip_holds_what_it_was_built_from() {
        let mut entropy = Counter::new();
        let lane = Id::mint(&mut entropy);
        let source = ClipSource::Automation {
            automation: Id::mint(&mut entropy),
        };
        let clip = clip(lane, source);

        assert_eq!(clip.lane(), lane);
        assert_eq!(clip.start(), Position::quarters(4));
        assert_eq!(clip.length(), Span::quarters(8));
        assert_eq!(clip.source(), source);
    }

    #[test]
    fn a_clip_stops_a_length_after_it_starts() {
        let mut entropy = Counter::new();
        let lane = Id::mint(&mut entropy);
        let source = ClipSource::Automation {
            automation: Id::mint(&mut entropy),
        };

        assert_eq!(clip(lane, source).end(), Position::quarters(12));
        assert_eq!(
            Clip::new(lane, Position::quarters(4), Span::ZERO, source).end(),
            Position::quarters(4),
            "a clip of no length is a drag passing through zero"
        );
    }

    /// The same pattern in two clips, which is the shape §2.6 exists for: what
    /// differs is where each sits, and the pattern is one object either way.
    #[test]
    fn two_clips_play_one_pattern() {
        let mut entropy = Counter::new();
        let lane = Id::mint(&mut entropy);
        let pattern = Id::mint(&mut entropy);
        let source = ClipSource::Pattern {
            pattern,
            offset: Span::ZERO,
        };

        let first = Clip::new(lane, Position::ZERO, Span::quarters(4), source);
        let second = Clip::new(lane, Position::quarters(4), Span::quarters(4), source);

        assert_eq!(first.source(), second.source());
        assert_ne!(first.start(), second.start());
    }

    /// Both offsets exist and neither can be given to the other: the compiler
    /// refuses it, and what a test can say is that they are different values of
    /// a source that knows which it is holding.
    #[test]
    fn a_pattern_slides_by_ticks_and_a_file_by_its_own_frames() {
        let mut entropy = Counter::new();
        let pattern = ClipSource::Pattern {
            pattern: Id::mint(&mut entropy),
            offset: Span::QUARTER,
        };
        let audio = ClipSource::Audio {
            asset: AssetHash::from_bytes([3; 32]),
            trim: Frames::new(48_000),
        };

        assert_ne!(pattern, audio);
        assert_eq!(
            audio,
            ClipSource::Audio {
                asset: AssetHash::from_bytes([3; 32]),
                trim: Frames::new(48_000),
            }
        );
        assert_ne!(
            audio,
            ClipSource::Audio {
                asset: AssetHash::from_bytes([3; 32]),
                trim: Frames::ZERO,
            },
            "a different point in the file is a different clip"
        );
    }
}
