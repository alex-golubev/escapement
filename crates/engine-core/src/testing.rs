//! What the crate's tests share.

pub(crate) mod commands;
pub(crate) mod edits;
pub(crate) mod events;
pub(crate) mod plugins;
pub(crate) mod pool;

use engine_plugins::{ParamNumber, SampleNumber, SampleRate};

use crate::BLOCK_FRAMES;
use crate::handle::{NodeCell, NodeHandle};
use crate::node::NOTE_ROOM;
use crate::transport::{DEFAULT_TEMPO, TICKS_PER_QUARTER};

pub(crate) const SAMPLE_RATE: SampleRate = SampleRate::new(48_000).unwrap();

/// At the default tempo and `SAMPLE_RATE`.
pub(crate) const FRAMES_PER_TICK: usize = 25;

const _: () = assert!(
    SAMPLE_RATE.get() as usize * 60
        == FRAMES_PER_TICK * DEFAULT_TEMPO as usize * TICKS_PER_QUARTER as usize
);

pub(crate) const BAR: u32 = 4 * TICKS_PER_QUARTER;

pub(crate) fn rate(hz: u32) -> SampleRate {
    SampleRate::new(hz).unwrap()
}

/// The frames `seconds` take at [`SAMPLE_RATE`].
pub(crate) const fn seconds(seconds: f32) -> usize {
    SAMPLE_RATE.frames(seconds) as usize
}

/// As a command names it.
pub(crate) fn param_number(number: u32) -> ParamNumber {
    ParamNumber::new(number).unwrap()
}

/// As an edit names it.
pub(crate) fn sample_number(number: u32) -> SampleNumber {
    SampleNumber::new(number).unwrap()
}

/// [`NOTE_ROOM`] as keys count.
pub(crate) fn note_room() -> u8 {
    u8::try_from(NOTE_ROOM).unwrap()
}

/// Whole ticks `blocks` full blocks pass at the default tempo, from the start.
pub(crate) fn ticks_in(blocks: usize) -> u32 {
    u32::try_from(blocks * BLOCK_FRAMES / FRAMES_PER_TICK).unwrap()
}

/// Of a node whose handle is `handle`.
pub(crate) fn cell(handle: u32) -> NodeCell {
    NodeHandle::new(handle).cell()
}

pub(crate) fn ramp(len: usize, from: f32) -> Vec<f32> {
    (0..len).map(|i| from + i as f32).collect()
}
