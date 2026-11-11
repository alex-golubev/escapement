use engine_plugins::catalog::tone;

use super::*;
use crate::graph::{Exit, Order, Seat};
use crate::handoff::{self, Arrival, AudioEnd};
use crate::strip::{PAN_NUMBER, VOLUME_NUMBER};
use crate::testing::edits::{Played, Spec, batch, connect, disconnect, handle, tone_node};
use crate::testing::{SAMPLE_RATE, cell};

/// What a parcel brings, without the nodes themselves; cells and exits by their places in their tables.
#[derive(Debug, PartialEq)]
enum Brought {
    Reset(u32),
    Grow(Table, usize),
    CreateNode(usize),
    Remove {
        cell: usize,
        exit: usize,
    },
    /// Each turn's node with what it hears, then what the output hears.
    Order(Vec<(Seat, Vec<Seat>)>, Vec<Seat>),
    GrowPatterns(usize),
    /// The cell, and the handle and notes of the pattern made in it.
    Pattern(usize, Option<(u32, Vec<Played>)>),
    /// Each clip's tick, last tick, period, offset and pattern.
    Arrangement(Vec<(u32, u32, u32, u32, u32)>),
    LetGo(Vec<u32>),
    Refused(Rejection),
}

fn brought_edit(edit: &Edit) -> Brought {
    match edit {
        Edit::Reset(epoch) => Brought::Reset(*epoch),
        Edit::Grow { table, nodes } => Brought::Grow(*table, nodes.len()),
        Edit::CreateNode { cell, .. } => Brought::CreateNode(cell.index()),
        Edit::Remove { cell, exit, .. } => Brought::Remove {
            cell: cell.index(),
            exit: exit.index(),
        },
        Edit::Order(order) => brought(order),
        Edit::GrowPatterns(patterns) => Brought::GrowPatterns(patterns.len()),
        Edit::Pattern { cell, pattern } => Brought::Pattern(
            cell.index(),
            pattern.as_ref().map(|(handle, pattern)| {
                let notes = pattern.notes().iter().map(|note| {
                    (
                        note.tick,
                        note.node.raw(),
                        note.key,
                        note.velocity,
                        note.length,
                    )
                });
                (handle.raw(), notes.collect())
            }),
        ),
        Edit::Arrangement(arrangement) => Brought::Arrangement(
            arrangement
                .clips()
                .iter()
                .map(|clip| {
                    (
                        clip.tick,
                        clip.last,
                        clip.period,
                        clip.offset,
                        clip.pattern.raw(),
                    )
                })
                .collect(),
        ),
        Edit::LetGo(nodes) => Brought::LetGo(nodes.iter().map(|node| node.raw()).collect()),
        Edit::Refused(reason) => Brought::Refused(*reason),
    }
}

/// Nodes in cells that hear nothing, and the output's.
fn order(cells: &[u32], output: &[u32]) -> Brought {
    let turns: Vec<_> = cells.iter().map(|&cell| (cell, &[][..])).collect();
    wired(&turns, output)
}

fn wired(turns: &[(u32, &[u32])], output: &[u32]) -> Brought {
    let seats = |handles: &[u32]| {
        handles
            .iter()
            .map(|&handle| Seat::Cell(cell(handle)))
            .collect()
    };
    Brought::Order(
        turns
            .iter()
            .map(|&(handle, inputs)| (Seat::Cell(cell(handle)), seats(inputs)))
            .collect(),
        seats(output),
    )
}

fn brought(order: &Order) -> Brought {
    let sources = |range: std::ops::Range<usize>| {
        order.connections[range]
            .iter()
            .map(|connection| connection.source)
            .collect()
    };
    Brought::Order(
        order
            .turns
            .iter()
            .map(|turn| (turn.node, sources(turn.inputs.clone())))
            .collect(),
        sources(order.output..order.connections.len()),
    )
}

