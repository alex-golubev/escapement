//! Where the engine is in musical time. The position is in ticks, as in the model, and the tempo only sets how fast it
//! moves: a new tempo keeps the position where it is. A frame passes the positions from its own up to the next frame's,
//! so blocks share out the ticks between them with none twice and none left out, whatever the tempo does.

use std::iter;
use std::num::NonZeroU32;

use crate::BLOCK_FRAMES;
use crate::schema::Rejection;

/// The model's: time is whole ticks, this many to a quarter note.
pub const TICKS_PER_QUARTER: u32 = 960;
/// Quarter notes a minute; a tempo past these is clamped.
pub const MIN_TEMPO: u32 = 10;
pub const MAX_TEMPO: u32 = 522;
/// MIDI's, until the page sends one.
pub const DEFAULT_TEMPO: u32 = 120;

/// Every f32 from 8 up is a whole number of 2⁻²⁰, any tempo in range and any sample rate among them: counted in these
/// parts, the position never rounds.
const PARTS_IN_ONE: f64 = (1u64 << 20) as f64;

fn parts(value: f32) -> u64 {
    let parts = f64::from(value) * PARTS_IN_ONE;
    debug_assert_eq!(parts.fract(), 0.0, "{value}");
    parts as u64
}

/// Parts a frame moves the position at `tempo`.
fn step(tempo: f32) -> u64 {
    parts(tempo) * u64::from(TICKS_PER_QUARTER)
}

/// Where the page last put the position: a press the transport hasn't had puts the position at its tick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Place {
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
pub struct Stretch {
    /// Both ends included.
    pub first: u32,
    pub last: u32,
    /// Whole ticks from the tick the block starts in to `first`.
    ahead: u64,
    /// The count of `first`.
    count: u64,
    block: Block,
}

impl Stretch {
    /// The frame of the block that passes `tick`, one of the stretch's.
    pub fn frame(&self, tick: u32) -> u32 {
        debug_assert!((self.first..=self.last).contains(&tick));
        self.block.frame(self.ahead + u64::from(tick - self.first))
    }

    /// Whole ticks from the start of play to `tick`, one of the stretch's, through the loop's ends.
    pub fn count(&self, tick: u32) -> u64 {
        debug_assert!((self.first..=self.last).contains(&tick));
        self.count + u64::from(tick - self.first)
    }
}

/// The ticks a block passes by their count from the start of play: one run, as the loop's ends don't break it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    /// Both ends included.
    pub first: u64,
    pub last: u64,
    /// The count of the tick the block starts in.
    start: u64,
    block: Block,
}

impl Run {
    /// The frame of the block that passes the tick of `count`, one of the run's.
    pub fn frame(&self, count: u64) -> u32 {
        debug_assert!((self.first..=self.last).contains(&count));
        self.block.frame(count - self.start)
    }
}

/// Where a block starts in its tick, and how fast it moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Block {
    /// Of the tick the block starts in, already played.
    parts: u64,
    /// Parts in a tick.
    tick: u64,
    /// Parts a frame moves the position.
    step: u64,
}

impl Block {
    /// The frame that passes the tick `ahead` whole ticks from the one the block starts in.
    fn frame(&self, ahead: u64) -> u32 {
        ((ahead * self.tick - self.parts) / self.step) as u32
    }

