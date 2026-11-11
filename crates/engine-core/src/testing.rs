//! What the crate's tests share.

use engine_plugins::{ParamNumber, SampleNumber, SampleRate};

use crate::handle::{NodeCell, NodeHandle};
use crate::transport::{DEFAULT_TEMPO, TICKS_PER_QUARTER};
use crate::{BLOCK_FRAMES, CHANNELS};

pub const SAMPLE_RATE: SampleRate = SampleRate::new(48_000).unwrap();

/// At the default tempo and `SAMPLE_RATE`.
pub const FRAMES_PER_TICK: usize = 25;

const _: () = assert!(
    SAMPLE_RATE.get() as usize * 60
        == FRAMES_PER_TICK * DEFAULT_TEMPO as usize * TICKS_PER_QUARTER as usize
);

pub const BAR: u32 = 4 * TICKS_PER_QUARTER;

pub const SILENCE: [[f32; BLOCK_FRAMES]; CHANNELS] = [[0.0; BLOCK_FRAMES]; CHANNELS];

pub fn rate(hz: u32) -> SampleRate {
    SampleRate::new(hz).unwrap()
}

/// The frames `seconds` take at [`SAMPLE_RATE`].
pub const fn seconds(seconds: f32) -> usize {
    SAMPLE_RATE.frames(seconds) as usize
}

/// As a command names it.
pub fn param_number(number: u32) -> ParamNumber {
    ParamNumber::new(number).unwrap()
}

/// As an edit names it.
pub fn sample_number(number: u32) -> SampleNumber {
    SampleNumber::new(number).unwrap()
}

/// Of a node whose handle is `handle`.
pub fn cell(handle: u32) -> NodeCell {
    NodeHandle::new(handle).cell()
}