fn builder() -> (Builder, AudioEnd) {
    let (build, audio) = handoff::channel();
    (Builder::new(SAMPLE_RATE, build), audio)
}

#[expect(
    clippy::unnecessary_box_returns,
    reason = "the parcel goes back to the audio end in its box"
)]
fn parcel(builder: &mut Builder, audio: &mut AudioEnd, batch: u32, bytes: &[u8]) -> Box<Parcel> {
    builder.build(batch, bytes);
    let Arrival::Here(parcel) = audio.take(Batch::new(batch)) else {
        panic!("no parcel for batch {batch}");
    };
    parcel
}

fn built(builder: &mut Builder, audio: &mut AudioEnd, batch: u32, bytes: &[u8]) -> Vec<Brought> {
    let parcel = parcel(builder, audio, batch, bytes);
    let brought = parcel.edits.iter().map(brought_edit).collect();
    audio.give_back(parcel);
    brought
}

#[test]
fn every_edit_of_the_schema_is_known() {
    let (mut builder, mut audio) = builder();
    // A panic and a hang have tests of their own.
    let own = [
        DeviceEdit::NONE,
        DeviceEdit::PanicBuild,
        DeviceEdit::HangBuild,
    ];
    // Batches go in order, with no gaps.
    for (&kind, batch_number) in DeviceEdit::ENUM_VALUES
        .iter()
        .filter(|kind| !own.contains(kind))
        .zip(1..)
    {
        let brought = built(
            &mut builder,
            &mut audio,
            batch_number,
            &batch(&[Spec::Bare(kind)]),
        );
        let unknown = Brought::Refused(Rejection::UnknownCommand);
        assert!(!brought.contains(&unknown), "{kind:?}");
    }
}

#[test]
#[should_panic(expected = "PanicBuild 7")]
fn panic_build_panics_with_its_code() {
    let (mut builder, mut audio) = builder();
    built(&mut builder, &mut audio, 1, &batch(&[Spec::PanicBuild(7)]));
}

#[test]
#[should_panic(expected = "hangs")]
fn hang_build_hangs() {
    let (mut builder, mut audio) = builder();
    built(&mut builder, &mut audio, 1, &batch(&[Spec::HangBuild(7)]));
}

#[test]
fn edits_the_engine_cannot_make_are_refused_one_by_one() {
    let (mut builder, mut audio) = builder();
    let unknown_version = Spec::CreateNode {
        node: 4,
        plugin: tone::DESCRIPTION.id,
        version: tone::DESCRIPTION.version + 1,
        params: &[],
        samples: &[],
        strip: &[],
    };
    let unknown_plugin = Spec::CreateNode {
        node: 4,
        plugin: 0,
        version: 1,
        params: &[],
        samples: &[],
        strip: &[],
    };
    let edits = [
        tone_node(1, &[]),
        tone_node(1, &[]),
        tone_node(handle(1, 1), &[]),
        tone_node(0, &[]),
        tone_node(handle(1, 0), &[]),
        unknown_version,
        unknown_plugin,
        Spec::SetOutput(0),
        Spec::SetOutput(2),
        Spec::SetOutput(handle(1, 1)),
        Spec::DestroyNode(0),
        Spec::DestroyNode(handle(1, 1)),
        Spec::Missing,
        Spec::Bare(DeviceEdit(DeviceEdit::ENUM_MAX + 1)),
        Spec::SetOutput(1),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::Refused(Rejection::CellTaken),
            Brought::Refused(Rejection::CellTaken),
            Brought::Refused(Rejection::InvalidHandle),
            Brought::Refused(Rejection::InvalidHandle),
            Brought::Refused(Rejection::UnknownPlugin),
            Brought::Refused(Rejection::UnknownPlugin),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::Malformed),
            Brought::Refused(Rejection::UnknownCommand),
            order(&[1], &[1]),
        ]
    );
}

