//! The nodes the audio thread plays, how they connect and what the output hears. Only swaps with a parcel change
//! what it holds, so the audio thread never allocates or frees. Every connection, the output's included, has a gain
//! that rises or falls over [`FADE_SECONDS`]: changing what is heard in one sample clicks.

use std::mem;
use std::ops::Range;

use engine_plugins::SampleRate;
use engine_plugins::smoothing::ramp_samples;

use crate::handle::{NodeCell, NodeHandle};
use crate::node::Node;
use crate::telemetry::NodeMeter;
use crate::{Block, SILENCE};

pub(crate) const FADE_SECONDS: f32 = 0.02;

/// Live nodes by cell, or removed ones by their exit while they play out. Cell 0 stays empty: 0 is no node.
pub(crate) struct Nodes(Box<[Option<Box<Node>>]>);

impl Nodes {
    /// Allocates, so only on the build thread.
    pub(crate) fn new(len: usize) -> Self {
        Self(std::iter::repeat_with(|| None).take(len).collect())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Table {
    Cells,
    Exits,
}

/// Where a removed node plays out, in the table of exits: its cell is free at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Exit(usize);

impl Exit {
    pub(crate) fn new(index: usize) -> Self {
        Self(index)
    }

    pub(crate) fn index(self) -> usize {
        self.0
    }
}

/// Where a node sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Seat {
    Cell(NodeCell),
    /// A removed node playing out.
    Exit(Exit),
}

/// A connection's gain once its order is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Start {
    Silent,
    Full,
    /// Where the previous order's connection at this index had got to.
    As(usize),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Connection {
    pub source: Seat,
    /// Heading for full, otherwise for silence.
    pub rising: bool,
    pub start: Start,
    /// Samples into the fade: 0 is silent, the fade's length full.
    level: u32,
}

impl Connection {
    pub(crate) fn new(source: Seat, rising: bool, start: Start) -> Self {
        Self {
            source,
            rising,
            start,
            level: 0,
        }
    }

    /// Adds `heard` at this connection's gain, moving the gain a sample at a time.
    fn add(&mut self, heard: &Block, fade: u32, frames: usize, sum: &mut Block) {
        let target = if self.rising { fade } else { 0 };
        if self.level == target {
            if target == 0 {
                return;
            }
            for (sum, heard) in sum.iter_mut().zip(heard) {
                for (sum, sample) in sum[..frames].iter_mut().zip(&heard[..frames]) {
                    *sum += sample;
                }
            }
            return;
        }
        let rising = self.rising;
        let per_level = (fade as f32).recip();
        let step = |level: u32| {
            if rising {
                (level + 1).min(fade)
            } else {
                level.saturating_sub(1)
            }
        };
        let mut after = self.level;
        for (sum, heard) in sum.iter_mut().zip(heard) {
            let mut level = self.level;
            for (sum, sample) in sum[..frames].iter_mut().zip(&heard[..frames]) {
                level = step(level);
                *sum += sample * (level as f32 * per_level);
            }
            // Every channel moves the gain alike.
            after = level;
        }
        self.level = after;
    }
}

/// A node to render and where its inputs lie in the order's connections.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Turn {
    pub node: Seat,
    pub inputs: Range<usize>,
}

/// Every node in turn, after the nodes it hears: a block costs the nodes, not the table's size.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Order {
    pub turns: Box<[Turn]>,
    /// Every turn's inputs, then the output's.
    pub connections: Box<[Connection]>,
    /// Where the output's connections start.
    pub output: usize,
}

pub(crate) struct Graph {
    cells: Nodes,
    exits: Nodes,
    order: Order,
    /// Samples a connection takes to rise or fall.
    fade: u32,
    /// The input of the node being rendered.
    input: Block,
}

impl Graph {
    pub(crate) fn new(cells: Nodes, exits: Nodes, sample_rate: SampleRate) -> Self {
        Self {
            cells,
            exits,
            order: Order::default(),
            fade: ramp_samples(FADE_SECONDS, sample_rate),
            input: SILENCE,
        }
    }

    pub(crate) fn fade(&self) -> u32 {
        self.fade
    }

    /// Only a live node under this very handle: one of an older generation is gone.
    pub(crate) fn node_mut(&mut self, handle: NodeHandle) -> Option<&mut Node> {
        let node = self
            .cells
            .0
            .get_mut(handle.cell().index())?
            .as_deref_mut()?;
        (node.handle() == handle).then_some(node)
    }

    /// Moves the nodes over to `larger`, an empty table, and swaps it in; the old one comes back empty.
    pub(crate) fn grow(&mut self, table: Table, larger: &mut Nodes) {
        let nodes = match table {
            Table::Cells => &mut self.cells,
            Table::Exits => &mut self.exits,
        };
        for (old, new) in nodes.0.iter_mut().zip(larger.0.iter_mut()) {
            mem::swap(old, new);
        }
        mem::swap(nodes, larger);
    }

