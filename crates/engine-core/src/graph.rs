//! The nodes the audio thread plays, how they connect and what the output hears. Only swaps with a parcel change
//! what it holds, so the audio thread never allocates or frees. Every connection, the output's included, has a gain
//! that rises or falls over [`FADE_SECONDS`]: changing what is heard in one sample clicks.

use std::mem;

use engine_plugins::smoothing::ramp_samples;

use crate::handle::NodeHandle;
use crate::node::Node;
use crate::telemetry::NodeMeter;
use crate::{BLOCK_FRAMES, CHANNELS};

pub(crate) const FADE_SECONDS: f32 = 0.02;

/// What a node without connections hears.
static SILENCE: [[f32; BLOCK_FRAMES]; CHANNELS] = [[0.0; BLOCK_FRAMES]; CHANNELS];

type Block = [[f32; BLOCK_FRAMES]; CHANNELS];

/// Live nodes by cell, or removed ones by their place while they play out. Cell 0 stays empty: 0 is no node.
pub(crate) struct Nodes(Box<[Option<Box<Node>>]>);

impl Nodes {
    /// Allocates, so only on the build thread.
    pub fn new(len: usize) -> Self {
        Self(std::iter::repeat_with(|| None).take(len).collect())
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Table {
    Cells,
    Leaving,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Place {
    Cell(u32),
    /// A removed node playing out.
    Leaving(u32),
}

/// A connection's gain once its order is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Start {
    Silent,
    Full,
    /// Where the previous order's connection at this index had got to.
    As(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Connection {
    pub source: Place,
    /// Heading for full, otherwise for silence.
    pub rising: bool,
    pub start: Start,
    /// Samples into the fade: 0 is silent, the fade's length full.
    level: u32,
}

impl Connection {
    pub fn new(source: Place, rising: bool, start: Start) -> Self {
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
        let moved = |level: u32, samples: u32| {
            if rising {
                (level + samples).min(fade)
            } else {
                level.saturating_sub(samples)
            }
        };
        for (sum, heard) in sum.iter_mut().zip(heard) {
            let mut level = self.level;
            for (sum, sample) in sum[..frames].iter_mut().zip(&heard[..frames]) {
                level = moved(level, 1);
                *sum += sample * (level as f32 * per_level);
            }
        }
        self.level = moved(self.level, frames as u32);
    }
}

/// A node to render and where its inputs lie in the order's connections.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Step {
    pub node: Place,
    pub inputs: (u32, u32),
}

/// Every node in turn, after the nodes it hears: a block costs the nodes, not the table's size.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Order {
    pub steps: Box<[Step]>,
    /// Every step's inputs, then the output's.
    pub connections: Box<[Connection]>,
    /// Where the output's connections start.
    pub output: u32,
}

pub(crate) struct Graph {
    cells: Nodes,
    leaving: Nodes,
    order: Order,
    /// Samples a connection takes to rise or fall.
    fade: u32,
    /// The input of the node being rendered.
    input: Block,
}

impl Graph {
    pub fn new(cells: Nodes, leaving: Nodes, sample_rate: f32) -> Self {
        Self {
            cells,
            leaving,
            order: Order::default(),
            fade: ramp_samples(FADE_SECONDS, sample_rate),
            input: [[0.0; BLOCK_FRAMES]; CHANNELS],
        }
    }

    pub fn fade(&self) -> u32 {
        self.fade
    }

    /// Only a live node under this very handle: one of an older generation is gone.
    pub fn node_mut(&mut self, handle: NodeHandle) -> Option<&mut Node> {
        let node = self
            .cells
            .0
            .get_mut(handle.cell() as usize)?
            .as_deref_mut()?;
        (node.handle() == handle).then_some(node)
    }

    /// Moves the nodes over to `larger`, an empty table, and swaps it in; the old one comes back empty.
    pub fn grow(&mut self, table: Table, larger: &mut Nodes) {
        let nodes = match table {
            Table::Cells => &mut self.cells,
            Table::Leaving => &mut self.leaving,
        };
        for (old, new) in nodes.0.iter_mut().zip(larger.0.iter_mut()) {
            mem::swap(old, new);
        }
        mem::swap(nodes, larger);
    }

    /// Swaps `slot` into the cell; what was there, nothing as the build thread keeps track, comes back in it. False
    /// past the table: the node stays in `slot`.
    pub fn insert(&mut self, cell: u32, slot: &mut Option<Box<Node>>) -> bool {
        let Some(cell) = self.cells.0.get_mut(cell as usize) else {
            return false;
        };
        mem::swap(cell, slot);
        true
    }

    /// Moves the node out of its cell to play out at `place`, so the cell is free at once. False past either table.
    pub fn remove(&mut self, cell: u32, place: u32) -> bool {
        let (Some(cell), Some(place)) = (
            self.cells.0.get_mut(cell as usize),
            self.leaving.0.get_mut(place as usize),
        ) else {
            return false;
        };
        mem::swap(cell, place);
        true
    }

    /// Swaps the node that played out at `place` into `slot`, to go back to the build thread.
    pub fn take_back(&mut self, place: u32, slot: &mut Option<Box<Node>>) {
        if let Some(place) = self.leaving.0.get_mut(place as usize) {
            mem::swap(place, slot);
        }
    }

    /// Swaps in `order`, which comes back holding the old one; each connection starts as it says.
    pub fn reorder(&mut self, order: &mut Order) {
        mem::swap(&mut self.order, order);
        let previous = &order.connections;
        for connection in self.order.connections.iter_mut() {
            connection.level = match connection.start {
                Start::Silent => 0,
                Start::Full => self.fade,
                Start::As(index) => previous.get(index as usize).map_or(0, |old| old.level),
            };
        }
    }

    /// Hands `report` the meter of each node in the order that has one, live ones only: not those playing out.
    pub fn each_meter(&mut self, mut report: impl FnMut(&mut NodeMeter)) {
        let Self { cells, order, .. } = self;
        for step in order.steps.iter() {
            if let Place::Cell(cell) = step.node
                && let Some(meter) = cells
                    .0
                    .get_mut(cell as usize)
                    .and_then(|node| node.as_deref_mut())
                    .and_then(Node::meter_mut)
            {
                report(meter);
            }
        }
    }

    /// Every node in the order renders on the sum of its inputs, heard or not; the output gets the sum of its own.
    pub fn process(&mut self, frames: usize, output: &mut Block) {
        let Self {
            cells,
            leaving,
            order,
            fade,
            input,
        } = self;
        let Order {
            steps,
            connections,
            output: first_output,
        } = order;
        let (inputs, heard) = connections.split_at_mut(*first_output as usize);
        for step in steps.iter() {
            // Gone back to the build thread, it waits only for the next order to drop it.
            if node(cells, leaving, step.node).is_none() {
                continue;
            }
            let (start, end) = step.inputs;
            let inputs = &mut inputs[start as usize..end as usize];
            let block = if inputs.is_empty() {
                &SILENCE
            } else {
                mix(cells, leaving, inputs, *fade, frames, input);
                &*input
            };
            if let Some(node) = node_mut(cells, leaving, step.node) {
                node.process(block, frames);
            }
        }
        mix(cells, leaving, heard, *fade, frames, output);
    }
}

fn node<'a>(cells: &'a Nodes, leaving: &'a Nodes, place: Place) -> Option<&'a Node> {
    match place {
        Place::Cell(cell) => cells.0.get(cell as usize)?.as_deref(),
        Place::Leaving(place) => leaving.0.get(place as usize)?.as_deref(),
    }
}

fn node_mut<'a>(
    cells: &'a mut Nodes,
    leaving: &'a mut Nodes,
    place: Place,
) -> Option<&'a mut Node> {
    match place {
        Place::Cell(cell) => cells.0.get_mut(cell as usize)?.as_deref_mut(),
        Place::Leaving(place) => leaving.0.get_mut(place as usize)?.as_deref_mut(),
    }
}