#[test]
fn bytes_that_are_not_a_batch_still_make_a_parcel() {
    let (mut builder, mut audio) = builder();
    let refused = [Brought::Refused(Rejection::Malformed)];
    assert_eq!(built(&mut builder, &mut audio, 1, &[]), refused);
    assert_eq!(built(&mut builder, &mut audio, 2, &[0xff; 9]), refused);
    assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
    // A table without a kind doesn't pass the check.
    let inconsistent = batch(&[tone_node(1, &[]), Spec::Bare(DeviceEdit::NONE)]);
    assert_eq!(built(&mut builder, &mut audio, 4, &inconsistent), refused);
}

#[test]
fn a_value_the_node_refuses_leaves_its_parameter_at_the_default_and_the_node_is_made() {
    let (mut builder, mut audio) = builder();
    let volume = tone::VOLUME.get();
    let values = [(volume, f32::NAN), (volume + 1, 0.5), (volume, 0.25)];
    let edits = [tone_node(1, &values)];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::Refused(Rejection::InvalidValue),
            Brought::Refused(Rejection::UnknownTarget),
            order(&[1], &[]),
        ]
    );
}

#[test]
fn a_strip_value_is_refused_on_its_own_and_the_node_is_made() {
    let (mut builder, mut audio) = builder();
    let values = [
        (VOLUME_NUMBER.get(), f32::NAN),
        (PAN_NUMBER.get() + 1, 0.5),
        (0, 0.5),
        (PAN_NUMBER.get(), 0.5),
    ];
    let edits = [
        Spec::CreateNode {
            node: 1,
            plugin: tone::DESCRIPTION.id,
            version: tone::DESCRIPTION.version,
            params: &[],
            samples: &[],
            strip: &values,
        },
        Spec::CreateInsert(2, &values),
    ];
    let refusals = || {
        [
            Rejection::InvalidValue,
            Rejection::UnknownTarget,
            Rejection::UnknownTarget,
        ]
        .map(Brought::Refused)
    };
    let mut expected = vec![Brought::CreateNode(1)];
    expected.extend(refusals());
    expected.push(Brought::CreateNode(2));
    expected.extend(refusals());
    expected.push(order(&[1, 2], &[]));
    assert_eq!(built(&mut builder, &mut audio, 1, &batch(&edits)), expected);
}

#[test]
fn each_table_grows_once_per_parcel_before_anything_goes_in() {
    let (mut builder, mut audio) = builder();
    let edits = [tone_node(16, &[]), tone_node(handle(7, 32), &[])];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::Grow(Table::Cells, 64),
            Brought::CreateNode(16),
            Brought::CreateNode(32),
            order(&[16, 32], &[]),
        ]
    );
    let edits = [tone_node(63, &[]), tone_node(u32::from(u16::MAX), &[])];
    assert_eq!(
        built(&mut builder, &mut audio, 2, &batch(&edits)),
        [
            Brought::Grow(Table::Cells, usize::from(u16::MAX) + 1),
            Brought::CreateNode(63),
            Brought::CreateNode(usize::from(u16::MAX)),
            order(&[16, 32, 63, u32::from(u16::MAX)], &[]),
        ]
    );
    // A reset of more nodes than there are exits for removed ones.
    let many: Vec<_> = (1..=20).map(|cell| tone_node(cell, &[])).collect();
    built(&mut builder, &mut audio, 3, &batch(&many));
    let reset = built(&mut builder, &mut audio, 4, &batch(&[Spec::Reset(1)]));
    let grows: Vec<_> = reset
        .iter()
        .filter(|edit| matches!(edit, Brought::Grow(..)))
        .collect();
    assert_eq!(grows, [&Brought::Grow(Table::Exits, 32)]);
    assert_eq!(reset[0], Brought::Grow(Table::Exits, 32));
}