    /// Whole ticks from the one the block starts in to the first it passes and the last, in `frames`; none if it
    /// passes none.
    fn passes(&self, frames: usize) -> Option<(u64, u64)> {
        // A tick the position is already past went with the block before.
        let past = u64::from(self.parts > 0);
        let reached = (self.parts + frames as u64 * self.step).checked_sub(1)? / self.tick;
        (frames > 0 && past <= reached).then_some((past, reached))
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

pub struct Transport {
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
    pub fn new(sample_rate: f32) -> Self {
        let tempo = DEFAULT_TEMPO as f32;
        Self {
            tick: 60 * parts(sample_rate),
            tempo,
            step: step(tempo),
            state: State::Stopped { ticks: 0, parts: 0 },
            plays: 0,
            placed: 0,
        }
    }

    /// From the next frame played. A tempo past [`MIN_TEMPO`] to [`MAX_TEMPO`] is clamped.
    pub fn set_tempo(&mut self, bpm: f32) -> Result<(), Rejection> {
        if !bpm.is_finite() {
            return Err(Rejection::InvalidValue);
        }
        self.tempo = bpm.clamp(MIN_TEMPO as f32, MAX_TEMPO as f32);
        self.step = step(self.tempo);
        Ok(())
    }

    /// The whole state, the same again changing nothing: only a new place moves the position; playing wraps it.
    pub fn set(&mut self, playing: bool, loop_ticks: u32, place: Place) -> Result<(), Rejection> {
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

    pub fn tempo(&self) -> f32 {
        self.tempo
    }

    pub fn playing(&self) -> bool {
        matches!(self.state, State::Playing { .. })
    }

    /// In whole ticks from the loop's start, before the next frame: where it plays, or where it stands.
    pub fn position(&self) -> u32 {
        self.at().0
    }

    /// Which start of play this is, each new from stopped to playing: a count from another doesn't belong to it. None
    /// while stopped.
    pub fn play(&self) -> Option<u32> {
        match self.state {
            State::Stopped { .. } => None,
            State::Playing { play, .. } => Some(play),
        }
    }

    /// None while stopped.
    pub fn loop_ticks(&self) -> Option<u32> {
        match self.state {
            State::Stopped { .. } => None,
            State::Playing { loop_ticks, .. } => Some(loop_ticks.get()),
        }
    }

    /// The ticks the next `frames` frames pass, at most a block's, a stretch for each pass of the loop: more than one
    /// where the loop ends among them. None while stopped.
    pub fn stretches(&self, frames: usize) -> impl Iterator<Item = Stretch> + use<> {
        debug_assert!(frames <= BLOCK_FRAMES);
        let block = self.block();
        let mut left = match self.state {
            State::Playing {
                loop_ticks,
                ticks,
                count,
                ..
            } => block.passes(frames).map(|(past, reached)| Passing {
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
                first: (left.next - pass) as u32,
                last: (end - pass) as u32,
                ahead: left.ahead,
                count: left.start + left.ahead,
                block,
            };
            left.ahead += end + 1 - left.next;
            left.next = end + 1;
            Some(stretch)
        })
    }

    /// The ticks the next `frames` frames pass, at most a block's, by their count from the start of play. None while
    /// stopped, or if they pass none.
    pub fn run(&self, frames: usize) -> Option<Run> {
        debug_assert!(frames <= BLOCK_FRAMES);
        let State::Playing { count, .. } = self.state else {
            return None;
        };
        let block = self.block();
        block.passes(frames).map(|(past, reached)| Run {
            first: count + past,
            last: count + reached,
            start: count,
            block,
        })
    }

    fn block(&self) -> Block {
        Block {
            parts: self.at().1,
            tick: self.tick,
            step: self.step,
        }
    }

    /// By at most a block.
    pub fn advance(&mut self, played: usize) {
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
            *ticks = ((u64::from(*ticks) + moved / self.tick) % u64::from(loop_ticks.get())) as u32;
            *count += moved / self.tick;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{BAR, FRAMES_PER_TICK, SAMPLE_RATE};

    fn playing(loop_ticks: u32) -> Transport {
        let mut transport = Transport::new(SAMPLE_RATE);
        transport.set(true, loop_ticks, Place::default()).unwrap();
        transport
    }

    fn play_blocks(transport: &mut Transport, blocks: usize) {
        for _ in 0..blocks {
            transport.advance(BLOCK_FRAMES);
        }
    }

    #[test]
    fn stands_until_told_to_play_and_starts_at_the_beginning() {
        let mut transport = Transport::new(SAMPLE_RATE);
        play_blocks(&mut transport, 10);
        assert_eq!((transport.playing(), transport.position()), (false, 0));
        transport.set(true, BAR, Place::default()).unwrap();
        assert_eq!(transport.state, playing(BAR).state);
        assert_eq!((transport.playing(), transport.position()), (true, 0));
    }

    #[test]
    fn moves_by_the_tempo() {
        let mut transport = playing(BAR);
        play_blocks(&mut transport, 25);
        let ticks = (25 * BLOCK_FRAMES / FRAMES_PER_TICK) as u32;
        assert_eq!(transport.position(), ticks);
        transport.set_tempo(60.0).unwrap();
        play_blocks(&mut transport, 50);
        assert_eq!(transport.position(), 2 * ticks);
    }

    #[test]
    fn a_new_tempo_keeps_the_position() {
        let mut transport = playing(BAR);
        play_blocks(&mut transport, 7);
        let before = transport.state;
        transport.set_tempo(173.5).unwrap();
        assert_eq!(transport.state, before);
    }

    #[test]
    fn wraps_around_at_the_loop_end_even_midway_through_a_block() {
        // 100 ticks are 19.53 blocks; 20 are 102.4 ticks.
        let mut transport = playing(100);
        play_blocks(&mut transport, 20);
        assert_eq!(transport.position(), 2);
        play_blocks(&mut transport, 5);
        assert_eq!(transport.position(), 28);
    }

    #[test]
    fn the_same_state_again_changes_nothing() {
        let mut transport = playing(BAR);
        play_blocks(&mut transport, 9);
        let before = transport.state;
        transport.set(true, BAR, Place::default()).unwrap();
        transport.set_tempo(120.0).unwrap();
        assert_eq!(transport.state, before);
        play_blocks(&mut transport, 1);
        assert!(transport.position() > 0);
        assert_ne!(transport.state, before);
    }

    #[test]
    fn stopping_leaves_the_position_and_playing_on_passes_no_tick_twice() {
        let mut transport = playing(BAR);
        // At 46.08: tick 46 went with the block before.
        play_blocks(&mut transport, 9);
        let next = passed(&transport, BLOCK_FRAMES)[0].0;
        assert_eq!(next, 47);
        transport.set(false, BAR, Place::default()).unwrap();
        play_blocks(&mut transport, 9);
        assert_eq!((transport.playing(), transport.position()), (false, 46));
        assert_eq!(passed(&transport, BLOCK_FRAMES), []);
        transport.set(true, BAR, Place::default()).unwrap();
        assert_eq!(passed(&transport, BLOCK_FRAMES)[0].0, next);
        // A start of its own.
        assert_eq!(transport.play(), Some(2));
    }

    #[test]
    fn a_place_not_taken_yet_puts_the_position_at_its_tick_which_plays() {
        let mut transport = Transport::new(SAMPLE_RATE);
        // Stopped, Play starts there.
        transport
            .set(
                false,
                BAR,
                Place {
                    press: 1,
                    tick: 100,
                },
            )
            .unwrap();
        assert_eq!((transport.playing(), transport.position()), (false, 100));
        transport
            .set(
                true,
                BAR,
                Place {
                    press: 1,
                    tick: 100,
                },
            )
            .unwrap();
        assert_eq!(passed(&transport, BLOCK_FRAMES)[0], (100, 0));
        // Playing, it plays anew from there: a start of its own, counted from it.
        play_blocks(&mut transport, 9);
        transport
            .set(true, BAR, Place { press: 2, tick: 7 })
            .unwrap();
        assert_eq!(transport.position(), 7);
        assert_eq!(passed(&transport, BLOCK_FRAMES)[0], (7, 0));
        assert_eq!(transport.play(), Some(2));
        assert_eq!(transport.run(BLOCK_FRAMES).map(|run| run.first), Some(0));
    }

    #[test]
    fn a_place_taken_is_not_taken_again() {
        let mut transport = Transport::new(SAMPLE_RATE);
        let place = Place {
            press: 5,
            tick: 100,
        };
        transport.set(true, BAR, place).unwrap();
        play_blocks(&mut transport, 9);
        let before = transport.state;
        transport.set(true, BAR, place).unwrap();
        assert_eq!(transport.state, before);
        transport.set(false, BAR, place).unwrap();
        assert_eq!(transport.position(), 146);
    }

    #[test]
    fn a_position_past_the_loop_s_end_stands_there_stopped_and_wraps_around_as_it_plays() {
        let mut transport = Transport::new(SAMPLE_RATE);
        let place = Place {
            press: 1,
            tick: BAR + 5,
        };
        transport.set(false, BAR, place).unwrap();
        assert_eq!(transport.position(), BAR + 5);
        // A loop shortened and back again leaves it where it stood.
        transport.set(false, 4, place).unwrap();
        transport.set(false, BAR, place).unwrap();
        assert_eq!(transport.position(), BAR + 5);
        transport.set(true, BAR, place).unwrap();
        assert_eq!(transport.position(), 5);
    }

    #[test]
    fn each_start_of_play_is_a_new_one_and_the_same_state_again_keeps_it() {
        let mut transport = Transport::new(SAMPLE_RATE);
        assert_eq!(transport.play(), None);
        transport.set(true, BAR, Place::default()).unwrap();
        transport.set(true, 2, Place::default()).unwrap();
        assert_eq!(transport.play(), Some(1));
        transport.set(false, BAR, Place::default()).unwrap();
        assert_eq!((transport.play(), transport.loop_ticks()), (None, None));
        transport.set(true, BAR, Place::default()).unwrap();
        assert_eq!(
            (transport.play(), transport.loop_ticks()),
            (Some(2), Some(BAR))
        );
    }

    #[test]
    fn a_shorter_loop_wraps_the_position_around() {
        let mut transport = playing(BAR);
        play_blocks(&mut transport, 3200 * FRAMES_PER_TICK / BLOCK_FRAMES);
        assert_eq!(transport.position(), 3200);
        transport
            .set(true, TICKS_PER_QUARTER, Place::default())
            .unwrap();
        assert_eq!(transport.position(), 3200 % TICKS_PER_QUARTER);
    }

    #[test]
    fn a_loop_of_no_ticks_or_a_tempo_not_a_number_is_refused_and_changes_nothing() {
        let mut transport = playing(BAR);
        play_blocks(&mut transport, 3);
        let before = transport.state;
        // Nor is its place taken.
        let place = Place { press: 1, tick: 9 };
        assert_eq!(transport.set(true, 0, place), Err(Rejection::InvalidValue));
        assert_eq!(transport.set(false, 0, place), Err(Rejection::InvalidValue));
        for bpm in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(transport.set_tempo(bpm), Err(Rejection::InvalidValue));
        }
        assert_eq!(
            (transport.state, transport.tempo(), transport.placed),
            (before, 120.0, 0)
        );
    }

    #[test]
    fn a_tempo_past_the_range_is_clamped() {
        for (bpm, clamped) in [(1.0, MIN_TEMPO), (0.0, MIN_TEMPO), (1000.0, MAX_TEMPO)] {
            let mut transport = playing(u32::MAX);
            transport.set_tempo(bpm).unwrap();
            assert_eq!(transport.tempo(), clamped as f32);
            play_blocks(&mut transport, 60 * SAMPLE_RATE as usize / BLOCK_FRAMES);
            assert_eq!(transport.position(), clamped * TICKS_PER_QUARTER, "{bpm}");
        }
    }

    #[test]
    fn an_hour_of_blocks_lands_on_exact_ticks() {
        let mut transport = playing(BAR);
        let blocks = 3600 * SAMPLE_RATE as usize / BLOCK_FRAMES;
        for block in 1..=blocks {
            transport.advance(BLOCK_FRAMES);
            let whole = (block * BLOCK_FRAMES / FRAMES_PER_TICK) as u32 % BAR;
            assert_eq!(transport.position(), whole, "{block}");
        }
    }

    /// At 48 kHz a block at each of these tempos moves the position by so many 8/25 of a tick.
    const TEMPOS: [(f32, u32); 4] = [(120.0, 16), (150.0, 20), (60.0, 8), (90.0, 12)];

    #[test]
    fn whole_ticks_stay_exact_through_changes_of_tempo() {
        let mut transport = playing(BAR);
        let mut moved = 0;
        for block in 0..2000 {
            let (bpm, by) = TEMPOS[block / 3 % TEMPOS.len()];
            transport.set_tempo(bpm).unwrap();
            transport.advance(BLOCK_FRAMES);
            moved += by;
            assert_eq!(transport.position(), moved * 8 / 25 % BAR, "{block}");
        }
    }

    #[test]
    fn whole_ticks_stay_exact_when_the_same_state_comes_again() {
        let mut transport = playing(BAR);
        for block in 1..=2000 {
            if block % 7 == 0 {
                transport.set(true, BAR, Place::default()).unwrap();
            }
            transport.advance(BLOCK_FRAMES);
            let whole = (block * BLOCK_FRAMES / FRAMES_PER_TICK) as u32 % BAR;
            assert_eq!(transport.position(), whole, "{block}");
        }
    }

    #[test]
    fn counts_the_finest_tempos_at_rates_a_tick_has_no_whole_frames_in() {
        for (bpm, sample_rate) in [
            ((MIN_TEMPO as f32).next_up(), 44_100),
            (128.5, 22_050),
            ((MAX_TEMPO as f32).next_down(), 96_000),
        ] {
            let mut transport = Transport::new(sample_rate as f32);
            transport.set(true, u32::MAX, Place::default()).unwrap();
            transport.set_tempo(bpm).unwrap();
            // In parts the tempo is exact, and so is frames × tempo × 960 / (60 × rate).
            let tempo = (f64::from(bpm) * PARTS_IN_ONE) as u128;
            for block in 1..=10_000u128 {
                transport.advance(BLOCK_FRAMES);
                let exact = block * BLOCK_FRAMES as u128 * tempo * u128::from(TICKS_PER_QUARTER)
                    / (60 * sample_rate * PARTS_IN_ONE as u128);
                assert_eq!(transport.position(), exact as u32, "{bpm} {block}");
            }
        }
    }

    /// Each tick the next block passes, with the frame it falls in.
    fn passed(transport: &Transport, frames: usize) -> Vec<(u32, u32)> {
        transport
            .stretches(frames)
            .flat_map(|stretch| {
                (stretch.first..=stretch.last).map(move |tick| (tick, stretch.frame(tick)))
            })
            .collect()
    }

    #[test]
    fn a_block_passes_the_ticks_from_its_position_up_to_the_next_block_s() {
        let mut transport = playing(BAR);
        // A block is 5.12 ticks at 120 and 48 kHz.
        assert_eq!(
            passed(&transport, BLOCK_FRAMES),
            [(0, 0), (1, 25), (2, 50), (3, 75), (4, 100), (5, 125)]
        );
        transport.advance(BLOCK_FRAMES);
        // Tick 6 is 0.88 of a tick, 22 frames, from 5.12.
        assert_eq!(
            passed(&transport, BLOCK_FRAMES),
            [(6, 22), (7, 47), (8, 72), (9, 97), (10, 122)]
        );
    }

    #[test]
    fn a_stopped_transport_passes_no_ticks() {
        assert_eq!(passed(&Transport::new(SAMPLE_RATE), BLOCK_FRAMES), []);
        assert_eq!(passed(&playing(BAR), 0), []);
    }

    #[test]
    fn where_the_loop_ends_within_a_block_the_ticks_go_on_from_its_start() {
        let mut transport = playing(1000);
        // At 998.4.
        play_blocks(&mut transport, 195);
        let stretches: Vec<_> = transport
            .stretches(BLOCK_FRAMES)
            .map(|stretch| (stretch.first, stretch.last))
            .collect();
        assert_eq!(stretches, [(999, 999), (0, 3)]);
        assert_eq!(
            passed(&transport, BLOCK_FRAMES),
            [(999, 15), (0, 40), (1, 65), (2, 90), (3, 115)]
        );
    }

    #[test]
    fn a_loop_shorter_than_a_block_is_passed_as_often_as_it_fits() {
        assert_eq!(
            passed(&playing(2), BLOCK_FRAMES),
            [(0, 0), (1, 25), (0, 50), (1, 75), (0, 100), (1, 125)]
        );
    }

    #[test]
    fn blocks_share_out_the_ticks_with_none_twice_and_none_left_out_through_changes_of_tempo() {
        // At 3 kHz, the lowest rate of Web Audio, a frame passes more than a tick at the fastest tempos.
        for (sample_rate, tempos) in [
            (48_000.0, [120.0, 173.3, 61.0, MAX_TEMPO as f32]),
            (3_000.0, [MAX_TEMPO as f32, MIN_TEMPO as f32, 333.3, 97.0]),
        ] {
            let loop_ticks = 7;
            let mut transport = Transport::new(sample_rate);
            transport.set(true, loop_ticks, Place::default()).unwrap();
            let mut next = 0;
            for block in 0..4000 {
                transport
                    .set_tempo(tempos[block / 3 % tempos.len()])
                    .unwrap();
                let mut earliest = 0;
                for (tick, frame) in passed(&transport, BLOCK_FRAMES) {
                    assert_eq!(tick, next % loop_ticks, "{sample_rate} {block}");
                    assert!(earliest <= frame && frame < BLOCK_FRAMES as u32);
                    (next, earliest) = (next + 1, frame);
                }
                transport.advance(BLOCK_FRAMES);
            }
            // The next tick to pass is the one after the position.
            let ahead = transport.stretches(BLOCK_FRAMES).next().map(|s| s.first);
            assert_eq!(ahead, Some(next % loop_ticks));
        }
    }

    #[test]
    fn the_run_passes_the_stretches_ticks_by_their_count_from_the_start_of_play_at_their_frames() {
        for (sample_rate, tempos) in [
            (48_000.0, [120.0, 173.3, 61.0, MAX_TEMPO as f32]),
            (3_000.0, [MAX_TEMPO as f32, MIN_TEMPO as f32, 333.3, 97.0]),
        ] {
            let mut transport = Transport::new(sample_rate);
            transport.set(true, 7, Place::default()).unwrap();
            let mut next = 0;
            for block in 0..4000 {
                transport
                    .set_tempo(tempos[block / 3 % tempos.len()])
                    .unwrap();
                let by_stretch: Vec<_> = transport
                    .stretches(BLOCK_FRAMES)
                    .flat_map(|stretch| {
                        (stretch.first..=stretch.last)
                            .map(move |tick| (stretch.count(tick), stretch.frame(tick)))
                    })
                    .collect();
                let by_run: Vec<_> = transport
                    .run(BLOCK_FRAMES)
                    .map(|run| {
                        (run.first..=run.last)
                            .map(|count| (count, run.frame(count)))
                            .collect()
                    })
                    .unwrap_or_default();
                assert_eq!(by_run, by_stretch, "{sample_rate} {block}");
                for (count, _) in by_run {
                    assert_eq!(count, next, "{sample_rate} {block}");
                    next += 1;
                }
                transport.advance(BLOCK_FRAMES);
            }
        }
    }

    #[test]
    fn the_count_goes_on_while_play_does_and_starts_anew_with_it() {
        let count = |transport: &Transport| transport.run(BLOCK_FRAMES).map(|run| run.first);
        let mut transport = playing(1000);
        // At 998.4, past the loop's end within the block.
        play_blocks(&mut transport, 195);
        assert_eq!(count(&transport), Some(999));
        transport.advance(BLOCK_FRAMES);
        assert_eq!(transport.position(), 3);
        assert_eq!(count(&transport), Some(1004));
        // The same state again, or a shorter loop, keeps it.
        transport.set(true, 1000, Place::default()).unwrap();
        transport.set(true, 2, Place::default()).unwrap();
        assert_eq!(count(&transport), Some(1004));
        transport.set(false, 2, Place::default()).unwrap();
        assert_eq!(count(&transport), None);
        // Counted afresh from the tick it stopped in, which went with the block before.
        transport.set(true, 1000, Place::default()).unwrap();
        assert_eq!(count(&transport), Some(1));
    }

    #[test]
    fn an_hour_of_blocks_passes_every_tick_in_the_frame_it_falls_in() {
        let (sample_rate, bpm) = (44_100, 173.0);
        let mut transport = Transport::new(sample_rate as f32);
        transport.set(true, u32::MAX, Place::default()).unwrap();
        transport.set_tempo(bpm).unwrap();
        let mut next = 0u64;
        for block in 0..3600 * sample_rate / BLOCK_FRAMES as u64 {
            for (tick, frame) in passed(&transport, BLOCK_FRAMES) {
                assert_eq!(u64::from(tick), next);
                // The frame whose stretch of positions holds the tick, counted from the start.
                let exact = u128::from(next) * 60 * u128::from(sample_rate)
                    / (bpm as u128 * u128::from(TICKS_PER_QUARTER));
                let heard = block * BLOCK_FRAMES as u64 + u64::from(frame);
                assert_eq!(u128::from(heard), exact, "tick {next}");
                next += 1;
            }
            transport.advance(BLOCK_FRAMES);
        }
    }
}