/// Sums the sources' last blocks into `sum`, each at its connection's gain.
fn mix(
    cells: &Nodes,
    leaving: &Nodes,
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
        if let Some(source) = node(cells, leaving, connection.source) {
            connection.add(source.output(), fade, frames, sum);
        }
    }
}

#[cfg(test)]
mod tests {
    use engine_plugins::catalog::tone;

    use super::*;
    use crate::heap;
    use crate::node::tests::{CONSTANT, THROUGH};
    use crate::testing::SAMPLE_RATE;
    /// 20 ms at 48 kHz.
    const FADE: usize = 960;

    /// Plays 1 on the left and −1 on the right.
    fn node(cell: u32) -> Option<Box<Node>> {
        Some(Box::new(Node::new(
            &CONSTANT,
            SAMPLE_RATE,
            NodeHandle::new(cell),
        )))
    }

    fn through(cell: u32) -> Option<Box<Node>> {
        Some(Box::new(Node::new(
            &THROUGH,
            SAMPLE_RATE,
            NodeHandle::new(cell),
        )))
    }

    fn graph(cells: usize) -> Graph {
        Graph::new(Nodes::new(cells), Nodes::new(4), SAMPLE_RATE)
    }

    /// Cells holding a node.
    fn cells(graph: &mut Graph) -> Vec<u32> {
        (0..64)
            .filter(|&cell| graph.node_mut(NodeHandle::new(cell)).is_some())
            .collect()
    }

