use engine_plugins::catalog::tone;

use super::*;
use crate::heap;
use crate::testing::plugins::{CONSTANT, THROUGH};
use crate::testing::{SAMPLE_RATE, cell, handle};
use crate::{BLOCK_FRAMES, CHANNELS};

/// 20 ms at 48 kHz.
const FADE: usize = 960;

/// Plays 1 on the left and −1 on the right.
fn node(raw: u32) -> Box<Node> {
    Box::new(Node::new(&CONSTANT, SAMPLE_RATE, NodeHandle::new(raw)))
}

fn through(raw: u32) -> Box<Node> {
    Box::new(Node::new(&THROUGH, SAMPLE_RATE, NodeHandle::new(raw)))
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

fn full(source: Seat) -> Connection {
    Connection::new(source, true, Start::Full)
}

/// Each turn's node with its inputs, and the output's connections.
fn order(turns: Vec<(Seat, Vec<Connection>)>, heard: Vec<Connection>) -> Order {
    let mut connections = Vec::new();
    let turns = turns
        .into_iter()
        .map(|(node, inputs)| {
            let start = connections.len();
            connections.extend(inputs);
            Turn {
                node,
                inputs: start..connections.len(),
            }
        })
        .collect();
    let output = connections.len();
    connections.extend(heard);
    Order {
        turns,
        connections: connections.into(),
        output,
    }
}

/// Nodes that hear nothing, the first on the output.
fn alone(handles: &[u32]) -> Order {
    let turns = handles
        .iter()
        .map(|&raw| (Seat::Cell(cell(raw)), vec![]))
        .collect();
    order(turns, vec![full(Seat::Cell(cell(handles[0])))])
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
    let (mut first, mut second, mut far) = (Some(node(1)), Some(node(9)), Some(node(16)));
    let (mut larger, mut exits) = (Nodes::new(16), Nodes::new(8));
    let mut new_order = alone(&[9, 1]);
    let mut back = None;

    let before = heap::calls();
    assert!(graph.insert(cell(1), &mut first));
    graph.grow(Table::Cells, &mut larger);
    graph.grow(Table::Exits, &mut exits);
    assert!(graph.insert(cell(9), &mut second));
    let past_the_table = graph.insert(cell(16), &mut far);
    graph.reorder(&mut new_order);
    let output = render(&mut graph);
    let removed = graph.remove(cell(1), Exit::new(7));
    let past_the_exits = graph.remove(cell(9), Exit::new(8));
    graph.take_back(Exit::new(7), &mut back);
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
    assert_eq!(exits.len(), 4);
    assert!(removed && !past_the_exits);
    assert_eq!(back.map(|node| node.handle()), Some(NodeHandle::new(1)));
    assert_eq!(cells(&mut graph), [9]);
}

#[test]
fn a_handle_reaches_only_the_node_of_its_generation() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(2), &mut Some(node(handle(1, 2)))));
    assert!(graph.node_mut(NodeHandle::new(handle(1, 2))).is_some());
    assert!(graph.node_mut(NodeHandle::new(2)).is_none());
    assert!(graph.node_mut(NodeHandle::new(handle(2, 2))).is_none());
}

#[test]
fn growing_keeps_every_node_where_it_was() {
    let mut graph = graph(4);
    for handle in 1..4 {
        assert!(graph.insert(cell(handle), &mut Some(node(handle))));
    }
    assert!(graph.remove(cell(3), Exit::new(2)));
    graph.grow(Table::Cells, &mut Nodes::new(8));
    graph.grow(Table::Exits, &mut Nodes::new(8));
    assert_eq!(cells(&mut graph), [1, 2]);
    let mut back = None;
    graph.take_back(Exit::new(2), &mut back);
    assert!(back.is_some());
}

#[test]
fn every_node_renders_and_only_what_the_output_hears_is_heard() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    let tone = engine_plugins::catalog::find(tone::DESCRIPTION.id, tone::DESCRIPTION.version);
    let tone = Node::new(tone.unwrap(), SAMPLE_RATE, NodeHandle::new(2));
    assert!(graph.insert(cell(2), &mut Some(Box::new(tone))));
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
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    assert!(graph.insert(cell(2), &mut Some(node(2))));
    for handle in 3..6 {
        assert!(graph.insert(cell(handle), &mut Some(through(handle))));
    }
    let [one, two] = [Seat::Cell(cell(1)), Seat::Cell(cell(2))];
    let turns = vec![
        (one, vec![]),
        (two, vec![]),
        (Seat::Cell(cell(3)), vec![full(one), full(two)]),
        (Seat::Cell(cell(4)), vec![full(one)]),
        (Seat::Cell(cell(5)), vec![]),
    ];
    graph.reorder(&mut order(turns, vec![full(Seat::Cell(cell(3)))]));
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
    assert!(graph.insert(cell(5), &mut Some(through(5))));
    assert!(graph.insert(cell(9), &mut Some(node(9))));
    let turns = vec![
        (Seat::Cell(cell(9)), vec![]),
        (Seat::Cell(cell(5)), vec![full(Seat::Cell(cell(9)))]),
    ];
    graph.reorder(&mut order(turns, vec![full(Seat::Cell(cell(5)))]));
    assert_eq!(
        render(&mut graph),
        [[1.0; BLOCK_FRAMES], [-1.0; BLOCK_FRAMES]]
    );
}