#[test]
fn a_removed_node_frees_its_cell_at_once_and_plays_out_until_its_parcel_comes_back() {
    let (mut builder, mut audio) = builder();
    let edits = [tone_node(1, &[]), Spec::SetOutput(1)];
    built(&mut builder, &mut audio, 1, &batch(&edits));
    let again = [
        Spec::DestroyNode(1),
        tone_node(handle(1, 1), &[]),
        Spec::SetOutput(handle(1, 1)),
    ];
    let removal = parcel(&mut builder, &mut audio, 2, &batch(&again));
    assert!(removal.holds);
    let edits: Vec<_> = removal.edits.iter().map(brought_edit).collect();
    let playing_out = Seat::Exit(Exit::new(0));
    assert_eq!(
        edits,
        [
            Brought::Remove { cell: 1, exit: 0 },
            Brought::CreateNode(1),
            Brought::Order(
                vec![(playing_out, vec![]), (Seat::Cell(cell(1)), vec![])],
                vec![playing_out, Seat::Cell(cell(1))]
            ),
        ]
    );
    // Until the parcel is back, its exit stays taken.
    built(&mut builder, &mut audio, 3, &batch(&[]));
    audio.give_back(removal);
    assert_eq!(builder.collect(), 0);
    assert_eq!(
        built(&mut builder, &mut audio, 4, &batch(&[])),
        [order(&[1], &[1])]
    );
}

#[test]
fn a_reset_removes_every_node_and_starts_a_session() {
    let (mut builder, mut audio) = builder();
    let edits = [tone_node(20, &[]), tone_node(2, &[]), connect(2, 20)];
    built(&mut builder, &mut audio, 1, &batch(&edits));
    let reset = [Spec::Reset(3), Spec::SetOutput(20), tone_node(20, &[])];
    let parcel = parcel(&mut builder, &mut audio, 2, &batch(&reset));
    assert!(parcel.holds);
    let edits: Vec<_> = parcel.edits.iter().map(brought_edit).collect();
    let [two, twenty] = [Seat::Exit(Exit::new(0)), Seat::Exit(Exit::new(1))];
    assert_eq!(
        edits,
        [
            Brought::Reset(3),
            Brought::Remove { cell: 2, exit: 0 },
            Brought::Remove { cell: 20, exit: 1 },
            Brought::Refused(Rejection::UnknownTarget),
            Brought::CreateNode(20),
            Brought::Order(
                vec![
                    (two, vec![]),
                    (twenty, vec![two]),
                    (Seat::Cell(cell(20)), vec![])
                ],
                vec![]
            ),
        ]
    );
}

#[test]
fn the_order_comes_only_with_batches_that_change_the_graph() {
    let (mut builder, mut audio) = builder();
    let added = batch(&[tone_node(2, &[]), tone_node(1, &[])]);
    assert_eq!(
        built(&mut builder, &mut audio, 1, &added),
        [
            Brought::CreateNode(2),
            Brought::CreateNode(1),
            order(&[2, 1], &[]),
        ]
    );
    let output = batch(&[Spec::SetOutput(1), tone_node(1, &[])]);
    assert_eq!(
        built(&mut builder, &mut audio, 2, &output),
        [Brought::Refused(Rejection::CellTaken), order(&[2, 1], &[1]),]
    );
    let same = batch(&[Spec::SetOutput(1)]);
    assert_eq!(built(&mut builder, &mut audio, 3, &same), []);
    // A connection alone changes what a node hears; a refused one changes nothing.
    assert_eq!(
        built(&mut builder, &mut audio, 4, &batch(&[connect(1, 2)])),
        [wired(&[(1, &[]), (2, &[1])], &[1])]
    );
    assert_eq!(
        built(&mut builder, &mut audio, 5, &batch(&[connect(2, 1)])),
        [Brought::Refused(Rejection::Loop)]
    );
}