    fn full(source: Place) -> Connection {
        Connection::new(source, true, Start::Full)
    }

    /// Steps with their inputs, and the output's connections.
    fn order(steps: Vec<(Place, Vec<Connection>)>, heard: Vec<Connection>) -> Order {
        let mut connections = Vec::new();
        let steps = steps
            .into_iter()
            .map(|(node, inputs)| {
                let start = connections.len() as u32;
                connections.extend(inputs);
                Step {
                    node,
                    inputs: (start, connections.len() as u32),
                }
            })
            .collect();
        let output = connections.len() as u32;
        connections.extend(heard);
        Order {
            steps,
            connections: connections.into(),
            output,
        }
    }

    /// Nodes that hear nothing, the first on the output.
    fn alone(cells: &[u32]) -> Order {
        let steps = cells
            .iter()
            .map(|&cell| (Place::Cell(cell), vec![]))
            .collect();
        order(steps, vec![full(Place::Cell(cells[0]))])
    }

    fn left(graph: &mut Graph, cell: u32) -> f32 {
        graph.node_mut(NodeHandle::new(cell)).unwrap().output()[0][0]
    }

    fn render(graph: &mut Graph) -> Block {
        let mut output = [[f32::NAN; BLOCK_FRAMES]; CHANNELS];
        graph.process(BLOCK_FRAMES, &mut output);
        output
    }

    /// The left channel of `blocks` blocks.
    fn heard(graph: &mut Graph, blocks: usize) -> Vec<f32> {
        (0..blocks).flat_map(|_| render(graph)[0]).collect()
    }

    #[test]
    fn swaps_bring_nodes_in_and_take_what_they_displace_out_without_the_heap() {
        let mut graph = graph(4);
        let (mut first, mut second, mut far) = (node(1), node(9), node(16));
        let (mut larger, mut leaving) = (Nodes::new(16), Nodes::new(8));
        let mut new_order = alone(&[9, 1]);
        let mut back = None;

        let before = heap::calls();
        graph.insert(1, &mut first);
        graph.grow(Table::Cells, &mut larger);
        graph.grow(Table::Leaving, &mut leaving);
        graph.insert(9, &mut second);
        let past_the_table = graph.insert(16, &mut far);
        graph.reorder(&mut new_order);
        let output = render(&mut graph);
        let removed = graph.remove(1, 7);
        let past_the_places = graph.remove(9, 8);
        graph.take_back(7, &mut back);
        let calls = heap::calls().wrapping_sub(before);

        assert_eq!(calls, 0);
        assert!(first.is_none() && second.is_none());
        assert!(
            !past_the_table && far.is_some(),
            "the node stays with the parcel"
        );
        assert_eq!(new_order, Order::default(), "the old order came back");
        assert_eq!(output, [[1.0; BLOCK_FRAMES], [-1.0; BLOCK_FRAMES]]);
        // The old tables came back empty.
        assert_eq!(larger.len(), 4);
        assert!(larger.0.iter().all(Option::is_none));
        assert_eq!(leaving.len(), 4);
        assert!(removed && !past_the_places);
        assert_eq!(back.map(|node| node.handle()), Some(NodeHandle::new(1)));
        assert_eq!(cells(&mut graph), [9]);
    }

