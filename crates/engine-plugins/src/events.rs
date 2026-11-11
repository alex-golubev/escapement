//! What happens to a plugin during a block, each thing at its frame, and a walk through the block between them.

use std::iter::{self, Peekable};
use std::ops::Range;
use std::slice;

use crate::ParamNumber;

/// Happens before the sample of its frame. At one frame, parameter changes come first, then notes pressed, then notes let
/// go of: a note let go of at the frame it is pressed still starts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    /// `param` is in the plugin's description; `value` lies within that parameter's range.
    Param {
        time: u32,
        param: ParamNumber,
        value: f32,
    },
    /// `key` is a MIDI key, 0 to 127; `velocity` lies between 0 and 1.
    NoteOn {
        time: u32,
        key: u8,
        velocity: f32,
        note: NoteId,
    },
    /// Of the note pressed with `note`; a note no longer held, or one a plugin plays out on its own, takes no notice.
    NoteOff { time: u32, note: NoteId },
}

/// Names a note from its press until it is let go of: no other note its node holds has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NoteId(u32);

impl NoteId {
    #[must_use]
    pub const fn new(id: u32) -> Self {
        Self(id)
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

impl Event {
    /// A value given between blocks takes effect at the start of the next.
    #[must_use]
    pub const fn param_at_start(param: ParamNumber, value: f32) -> Self {
        Self::Param {
            time: 0,
            param,
            value,
        }
    }

    /// The frame of the block.
    #[must_use]
    pub fn time(&self) -> u32 {
        match *self {
            Self::Param { time, .. } | Self::NoteOn { time, .. } | Self::NoteOff { time, .. } => {
                time
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Event(Event),
    /// Frames to render, up to the next event.
    Frames(Range<usize>),
}

/// The block of `frames` as a plugin goes through it: each event at its time, the frames between. `events` are in
/// time order; one past the block comes at its end.
pub fn steps(events: &[Event], frames: usize) -> impl Iterator<Item = Step> {
    let mut events: Peekable<slice::Iter<'_, Event>> = events.iter().peekable();
    let mut start = 0;
    iter::from_fn(move || {
        let next = events
            .peek()
            .map_or(frames, |event| (event.time() as usize).min(frames));
        if next > start {
            let stretch = start..next;
            start = next;
            return Some(Step::Frames(stretch));
        }
        events.next().map(|&event| Step::Event(event))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::param_number;

    fn param(time: u32, param: u32) -> Event {
        Event::Param {
            time,
            param: param_number(param),
            value: 0.5,
        }
    }

    fn walk(events: &[Event], frames: usize) -> Vec<Step> {
        steps(events, frames).collect()
    }

    #[test]
    fn without_events_the_block_is_one_stretch() {
        assert_eq!(walk(&[], 128), [Step::Frames(0..128)]);
    }

    #[test]
    fn an_event_comes_before_the_sample_of_its_frame() {
        let (first, middle) = (param(0, 1), param(64, 2));
        assert_eq!(
            walk(&[first, middle], 128),
            [
                Step::Event(first),
                Step::Frames(0..64),
                Step::Event(middle),
                Step::Frames(64..128),
            ]
        );
    }

    #[test]
    fn events_at_one_time_come_in_their_order_with_no_frames_between() {
        let (a, b) = (param(10, 2), param(10, 1));
        assert_eq!(
            walk(&[a, b], 128),
            [
                Step::Frames(0..10),
                Step::Event(a),
                Step::Event(b),
                Step::Frames(10..128),
            ]
        );
    }

    #[test]
    fn an_event_past_the_block_comes_at_its_end() {
        let (last, past) = (param(127, 1), param(500, 2));
        assert_eq!(
            walk(&[last, past], 128),
            [
                Step::Frames(0..127),
                Step::Event(last),
                Step::Frames(127..128),
                Step::Event(past),
            ]
        );
    }

    #[test]
    fn a_short_block_ends_where_it_ends() {
        let late = param(100, 1);
        assert_eq!(walk(&[late], 5), [Step::Frames(0..5), Step::Event(late)]);
    }
}