#[test]
fn a_node_goes_after_the_nodes_it_hears_whenever_it_was_made() {
    let (mut builder, mut audio) = builder();
    let edits = [
        tone_node(1, &[]),
        tone_node(2, &[]),
        tone_node(3, &[]),
        connect(3, 2),
        connect(2, 1),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::CreateNode(2),
            Brought::CreateNode(3),
            wired(&[(3, &[]), (2, &[3]), (1, &[2])], &[]),
        ]
    );
    // One node can feed several, and a node hears all of its inputs.
    let edits = [tone_node(4, &[]), connect(4, 1), connect(3, 1)];
    assert_eq!(
        built(&mut builder, &mut audio, 2, &batch(&edits)),
        [
            Brought::CreateNode(4),
            wired(&[(3, &[]), (2, &[3]), (4, &[]), (1, &[2, 4, 3])], &[]),
        ]
    );
}

#[test]
fn connections_the_engine_cannot_make_are_refused_one_by_one() {
    let (mut builder, mut audio) = builder();
    let edits = [
        tone_node(1, &[]),
        tone_node(2, &[]),
        tone_node(3, &[]),
        connect(1, 2),
        connect(2, 3),
        connect(3, 1),
        connect(2, 2),
        connect(1, 2),
        connect(1, 9),
        connect(9, 1),
        connect(0, 1),
        connect(1, 0),
        connect(handle(1, 1), 3),
        connect(1, 3),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::CreateNode(2),
            Brought::CreateNode(3),
            Brought::Refused(Rejection::Loop),
            Brought::Refused(Rejection::Loop),
            Brought::Refused(Rejection::AlreadyConnected),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            wired(&[(1, &[]), (2, &[1]), (3, &[2, 1])], &[]),
        ]
    );
}

#[test]
fn an_insert_takes_a_handle_as_a_node_does() {
    let (mut builder, mut audio) = builder();
    let edits = [
        Spec::CreateInsert(1, &[]),
        Spec::CreateInsert(0, &[]),
        Spec::CreateInsert(handle(1, 1), &[]),
        tone_node(2, &[]),
        connect(2, 1),
        Spec::SetOutput(1),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::Refused(Rejection::InvalidHandle),
            Brought::Refused(Rejection::CellTaken),
            Brought::CreateNode(2),
            wired(&[(2, &[]), (1, &[2])], &[1]),
        ]
    );
}

#[test]
fn only_a_connection_between_live_nodes_that_is_kept_can_be_disconnected() {
    let (mut builder, mut audio) = builder();
    let edits = [
        tone_node(1, &[]),
        tone_node(2, &[]),
        connect(1, 2),
        disconnect(2, 1),
        disconnect(1, 9),
        disconnect(0, 2),
        disconnect(handle(1, 1), 2),
        disconnect(1, 2),
        disconnect(1, 2),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::CreateNode(2),
            Brought::Refused(Rejection::NotConnected),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::NotConnected),
            wired(&[(1, &[]), (2, &[1])], &[]),
        ]
    );
}

#[test]
fn a_removed_node_takes_its_connections_along_once_its_parcel_is_back() {
    let (mut builder, mut audio) = builder();
    let edits = [
        tone_node(1, &[]),
        tone_node(2, &[]),
        tone_node(3, &[]),
        connect(1, 2),
        connect(2, 3),
        Spec::SetOutput(3),
    ];
    built(&mut builder, &mut audio, 1, &batch(&edits));
    let removal = parcel(&mut builder, &mut audio, 2, &batch(&[Spec::DestroyNode(2)]));
    audio.give_back(removal);
    builder.collect();
    assert_eq!(
        built(&mut builder, &mut audio, 3, &batch(&[])),
        [wired(&[(1, &[]), (3, &[])], &[3])]
    );
}

