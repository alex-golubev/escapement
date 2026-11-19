//! What the crate's tests share.

pub(crate) mod commands;
pub(crate) mod edits;
pub(crate) mod events;
pub(crate) mod plugins;
pub(crate) mod pool;

use engine_plugins::testing::SAMPLE_RATE;

use crate::BLOCK_FRAMES;
use crate::graph::{Order, Seat};
use crate::handle::{NodeCell, NodeHandle};
use crate::node::NOTE_ROOM;
use crate::transport::{DEFAULT_TEMPO, TICKS_PER_QUARTER};

/// At the default tempo and `SAMPLE_RATE`.
pub(crate) const FRAMES_PER_TICK: usize = 25;

const _: () = assert!(
    SAMPLE_RATE.get() as usize * 60
        == FRAMES_PER_TICK * DEFAULT_TEMPO as usize * TICKS_PER_QUARTER as usize
);

pub(crate) const BAR: u32 = 4 * TICKS_PER_QUARTER;

/// [`NOTE_ROOM`] as keys count.
pub(crate) fn note_room() -> u8 {
    u8::try_from(NOTE_ROOM).unwrap()
}

/// Whole ticks `blocks` full blocks pass at the default tempo, from the start.
pub(crate) fn ticks_in(blocks: usize) -> u32 {
    u32::try_from(blocks * BLOCK_FRAMES / FRAMES_PER_TICK).unwrap()
}

/// The handle of a cell in its `generation`, each 16 bits.
pub(crate) const fn handle(generation: u32, cell: u32) -> u32 {
    assert!(generation >> 16 == 0 && cell >> 16 == 0, "16 bits each");
    generation << 16 | cell
}

/// Of a node whose handle is `handle`.
pub(crate) fn cell(handle: u32) -> NodeCell {
    NodeHandle::new(handle).cell()
}

/// Each turn's node with its inputs as seats, and the output's.
pub(crate) fn wiring(order: &Order) -> (Vec<(Seat, Vec<Seat>)>, Vec<Seat>) {
    let sources = |range: std::ops::Range<usize>| {
        order.connections[range]
            .iter()
            .map(|connection| connection.source)
            .collect::<Vec<_>>()
    };
    let turns = order
        .turns
        .iter()
        .map(|turn| (turn.node, sources(turn.inputs.clone())))
        .collect();
    (turns, sources(order.output..order.connections.len()))
}

pub(crate) fn ramp(len: usize, from: f32) -> Vec<f32> {
    (0..len).map(|i| from + i as f32).collect()
}
