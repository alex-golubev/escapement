//! Where the engine is in musical time. The position is in ticks, as in the model, and the tempo only sets how fast it
//! moves: a new tempo keeps the position where it is. A frame passes the positions from its own up to the next frame's,
//! so blocks share out the ticks between them with none twice and none left out, whatever the tempo does.

use std::iter;
use std::num::NonZeroU32;

use engine_plugins::SampleRate;

use crate::BLOCK_FRAMES;
use crate::schema::Rejection;

/// The model's: time is whole ticks, this many to a quarter note.
pub const TICKS_PER_QUARTER: u32 = 960;
/// Quarter notes a minute; a tempo past these is clamped.
pub const MIN_TEMPO: u32 = 10;
pub const MAX_TEMPO: u32 = 522;
/// MIDI's, until the page sends one.
pub const DEFAULT_TEMPO: u32 = 120;

/// Every f32 from 8 up is a whole number of 2⁻²⁰, any tempo in range among them, and so is a whole sample rate: counted
/// in these parts, the position never rounds.
const PARTS_IN_ONE: u32 = 1 << 20;

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a tempo in range comes to a whole, positive number of parts"
)]
fn parts(value: f32) -> u64 {
    let parts = f64::from(value) * f64::from(PARTS_IN_ONE);
    debug_assert_eq!(parts.fract(), 0.0, "{value}");
    parts as u64
}

/// A tick within the loop or a clip's period: worked out in `u64`, so sums don't overflow, and under that length, a
/// `u32`.
#[expect(
    clippy::cast_possible_truncation,
    reason = "under the length of a loop or a period, a `u32`"
)]
pub(crate) fn within(ticks: u64) -> u32 {
    debug_assert!(u32::try_from(ticks).is_ok(), "{ticks}");
    ticks as u32
}

/// Parts a frame moves the position at `tempo`.
fn step(tempo: f32) -> u64 {
    parts(tempo) * u64::from(TICKS_PER_QUARTER)
}

/// Where the page last put the position: a press the transport hasn't had puts the position at its tick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Place {
    /// 0 is none: a new transport stands at the loop's start.
    pub press: u32,
    /// From the loop's start; past its end it wraps around.
    pub tick: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Stopped {
        /// Whole ticks from the loop's start.
        ticks: u32,
        /// Of the next tick, played before it stopped: playing on, nothing is played twice.
        parts: u64,
    },
    Playing {
        loop_ticks: NonZeroU32,
        /// Whole ticks from the loop's start.
        ticks: u32,
        /// Of the next tick, played so far.
        parts: u64,
        /// Whole ticks from the start of play, through the loop's ends: the count of the tick the position is in.
        count: u64,
        /// Which start of play this is.
        play: u32,
    },
}

/// A run of the loop's ticks that a block passes in one pass of the loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Stretch {
    /// Both ends included.
    pub first: u32,
    pub last: u32,
    /// Whole ticks from the tick the block starts in to `first`.
    ahead: u64,
    /// The count of `first`.
    count: u64,
    pace: Pace,
}

impl Stretch {
    /// The frame of the block that passes `tick`, one of the stretch's.
    #[must_use]
    pub(crate) fn frame(&self, tick: u32) -> u32 {
        debug_assert!((self.first..=self.last).contains(&tick));
        self.pace.frame(self.ahead + u64::from(tick - self.first))
    }

    /// Whole ticks from the start of play to `tick`, one of the stretch's, through the loop's ends.
    #[must_use]
    pub(crate) fn count(&self, tick: u32) -> u64 {
        debug_assert!((self.first..=self.last).contains(&tick));
        self.count + u64::from(tick - self.first)
    }
}

/// The ticks a block passes by their count from the start of play: one run, as the loop's ends don't break it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Run {
    /// Both ends included.
    pub first: u64,
    pub last: u64,
    /// The count of the tick the block starts in.
    start: u64,
    pace: Pace,
}