#[test]
fn a_pattern_comes_sorted_by_tick_with_the_notes_no_note_can_have_dropped_under_one_refusal() {
    let (mut builder, mut audio) = builder();
    let notes = [
        (480, 1, 60, 1.0, 240),
        (0, 1, 62, 2.0, 240),
        (240, 1, 128, 1.0, 240),
        (240, 1, 61, f32::NAN, 240),
        (0, 1, 64, -1.0, 240),
        (240, 1, 66, 1.0, 0),
        (240, 1, 65, 0.5, 240),
    ];
    let edits = [tone_node(1, &[]), Spec::SetPattern(1, &notes)];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::Pattern(
                1,
                Some((
                    1,
                    vec![
                        (0, 1, 62, 1.0, 240),
                        (0, 1, 64, 0.0, 240),
                        (240, 1, 65, 0.5, 240),
                        (480, 1, 60, 1.0, 240),
                    ]
                ))
            ),
            Brought::Refused(Rejection::InvalidValue),
            order(&[1], &[]),
        ]
    );
    // A pattern without notes is silence; one without a handle, none.
    let (empty, bare) = (Spec::SetPattern(2, &[]), Spec::Bare(DeviceEdit::SetPattern));
    assert_eq!(
        built(&mut builder, &mut audio, 2, &batch(&[empty, bare])),
        [
            Brought::Pattern(2, Some((2, vec![]))),
            Brought::Refused(Rejection::InvalidHandle)
        ]
    );
}

#[test]
fn a_pattern_is_made_in_a_free_cell_and_replaced_under_its_handle_and_its_cell_is_free_once_it_goes()
 {
    let (mut builder, mut audio) = builder();
    let one = [(0, 1, 60, 1.0, 240)];
    let edits = [
        tone_node(1, &[]),
        Spec::SetPattern(1, &[]),
        Spec::SetPattern(1, &one),
        Spec::SetPattern(handle(1, 1), &[]),
        Spec::DestroyPattern(handle(1, 1)),
        Spec::DestroyPattern(2),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::Pattern(1, Some((1, vec![]))),
            Brought::Pattern(1, Some((1, vec![(0, 1, 60, 1.0, 240)]))),
            Brought::Refused(Rejection::CellTaken),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Refused(Rejection::UnknownTarget),
            order(&[1], &[]),
        ]
    );
    let edits = [
        Spec::DestroyPattern(1),
        Spec::SetPattern(handle(1, 1), &one),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 2, &batch(&edits)),
        [
            Brought::Pattern(1, None),
            Brought::Pattern(1, Some((handle(1, 1), vec![(0, 1, 60, 1.0, 240)]))),
        ]
    );
}

#[test]
fn the_pattern_table_grows_before_the_parcel_puts_a_pattern_past_it() {
    let (mut builder, mut audio) = builder();
    let past = FIRST_PATTERN_CELLS;
    let handle = |cell: usize| u32::try_from(cell).unwrap();
    let edits = [
        Spec::SetPattern(handle(past + 1), &[]),
        Spec::SetPattern(handle(past), &[]),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::GrowPatterns(2 * FIRST_PATTERN_CELLS),
            Brought::Pattern(past + 1, Some((handle(past + 1), vec![]))),
            Brought::Pattern(past, Some((handle(past), vec![]))),
        ]
    );
    let last = usize::from(u16::MAX);
    let edits = [Spec::SetPattern(handle(last), &[])];
    assert_eq!(
        built(&mut builder, &mut audio, 2, &batch(&edits)),
        [
            Brought::GrowPatterns(last + 1),
            Brought::Pattern(last, Some((handle(last), vec![]))),
        ]
    );
}

