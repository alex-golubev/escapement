//! What the crate's tests share.

use crate::transport::{DEFAULT_TEMPO, TICKS_PER_QUARTER};
use crate::{BLOCK_FRAMES, CHANNELS};

pub const SAMPLE_RATE: f32 = 48_000.0;

/// At the default tempo and `SAMPLE_RATE`.
pub const FRAMES_PER_TICK: usize = 25;

const _: () = assert!(
    SAMPLE_RATE as usize * 60
        == FRAMES_PER_TICK * DEFAULT_TEMPO as usize * TICKS_PER_QUARTER as usize
);

pub const BAR: u32 = 4 * TICKS_PER_QUARTER;

pub const SILENCE: [[f32; BLOCK_FRAMES]; CHANNELS] = [[0.0; BLOCK_FRAMES]; CHANNELS];