#[test]
fn only_nodes_in_the_order_render() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    assert!(graph.insert(cell(2), &mut Some(node(2))));
    graph.reorder(&mut alone(&[2]));
    render(&mut graph);
    assert_eq!([left(&mut graph, 1), left(&mut graph, 2)], [0.0, 1.0]);
}

#[test]
fn with_nothing_to_hear_the_output_is_silent() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    graph.reorder(&mut order(vec![(Seat::Cell(cell(1)), vec![])], vec![]));
    assert_eq!(render(&mut graph), SILENCE);
}

#[test]
fn a_connection_rises_and_falls_in_equal_steps_over_20_ms() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    let rising = Connection::new(Seat::Cell(cell(1)), true, Start::Silent);
    graph.reorder(&mut order(
        vec![(Seat::Cell(cell(1)), vec![])],
        vec![rising],
    ));
    let up = heard(&mut graph, 8);
    assert!((up[0] - 1.0 / FADE as f32).abs() < 1e-6);
    assert!((up[FADE / 2 - 1] - 0.5).abs() < 1e-6);
    #[expect(clippy::float_cmp, reason = "the rise ends on 1 exactly")]
    let risen = up[FADE - 1..].iter().all(|&sample| sample == 1.0);
    assert!(risen);

    // Carried over from where it got to, then down.
    let falling = Connection::new(Seat::Cell(cell(1)), false, Start::As(0));
    graph.reorder(&mut order(
        vec![(Seat::Cell(cell(1)), vec![])],
        vec![falling],
    ));
    let down = heard(&mut graph, 8);
    assert!((down[0] - (1.0 - 1.0 / FADE as f32)).abs() < 1e-6);
    assert!(down[FADE - 1..].iter().all(|&sample| sample == 0.0));
}

#[test]
fn a_connection_turned_back_halfway_returns_from_where_it_got() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    let rising = Connection::new(Seat::Cell(cell(1)), true, Start::Silent);
    graph.reorder(&mut order(
        vec![(Seat::Cell(cell(1)), vec![])],
        vec![rising],
    ));
    let half = FADE / 2 / BLOCK_FRAMES;
    let up = heard(&mut graph, half);
    let falling = Connection::new(Seat::Cell(cell(1)), false, Start::As(0));
    graph.reorder(&mut order(
        vec![(Seat::Cell(cell(1)), vec![])],
        vec![falling],
    ));
    let down = heard(&mut graph, half + 1);
    let step = (down[0] - up[up.len() - 1]).abs();
    assert!(step <= 1.0 / FADE as f32 + 1e-6, "step {step}");
    assert_eq!(*down.last().unwrap(), 0.0, "silent sooner than a full fall");
}

#[test]
fn a_crossfade_keeps_the_sum_whole() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    assert!(graph.insert(cell(2), &mut Some(node(2))));
    let both = vec![(Seat::Cell(cell(1)), vec![]), (Seat::Cell(cell(2)), vec![])];
    graph.reorder(&mut order(both.clone(), vec![full(Seat::Cell(cell(1)))]));
    render(&mut graph);
    let falling = Connection::new(Seat::Cell(cell(1)), false, Start::As(0));
    let rising = Connection::new(Seat::Cell(cell(2)), true, Start::Silent);
    graph.reorder(&mut order(both, vec![falling, rising]));
    let crossfade = heard(&mut graph, 10);
    assert!(crossfade.iter().all(|&sample| (sample - 1.0).abs() < 1e-5));
}

#[test]
fn a_removed_node_plays_out_from_its_exit_while_its_cell_takes_another() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    graph.reorder(&mut alone(&[1]));
    render(&mut graph);
    assert!(graph.remove(cell(1), Exit::new(0)));
    assert!(graph.insert(cell(1), &mut Some(through(handle(1, 1)))));
    let playing_out = Seat::Exit(Exit::new(0));
    let turns = vec![(playing_out, vec![]), (Seat::Cell(cell(1)), vec![])];
    let falling = Connection::new(playing_out, false, Start::As(0));
    graph.reorder(&mut order(turns, vec![falling]));
    let out = heard(&mut graph, 8);
    assert!((out[0] - (1.0 - 1.0 / FADE as f32)).abs() < 1e-6);
    assert!(out[FADE - 1..].iter().all(|&sample| sample == 0.0));
    assert!(graph.node_mut(NodeHandle::new(handle(1, 1))).is_some());
}

#[test]
fn fading_never_touches_the_heap() {
    let mut graph = graph(4);
    assert!(graph.insert(cell(1), &mut Some(node(1))));
    assert!(graph.insert(cell(2), &mut Some(through(2))));
    let turns = vec![
        (Seat::Cell(cell(1)), vec![]),
        (
            Seat::Cell(cell(2)),
            vec![Connection::new(Seat::Cell(cell(1)), true, Start::Silent)],
        ),
    ];
    let heard = vec![
        Connection::new(Seat::Cell(cell(1)), false, Start::Full),
        Connection::new(Seat::Cell(cell(2)), true, Start::Silent),
    ];
    let mut wiring = order(turns, heard);
    let before = heap::calls();
    graph.reorder(&mut wiring);
    for _ in 0..10 {
        render(&mut graph);
    }
    assert_eq!(heap::calls().wrapping_sub(before), 0);
}