#[test]
fn clips_come_sorted_by_tick_to_their_last_ticks_with_those_of_no_length_or_period_dropped_under_one_refusal()
 {
    let (mut builder, mut audio) = builder();
    // An offset past the period is taken round it.
    let clips = [
        (960, 480, 960, 1000, 1),
        (0, 960, 960, 0, 2),
        (0, 0, 960, 0, 1),
        (u32::MAX - 1, 10, 3, 2, 1),
        (0, 960, 0, 0, 1),
    ];
    let edits = [
        Spec::SetPattern(1, &[]),
        Spec::SetPattern(2, &[]),
        Spec::SetClips(&clips),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits))[2..],
        [
            Brought::Arrangement(vec![
                (0, 959, 960, 0, 2),
                (960, 1439, 960, 40, 1),
                (u32::MAX - 1, u32::MAX, 3, 2, 1)
            ]),
            Brought::Refused(Rejection::InvalidValue),
        ]
    );
}

#[test]
fn after_every_batch_the_clips_name_only_live_patterns_or_the_batch_gets_one_refusal() {
    let (mut builder, mut audio) = builder();
    // The patterns may come after the clips in their batch.
    let edits = [
        Spec::SetClips(&[(0, 960, 960, 0, 1), (960, 960, 960, 0, 2)]),
        Spec::SetPattern(1, &[]),
        Spec::SetPattern(2, &[]),
    ];
    let made = built(&mut builder, &mut audio, 1, &batch(&edits));
    assert!(!made.contains(&Brought::Refused(Rejection::UnknownTarget)));
    // A pattern removed without clips that leave it out.
    assert_eq!(
        built(
            &mut builder,
            &mut audio,
            2,
            &batch(&[Spec::DestroyPattern(2)])
        ),
        [
            Brought::Pattern(2, None),
            Brought::Refused(Rejection::UnknownTarget),
        ]
    );
    // Told once, by the batch that broke the rule.
    assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
    let edits = [Spec::SetClips(&[(0, 960, 960, 0, handle(1, 1))])];
    assert_eq!(
        built(&mut builder, &mut audio, 4, &batch(&edits)),
        [
            Brought::Arrangement(vec![(0, 959, 960, 0, handle(1, 1))]),
            Brought::Refused(Rejection::UnknownTarget),
        ]
    );
    // A pattern the clips don't name goes without a word.
    let edits = [
        Spec::SetClips(&[(0, 960, 960, 0, 1)]),
        Spec::SetPattern(3, &[]),
        Spec::DestroyPattern(3),
    ];
    let refusals = built(&mut builder, &mut audio, 5, &batch(&edits))
        .into_iter()
        .filter(|edit| matches!(edit, Brought::Refused(_)))
        .count();
    assert_eq!(refusals, 0);
}

#[test]
fn notes_are_let_go_of_only_for_live_nodes_in_one_edit_each_node_once() {
    let (mut builder, mut audio) = builder();
    let edits = [
        tone_node(1, &[]),
        tone_node(2, &[]),
        Spec::LetGoOfNotes(2),
        Spec::LetGoOfNotes(3),
        Spec::LetGoOfNotes(1),
        Spec::LetGoOfNotes(2),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 1, &batch(&edits)),
        [
            Brought::CreateNode(1),
            Brought::CreateNode(2),
            Brought::Refused(Rejection::UnknownTarget),
            Brought::LetGo(vec![1, 2]),
            order(&[1, 2], &[]),
        ]
    );
}