impl Run {
    /// The frame of the block that passes the tick of `count`, one of the run's.
    #[must_use]
    pub(crate) fn frame(&self, count: u64) -> u32 {
        debug_assert!((self.first..=self.last).contains(&count));
        self.pace.frame(count - self.start)
    }
}

/// Where a block starts in its tick, and how fast it moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pace {
    /// Of the tick the block starts in, already played.
    parts: u64,
    /// Parts in a tick.
    tick: u64,
    /// Parts a frame moves the position.
    step: u64,
}

impl Pace {
    /// The frame that passes the tick `ahead` whole ticks from the one the block starts in.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a frame of the block: the caller's tick is one of the stretch's"
    )]
    fn frame(&self, ahead: u64) -> u32 {
        let frame = (ahead * self.tick - self.parts) / self.step;
        debug_assert!(frame < BLOCK_FRAMES as u64, "{frame}");
        frame as u32
    }

    /// Whole ticks from the one the block starts in to the first it passes and the last, in `frames`; none if it
    /// passes none.
    fn passes(&self, frames: usize) -> Option<(u64, u64)> {
        // The block covers its position up to the next block's: a tick the position is already past went with the
        // block before, and the one the next block starts on goes with that block.
        let first = self.parts.div_ceil(self.tick);
        let end = (self.parts + frames as u64 * self.step).div_ceil(self.tick);
        (first < end).then(|| (first, end - 1))
    }
}

/// The ticks a block has still to pass, counted from the start of the pass it starts in.
struct Passing {
    next: u64,
    last: u64,
    /// Whole ticks from the tick the block starts in to `next`.
    ahead: u64,
    loop_ticks: u64,
    /// The count of the tick the block starts in.
    start: u64,
}

pub(crate) struct Transport {
    /// Parts in a tick.
    tick: u64,
    tempo: f32,
    step: u64,
    state: State,
    /// Starts of play so far; wraps around.
    plays: u32,
    /// The press of the last place taken.
    placed: u32,
}

impl Transport {
    #[must_use]
    pub(crate) fn new(sample_rate: SampleRate) -> Self {
        let tempo = DEFAULT_TEMPO as f32;
        Self {
            tick: 60 * u64::from(sample_rate.get()) * u64::from(PARTS_IN_ONE),
            tempo,
            step: step(tempo),
            state: State::Stopped { ticks: 0, parts: 0 },
            plays: 0,
            placed: 0,
        }
    }

    /// From the next frame played. A tempo past [`MIN_TEMPO`] to [`MAX_TEMPO`] is clamped.
    pub(crate) fn set_tempo(&mut self, bpm: f32) -> Result<(), Rejection> {
        if !bpm.is_finite() {
            return Err(Rejection::InvalidValue);
        }
        self.tempo = bpm.clamp(MIN_TEMPO as f32, MAX_TEMPO as f32);
        self.step = step(self.tempo);
        Ok(())
    }

    /// The whole state, the same again changing nothing: only a new place moves the position; playing wraps it.
    pub(crate) fn set(
        &mut self,
        playing: bool,
        loop_ticks: u32,
        place: Place,
    ) -> Result<(), Rejection> {
        let loop_ticks = NonZeroU32::new(loop_ticks).ok_or(Rejection::InvalidValue)?;
        let moved = place.press != self.placed;
        self.placed = place.press;
        // None of a place's tick has gone by: it is played.
        let (ticks, parts) = if moved { (place.tick, 0) } else { self.at() };
        let wrapped = ticks % loop_ticks;
        self.state = match (playing, self.state) {
            // Past the loop's end too: a loop shortened for a while doesn't move it.
            (false, _) => State::Stopped { ticks, parts },
            (true, State::Playing { count, play, .. }) if !moved => State::Playing {
                loop_ticks,
                ticks: wrapped,
                parts,
                count,
                play,
            },
            (true, _) => {
                self.plays = self.plays.wrapping_add(1);
                State::Playing {
                    loop_ticks,
                    ticks: wrapped,
                    parts,
                    count: 0,
                    play: self.plays,
                }
            }
        };
        Ok(())
    }