    #[test]
    fn a_handle_reaches_only_the_node_of_its_generation() {
        let mut graph = graph(4);
        graph.insert(2, &mut node(1 << 16 | 2));
        assert!(graph.node_mut(NodeHandle::new(1 << 16 | 2)).is_some());
        assert!(graph.node_mut(NodeHandle::new(2)).is_none());
        assert!(graph.node_mut(NodeHandle::new(2 << 16 | 2)).is_none());
    }

    #[test]
    fn growing_keeps_every_node_where_it_was() {
        let mut graph = graph(4);
        for cell in 1..4 {
            graph.insert(cell, &mut node(cell));
        }
        graph.remove(3, 2);
        graph.grow(Table::Cells, &mut Nodes::new(8));
        graph.grow(Table::Leaving, &mut Nodes::new(8));
        assert_eq!(cells(&mut graph), [1, 2]);
        let mut back = None;
        graph.take_back(2, &mut back);
        assert!(back.is_some());
    }

    #[test]
    fn every_node_renders_and_only_what_the_output_hears_is_heard() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        let tone = engine_plugins::catalog::find(tone::DESCRIPTION.id, tone::DESCRIPTION.version);
        let tone = Node::new(tone.unwrap(), SAMPLE_RATE, NodeHandle::new(2));
        graph.insert(2, &mut Some(Box::new(tone)));
        graph.reorder(&mut alone(&[1, 2]));
        assert_eq!(
            render(&mut graph),
            [[1.0; BLOCK_FRAMES], [-1.0; BLOCK_FRAMES]]
        );
        let unheard = graph.node_mut(NodeHandle::new(2)).unwrap().output()[0];
        assert!(unheard.iter().any(|&sample| sample != 0.0));
    }

    #[test]
    fn a_node_hears_the_sum_of_its_inputs_and_a_node_can_feed_several() {
        let mut graph = graph(8);
        graph.insert(1, &mut node(1));
        graph.insert(2, &mut node(2));
        for cell in 3..6 {
            graph.insert(cell, &mut through(cell));
        }
        let [one, two] = [Place::Cell(1), Place::Cell(2)];
        let steps = vec![
            (one, vec![]),
            (two, vec![]),
            (Place::Cell(3), vec![full(one), full(two)]),
            (Place::Cell(4), vec![full(one)]),
            (Place::Cell(5), vec![]),
        ];
        graph.reorder(&mut order(steps, vec![full(Place::Cell(3))]));
        assert_eq!(
            render(&mut graph),
            [[2.0; BLOCK_FRAMES], [-2.0; BLOCK_FRAMES]]
        );
        assert_eq!(left(&mut graph, 4), 1.0);
        assert_eq!(left(&mut graph, 5), 0.0, "no inputs, silence");
    }

    #[test]
    fn a_node_renders_after_the_nodes_it_hears_in_this_block() {
        let mut graph = graph(16);
        graph.insert(5, &mut through(5));
        graph.insert(9, &mut node(9));
        let steps = vec![
            (Place::Cell(9), vec![]),
            (Place::Cell(5), vec![full(Place::Cell(9))]),
        ];
        graph.reorder(&mut order(steps, vec![full(Place::Cell(5))]));
        assert_eq!(
            render(&mut graph),
            [[1.0; BLOCK_FRAMES], [-1.0; BLOCK_FRAMES]]
        );
    }

    #[test]
    fn only_nodes_in_the_order_render() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        graph.insert(2, &mut node(2));
        graph.reorder(&mut alone(&[2]));
        render(&mut graph);
        assert_eq!([left(&mut graph, 1), left(&mut graph, 2)], [0.0, 1.0]);
    }

    #[test]
    fn with_nothing_to_hear_the_output_is_silent() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        graph.reorder(&mut order(vec![(Place::Cell(1), vec![])], vec![]));
        assert_eq!(render(&mut graph), [[0.0; BLOCK_FRAMES]; CHANNELS]);
    }

    #[test]
    fn a_connection_rises_and_falls_in_equal_steps_over_20_ms() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        let rising = Connection::new(Place::Cell(1), true, Start::Silent);
        graph.reorder(&mut order(vec![(Place::Cell(1), vec![])], vec![rising]));
        let up = heard(&mut graph, 8);
        assert!((up[0] - 1.0 / FADE as f32).abs() < 1e-6);
        assert!((up[FADE / 2 - 1] - 0.5).abs() < 1e-6);
        assert!(up[FADE - 1..].iter().all(|&sample| sample == 1.0));

        // Carried over from where it got to, then down.
        let falling = Connection::new(Place::Cell(1), false, Start::As(0));
        graph.reorder(&mut order(vec![(Place::Cell(1), vec![])], vec![falling]));
        let down = heard(&mut graph, 8);
        assert!((down[0] - (1.0 - 1.0 / FADE as f32)).abs() < 1e-6);
        assert!(down[FADE - 1..].iter().all(|&sample| sample == 0.0));
    }

    #[test]
    fn a_connection_turned_back_halfway_returns_from_where_it_got() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        let rising = Connection::new(Place::Cell(1), true, Start::Silent);
        graph.reorder(&mut order(vec![(Place::Cell(1), vec![])], vec![rising]));
        let half = FADE / 2 / BLOCK_FRAMES;
        let up = heard(&mut graph, half);
        let falling = Connection::new(Place::Cell(1), false, Start::As(0));
        graph.reorder(&mut order(vec![(Place::Cell(1), vec![])], vec![falling]));
        let down = heard(&mut graph, half + 1);
        let step = (down[0] - up[up.len() - 1]).abs();
        assert!(step <= 1.0 / FADE as f32 + 1e-6, "step {step}");
        assert_eq!(*down.last().unwrap(), 0.0, "silent sooner than a full fall");
    }

    #[test]
    fn a_crossfade_keeps_the_sum_whole() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        graph.insert(2, &mut node(2));
        let both = vec![(Place::Cell(1), vec![]), (Place::Cell(2), vec![])];
        graph.reorder(&mut order(both.clone(), vec![full(Place::Cell(1))]));
        render(&mut graph);
        let falling = Connection::new(Place::Cell(1), false, Start::As(0));
        let rising = Connection::new(Place::Cell(2), true, Start::Silent);
        graph.reorder(&mut order(both, vec![falling, rising]));
        let crossfade = heard(&mut graph, 10);
        assert!(crossfade.iter().all(|&sample| (sample - 1.0).abs() < 1e-5));
    }

    #[test]
    fn a_removed_node_plays_out_from_its_place_while_its_cell_takes_another() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        graph.reorder(&mut alone(&[1]));
        render(&mut graph);
        graph.remove(1, 0);
        graph.insert(1, &mut through(1 << 16 | 1));
        let leaving = Place::Leaving(0);
        let steps = vec![(leaving, vec![]), (Place::Cell(1), vec![])];
        let falling = Connection::new(leaving, false, Start::As(0));
        graph.reorder(&mut order(steps, vec![falling]));
        let out = heard(&mut graph, 8);
        assert!((out[0] - (1.0 - 1.0 / FADE as f32)).abs() < 1e-6);
        assert!(out[FADE - 1..].iter().all(|&sample| sample == 0.0));
        assert!(graph.node_mut(NodeHandle::new(1 << 16 | 1)).is_some());
    }

    #[test]
    fn fading_never_touches_the_heap() {
        let mut graph = graph(4);
        graph.insert(1, &mut node(1));
        graph.insert(2, &mut through(2));
        let steps = vec![
            (Place::Cell(1), vec![]),
            (
                Place::Cell(2),
                vec![Connection::new(Place::Cell(1), true, Start::Silent)],
            ),
        ];
        let heard = vec![
            Connection::new(Place::Cell(1), false, Start::Full),
            Connection::new(Place::Cell(2), true, Start::Silent),
        ];
        let mut wiring = order(steps, heard);
        let before = heap::calls();
        graph.reorder(&mut wiring);
        for _ in 0..10 {
            render(&mut graph);
        }
        assert_eq!(heap::calls().wrapping_sub(before), 0);
    }
}