#[test]
fn after_every_batch_the_pattern_names_only_live_nodes_or_the_batch_gets_one_refusal() {
    let (mut builder, mut audio) = builder();
    let notes = [
        (0, 1, 60, 1.0, 240),
        (240, 2, 60, 1.0, 240),
        (480, 1, 60, 1.0, 240),
    ];
    // The nodes may come after the pattern in its batch.
    let edits = [
        Spec::SetPattern(1, &notes),
        tone_node(1, &[]),
        tone_node(2, &[]),
    ];
    let made = built(&mut builder, &mut audio, 1, &batch(&edits));
    assert!(!made.contains(&Brought::Refused(Rejection::UnknownTarget)));
    // A node removed without a pattern that leaves it out.
    let removed = built(&mut builder, &mut audio, 2, &batch(&[Spec::DestroyNode(2)]));
    assert_eq!(
        removed,
        [
            Brought::Remove { cell: 2, exit: 0 },
            Brought::Refused(Rejection::UnknownTarget),
            Brought::Order(
                vec![
                    (Seat::Cell(cell(1)), vec![]),
                    (Seat::Exit(Exit::new(0)), vec![])
                ],
                vec![]
            ),
        ]
    );
    // Told once, by the batch that broke the rule.
    assert_eq!(built(&mut builder, &mut audio, 3, &batch(&[])), []);
    let other_generation = [(0, handle(1, 1), 60, 1.0, 240), (0, 0, 60, 1.0, 240)];
    assert_eq!(
        built(
            &mut builder,
            &mut audio,
            4,
            &batch(&[Spec::SetPattern(1, &other_generation)])
        ),
        [
            Brought::Pattern(
                1,
                Some((
                    1,
                    vec![(0, handle(1, 1), 60, 1.0, 240), (0, 0, 60, 1.0, 240)]
                ))
            ),
            Brought::Refused(Rejection::UnknownTarget),
        ]
    );
    // A node no pattern names goes without a word.
    let first = [(0, 1, 60, 1.0, 240)];
    built(
        &mut builder,
        &mut audio,
        5,
        &batch(&[Spec::SetPattern(1, &first)]),
    );
    let edits = [tone_node(3, &[]), Spec::DestroyNode(3)];
    let refusals = built(&mut builder, &mut audio, 6, &batch(&edits))
        .into_iter()
        .filter(|edit| matches!(edit, Brought::Refused(_)))
        .count();
    assert_eq!(refusals, 0);
}

#[test]
fn a_reset_takes_the_patterns_and_clips_away_and_a_rebuild_in_its_batch_brings_them_back() {
    let (mut builder, mut audio) = builder();
    let notes = [(0, 1, 60, 1.0, 240)];
    built(&mut builder, &mut audio, 1, &batch(&[Spec::Reset(1)]));
    let edits = [
        tone_node(1, &[]),
        Spec::SetPattern(2, &notes),
        Spec::SetPattern(1, &[]),
        Spec::SetClips(&[(0, 960, 960, 0, 2)]),
    ];
    built(&mut builder, &mut audio, 2, &batch(&edits));
    let rebuild = [
        Spec::Reset(2),
        tone_node(handle(1, 1), &[]),
        Spec::SetPattern(handle(1, 1), &[(0, handle(1, 1), 60, 1.0, 240)]),
        Spec::SetClips(&[(0, 960, 960, 0, handle(1, 1))]),
    ];
    assert_eq!(
        built(&mut builder, &mut audio, 3, &batch(&rebuild)),
        [
            Brought::Reset(2),
            Brought::Remove { cell: 1, exit: 0 },
            Brought::Pattern(1, None),
            Brought::Pattern(2, None),
            Brought::Arrangement(vec![]),
            Brought::CreateNode(1),
            Brought::Pattern(
                1,
                Some((handle(1, 1), vec![(0, handle(1, 1), 60, 1.0, 240)]))
            ),
            Brought::Arrangement(vec![(0, 959, 960, 0, handle(1, 1))]),
            Brought::Order(
                vec![
                    (Seat::Exit(Exit::new(0)), vec![]),
                    (Seat::Cell(cell(1)), vec![])
                ],
                vec![]
            ),
        ]
    );
    // Without patterns or clips to take away, a reset brings none.
    let edits = [Spec::SetClips(&[]), Spec::DestroyPattern(handle(1, 1))];
    built(&mut builder, &mut audio, 4, &batch(&edits));
    let reset = built(&mut builder, &mut audio, 5, &batch(&[Spec::Reset(3)]));
    assert!(
        !reset
            .iter()
            .any(|edit| matches!(edit, Brought::Pattern(..) | Brought::Arrangement(_)))
    );
}