    /// Whole ticks from the loop's start, and the parts of the next.
    fn at(&self) -> (u32, u64) {
        match self.state {
            State::Stopped { ticks, parts } | State::Playing { ticks, parts, .. } => (ticks, parts),
        }
    }

    #[must_use]
    pub(crate) fn tempo(&self) -> f32 {
        self.tempo
    }

    #[must_use]
    pub(crate) fn playing(&self) -> bool {
        matches!(self.state, State::Playing { .. })
    }

    /// In whole ticks from the loop's start, before the next frame: where it plays, or where it stands.
    #[must_use]
    pub(crate) fn position(&self) -> u32 {
        self.at().0
    }

    /// Which start of play this is, each new from stopped to playing: a count from another doesn't belong to it. None
    /// while stopped.
    #[must_use]
    pub(crate) fn play(&self) -> Option<u32> {
        match self.state {
            State::Stopped { .. } => None,
            State::Playing { play, .. } => Some(play),
        }
    }

    /// None while stopped.
    #[must_use]
    pub(crate) fn loop_ticks(&self) -> Option<u32> {
        match self.state {
            State::Stopped { .. } => None,
            State::Playing { loop_ticks, .. } => Some(loop_ticks.get()),
        }
    }

    /// The ticks the next `frames` frames pass, at most a block's, a stretch for each pass of the loop: more than one
    /// where the loop ends among them. None while stopped.
    pub(crate) fn stretches(&self, frames: usize) -> impl Iterator<Item = Stretch> + use<> {
        debug_assert!(frames <= BLOCK_FRAMES);
        let pace = self.pace();
        let mut left = match self.state {
            State::Playing {
                loop_ticks,
                ticks,
                count,
                ..
            } => pace.passes(frames).map(|(past, reached)| Passing {
                next: u64::from(ticks) + past,
                last: u64::from(ticks) + reached,
                ahead: past,
                loop_ticks: u64::from(loop_ticks.get()),
                start: count,
            }),
            State::Stopped { .. } => None,
        };
        iter::from_fn(move || {
            let left = left.as_mut().filter(|left| left.next <= left.last)?;
            let pass = left.next - left.next % left.loop_ticks;
            let end = left.last.min(pass + left.loop_ticks - 1);
            let stretch = Stretch {
                first: within(left.next - pass),
                last: within(end - pass),
                ahead: left.ahead,
                count: left.start + left.ahead,
                pace,
            };
            left.ahead += end + 1 - left.next;
            left.next = end + 1;
            Some(stretch)
        })
    }

    /// The ticks the next `frames` frames pass, at most a block's, by their count from the start of play. None while
    /// stopped, or if they pass none.
    #[must_use]
    pub(crate) fn run(&self, frames: usize) -> Option<Run> {
        debug_assert!(frames <= BLOCK_FRAMES);
        let State::Playing { count, .. } = self.state else {
            return None;
        };
        let pace = self.pace();
        pace.passes(frames).map(|(past, reached)| Run {
            first: count + past,
            last: count + reached,
            start: count,
            pace,
        })
    }

    fn pace(&self) -> Pace {
        Pace {
            parts: self.at().1,
            tick: self.tick,
            step: self.step,
        }
    }

    /// By at most a block.
    pub(crate) fn advance(&mut self, played: usize) {
        debug_assert!(played <= BLOCK_FRAMES);
        if let State::Playing {
            loop_ticks,
            ticks,
            parts,
            count,
            ..
        } = &mut self.state
        {
            let moved = *parts + played as u64 * self.step;
            *parts = moved % self.tick;
            *ticks = within((u64::from(*ticks) + moved / self.tick) % u64::from(loop_ticks.get()));
            *count += moved / self.tick;
        }
    }
}

#[cfg(test)]
mod tests;