    /// Swaps `slot` into the cell; what was there, nothing as the build thread keeps track, comes back in it. False
    /// past the table: the node stays in `slot`.
    #[must_use]
    pub(crate) fn insert(&mut self, cell: NodeCell, slot: &mut Option<Box<Node>>) -> bool {
        let Some(cell) = self.cells.0.get_mut(cell.index()) else {
            return false;
        };
        mem::swap(cell, slot);
        true
    }

    /// Moves the node out of its cell to play out at `exit`, so the cell is free at once. False past either table.
    #[must_use]
    pub(crate) fn remove(&mut self, cell: NodeCell, exit: Exit) -> bool {
        let (Some(cell), Some(exit)) = (
            self.cells.0.get_mut(cell.index()),
            self.exits.0.get_mut(exit.index()),
        ) else {
            return false;
        };
        mem::swap(cell, exit);
        true
    }

    /// Swaps the node that played out at `exit` into `slot`, to go back to the build thread.
    pub(crate) fn take_back(&mut self, exit: Exit, slot: &mut Option<Box<Node>>) {
        if let Some(exit) = self.exits.0.get_mut(exit.index()) {
            mem::swap(exit, slot);
        }
    }

    /// Swaps in `order`, which comes back holding the old one; each connection starts as it says.
    pub(crate) fn reorder(&mut self, order: &mut Order) {
        mem::swap(&mut self.order, order);
        let previous = &order.connections;
        for connection in &mut self.order.connections {
            connection.level = match connection.start {
                Start::Silent => 0,
                Start::Full => self.fade,
                Start::As(index) => previous.get(index).map_or(0, |old| old.level),
            };
        }
    }

    /// Hands `report` the meter of each node in the order that has one, live ones only: not those playing out.
    pub(crate) fn each_meter(&mut self, mut report: impl FnMut(&mut NodeMeter)) {
        let Self { cells, order, .. } = self;
        for turn in &order.turns {
            if let Seat::Cell(cell) = turn.node
                && let Some(meter) = cells
                    .0
                    .get_mut(cell.index())
                    .and_then(|node| node.as_deref_mut())
                    .and_then(Node::meter_mut)
            {
                report(meter);
            }
        }
    }

    /// Every node in the order renders on the sum of its inputs, heard or not; the output gets the sum of its own.
    pub(crate) fn process(&mut self, frames: usize, output: &mut Block) {
        let Self {
            cells,
            exits,
            order,
            fade,
            input,
        } = self;
        let Order {
            turns,
            connections,
            output: first_output,
        } = order;
        let (inputs, heard) = connections.split_at_mut(*first_output);
        for turn in turns.iter() {
            // Gone back to the build thread, it waits only for the next order to drop it.
            if node(cells, exits, turn.node).is_none() {
                continue;
            }
            let inputs = &mut inputs[turn.inputs.clone()];
            let block = if inputs.is_empty() {
                &SILENCE
            } else {
                mix(cells, exits, inputs, *fade, frames, input);
                &*input
            };
            if let Some(node) = node_mut(cells, exits, turn.node) {
                node.process(block, frames);
            }
        }
        mix(cells, exits, heard, *fade, frames, output);
    }
}

fn node<'a>(cells: &'a Nodes, exits: &'a Nodes, seat: Seat) -> Option<&'a Node> {
    match seat {
        Seat::Cell(cell) => cells.0.get(cell.index())?.as_deref(),
        Seat::Exit(exit) => exits.0.get(exit.index())?.as_deref(),
    }
}

fn node_mut<'a>(cells: &'a mut Nodes, exits: &'a mut Nodes, seat: Seat) -> Option<&'a mut Node> {
    match seat {
        Seat::Cell(cell) => cells.0.get_mut(cell.index())?.as_deref_mut(),
        Seat::Exit(exit) => exits.0.get_mut(exit.index())?.as_deref_mut(),
    }
}

/// Sums the sources' last blocks into `sum`, each at its connection's gain.
fn mix(
    cells: &Nodes,
    exits: &Nodes,
    connections: &mut [Connection],
    fade: u32,
    frames: usize,
    sum: &mut Block,
) {
    for channel in sum.iter_mut() {
        channel[..frames].fill(0.0);
    }
    for connection in connections {
        // A source gone back to the build thread has faded out.
        if let Some(source) = node(cells, exits, connection.source) {
            connection.add(source.output(), fade, frames, sum);
        }
    }
}

#[cfg(test)]
mod tests;
