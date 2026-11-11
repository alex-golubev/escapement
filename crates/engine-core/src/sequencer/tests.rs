use engine_plugins::Event;

use super::*;
use crate::graph::Nodes;
use crate::node::{NOTE_ROOM, Node};
use crate::testing::plugins::{GIVEN, RECORDER};
use crate::testing::{BAR, SAMPLE_RATE, cell, note_room};
use crate::transport::Place;
use crate::{BLOCK_FRAMES, SILENCE};

/// A step long.
fn note(tick: u32, node: u32, key: u8) -> Note {
    Note {
        tick,
        node: NodeHandle::new(node),
        key,
        velocity: 1.0,
        length: 240,
    }
}

/// The pattern's `n`th note pressed since its `Held` was made.
fn at(time: u32, key: u8, n: u32) -> Event {
    Event::NoteOn {
        time,
        key,
        velocity: 1.0,
        note: NoteId::new(PAGE_NOTES | n),
    }
}

/// Recorders in cells 1 and 2, of generation 0.
fn graph() -> Graph {
    let mut graph = Graph::new(Nodes::new(4), Nodes::new(4), SAMPLE_RATE);
    for handle in [1, 2] {
        let node = Node::new(&RECORDER, SAMPLE_RATE, NodeHandle::new(handle));
        assert!(graph.insert(cell(handle), &mut Some(Box::new(node))));
    }
    graph
}

/// Of the pattern's `n`th note pressed.
fn off(time: u32, n: u32) -> Event {
    Event::NoteOff {
        time,
        note: NoteId::new(PAGE_NOTES | n),
    }
}

/// The notes the node got in the block, after its first block's parameter values.
fn given(graph: &mut Graph, node: u32) -> Vec<Event> {
    let node = graph.node_mut(NodeHandle::new(node)).unwrap();
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN
        .take()
        .into_iter()
        .filter(|event| !matches!(event, Event::Param { .. }))
        .collect()
}

const PATTERN: PatternHandle = PatternHandle::new(1);

/// A clip that plays its pattern once, from its start: its period as long as it is, as far as a period goes.
fn clip(tick: u32, last: u32, pattern: PatternHandle) -> Clip {
    Clip {
        tick,
        last,
        period: (last - tick).saturating_add(1),
        offset: 0,
        pattern,
    }
}

/// The patterns in their handles' cells, generation 0 or not.
fn patterns(made: Vec<(PatternHandle, Vec<Note>)>) -> Patterns {
    let mut patterns = Patterns::new(4);
    for (handle, notes) in made {
        let mut slot = Some((handle, Pattern::new(notes)));
        assert!(patterns.put(handle.cell(), &mut slot));
    }
    patterns
}

/// The notes as one pattern, played from the loop's start by a clip that never ends.
fn played(notes: Vec<Note>) -> Sequencer {
    Sequencer {
        patterns: patterns(vec![(PATTERN, notes)]),
        arrangement: Arrangement::new(vec![clip(0, u32::MAX, PATTERN)]),
    }
}

fn lasting(length: u32, note: Note) -> Note {
    Note { length, ..note }
}

fn playing() -> Transport {
    let mut transport = Transport::new(SAMPLE_RATE);
    transport.set(true, BAR, Place::default()).unwrap();
    transport
}

#[test]
fn each_note_a_block_passes_reaches_its_node_at_its_frame() {
    let pattern = played(vec![note(6, 1, 62), note(0, 1, 60), note(3, 2, 61)]);
    let (mut transport, mut graph) = (playing(), graph());
    assert_eq!(
        pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES),
        0
    );
    // 25 frames a tick at 120 and 48 kHz; the block gets to 5.12.
    assert_eq!(given(&mut graph, 1), [at(0, 60, 0)]);
    assert_eq!(given(&mut graph, 2), [at(75, 61, 1)]);
    transport.advance(BLOCK_FRAMES);
    pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(22, 62, 0)]);
}

#[test]
fn each_clip_plays_its_pattern_from_its_tick_and_lets_go_of_a_note_at_its_end_at_the_latest() {
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, vec![note(0, 1, 60), note(2, 1, 62)])]),
        arrangement: Arrangement::new(vec![clip(4, 7, PATTERN), clip(0, 3, PATTERN)]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    // Ticks 0 to 5: the first clip's notes end with it, at tick 4, as the second starts.
    assert_eq!(
        given(&mut graph, 1),
        [
            at(0, 60, 0),
            at(50, 62, 1),
            at(100, 60, 2),
            off(100, 0),
            off(100, 1)
        ]
    );
}

#[test]
fn a_clip_plays_none_of_its_pattern_past_its_last_tick() {
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, vec![note(0, 1, 60), note(4, 1, 62)])]),
        arrangement: Arrangement::new(vec![clip(1, 4, PATTERN)]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(25, 60, 0), off(125, 0)]);
}

#[test]
fn a_clip_goes_round_its_pattern_every_period_and_lets_go_of_a_note_at_its_round_s_end_at_the_latest()
 {
    // The note at tick 2 lies past the period: never heard.
    let notes = vec![note(0, 1, 60), note(1, 1, 61), note(2, 1, 62)];
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, notes)]),
        arrangement: Arrangement::new(vec![Clip {
            tick: 0,
            last: 5,
            period: 2,
            offset: 0,
            pattern: PATTERN,
        }]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    // Ticks 0 to 5, three rounds of two; the last round's notes end with the clip, in the next block.
    assert_eq!(
        given(&mut graph, 1),
        [
            at(0, 60, 0),
            at(25, 61, 1),
            at(50, 60, 2),
            off(50, 0),
            off(50, 1),
            at(75, 61, 3),
            at(100, 60, 4),
            off(100, 2),
            off(100, 3),
            at(125, 61, 5)
        ]
    );
}

#[test]
fn a_round_that_starts_inside_a_block_plays_from_its_start() {
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, vec![note(0, 1, 60)])]),
        arrangement: Arrangement::new(vec![Clip {
            tick: 1,
            last: u32::MAX,
            period: 3,
            offset: 0,
            pattern: PATTERN,
        }]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(
        given(&mut graph, 1),
        [at(25, 60, 0), at(100, 60, 1), off(100, 0)]
    );
}

#[test]
fn a_clip_from_its_offset_plays_its_pattern_from_there_and_from_its_start_each_round_after() {
    // Rounds of four from tick 3 of the pattern: its notes at 3 and 1, then at 1 again past the round's end.
    let notes = vec![note(1, 1, 61), note(3, 1, 63)];
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, notes)]),
        arrangement: Arrangement::new(vec![Clip {
            tick: 0,
            last: u32::MAX,
            period: 4,
            offset: 3,
            pattern: PATTERN,
        }]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    // Ticks 0 to 5 of the loop are 3, then 0 to 3, then 0 of the pattern's rounds; each note ends with its round.
    assert_eq!(
        given(&mut graph, 1),
        [
            at(0, 63, 0),
            off(25, 0),
            at(50, 61, 1),
            at(100, 63, 2),
            off(125, 1),
            off(125, 2)
        ]
    );
}

#[test]
fn clips_of_two_patterns_that_overlap_both_play() {
    let other = PatternHandle::new(2);
    let sequencer = Sequencer {
        patterns: patterns(vec![
            (PATTERN, vec![note(0, 1, 60)]),
            (other, vec![note(1, 2, 61)]),
        ]),
        arrangement: Arrangement::new(vec![clip(0, BAR, PATTERN), clip(2, BAR, other)]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(0, 60, 0)]);
    assert_eq!(given(&mut graph, 2), [at(75, 61, 1)]);
}

#[test]
fn a_clip_of_a_pattern_that_is_gone_plays_nothing_even_in_its_cell() {
    let sequencer = Sequencer {
        patterns: patterns(vec![(PATTERN, vec![note(0, 1, 60)])]),
        arrangement: Arrangement::new(vec![
            clip(0, BAR, PatternHandle::new(1 << 16 | 1)),
            clip(0, BAR, PatternHandle::new(3)),
            clip(0, BAR, PatternHandle::new(9)),
        ]),
    };
    let (transport, mut graph) = (playing(), graph());
    sequencer.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), []);
}

#[test]
fn the_clips_found_for_a_stretch_are_those_that_play_a_tick_of_it_however_long_the_longest() {
    let arrangement = Arrangement::new(vec![
        clip(998, 1003, PATTERN),
        clip(0, 1000, PATTERN),
        clip(2, 3, PATTERN),
        clip(500, 503, PATTERN),
        clip(1001, 1001, PATTERN),
        clip(u32::MAX - 1, u32::MAX, PATTERN),
    ]);
    let ranges = (0..1100)
        .flat_map(|first| (0..8).map(move |more| (first, first + more)))
        .chain([(u32::MAX - 2, u32::MAX), (u32::MAX, u32::MAX)]);
    for (first, last) in ranges {
        let found: Vec<_> = arrangement.playing(first, last).copied().collect();
        let playing: Vec<_> = arrangement
            .clips()
            .iter()
            .filter(|clip| clip.tick <= last && clip.last >= first)
            .copied()
            .collect();
        assert_eq!(found, playing, "{first}..={last}");
    }
}

#[test]
fn a_larger_table_keeps_every_pattern_in_its_cell_and_one_past_it_is_left_out() {
    let mut patterns = patterns(vec![(PATTERN, vec![note(0, 1, 60)])]);
    let mut slot = Some((PatternHandle::new(4), Pattern::default()));
    assert!(!patterns.put(PatternHandle::new(4).cell(), &mut slot));
    assert!(slot.is_some());
    let mut larger = Patterns::new(8);
    patterns.grow(&mut larger);
    assert_eq!((patterns.len(), larger.len()), (8, 4));
    assert_eq!(
        patterns.get(PATTERN).map(Pattern::notes),
        Some(&[note(0, 1, 60)][..])
    );
    assert!(patterns.put(PatternHandle::new(4).cell(), &mut slot));
    assert!(patterns.get(PatternHandle::new(4)).is_some());
}

#[test]
fn notes_of_one_tick_keep_their_order() {
    let pattern = played(vec![note(5, 1, 64), note(2, 1, 60), note(5, 1, 62)]);
    let (transport, mut graph) = (playing(), graph());
    pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(
        given(&mut graph, 1),
        [at(50, 60, 0), at(125, 64, 1), at(125, 62, 2)]
    );
}

#[test]
fn a_stopped_transport_hands_out_nothing() {
    let pattern = played(vec![note(0, 1, 60)]);
    let mut graph = graph();
    let stopped = Transport::new(SAMPLE_RATE);
    pattern.hand_out(&mut Held::new(), &stopped, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), []);
}

#[test]
fn notes_go_on_from_the_loop_s_start_within_the_block_it_ends_in_and_none_past_its_end_play() {
    let pattern = played(vec![note(0, 1, 60), note(999, 1, 61), note(1000, 1, 62)]);
    let mut transport = Transport::new(SAMPLE_RATE);
    transport.set(true, 1000, Place::default()).unwrap();
    let mut graph = graph();
    // To 998.4.
    for _ in 0..195 {
        transport.advance(BLOCK_FRAMES);
    }
    pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(
        given(&mut graph, 1),
        [at(15, 61, 0), at(40, 60, 1), off(40, 0)]
    );
}

#[test]
fn a_note_of_a_node_that_is_gone_plays_nothing_even_in_its_cell() {
    // Generation 1 of cell 1, and a cell with no node.
    let pattern = played(vec![note(0, 1 << 16 | 1, 60), note(0, 3, 60)]);
    let (transport, mut graph) = (playing(), graph());
    assert_eq!(
        pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES),
        0
    );
    assert_eq!(given(&mut graph, 1), []);
}

#[test]
fn notes_past_the_node_s_room_are_counted_and_the_rest_play() {
    let notes = (0..=note_room()).map(|key| note(0, 1, key)).collect();
    let pattern = played(notes);
    let (transport, mut graph) = (playing(), graph());
    // A live note took a place first.
    let node = graph.node_mut(NodeHandle::new(1)).unwrap();
    node.note_on(0, 100, 1.0, NoteId::new(100)).unwrap();
    assert_eq!(
        pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES),
        2
    );
    let heard = given(&mut graph, 1);
    assert_eq!(heard.len(), NOTE_ROOM);
    let live = Event::NoteOn {
        time: 0,
        key: 100,
        velocity: 1.0,
        note: NoteId::new(100),
    };
    assert_eq!(heard[0], live);
    let last = note_room() - 2;
    assert_eq!(heard[NOTE_ROOM - 1], at(0, last, last.into()));
}

#[test]
fn a_block_hands_out_notes_up_to_its_budget_and_counts_the_rest() {
    // Notes of a node that isn't there cost as much to go through as any other.
    let mut notes: Vec<_> = (0..NOTE_BUDGET).map(|_| note(0, 3, 60)).collect();
    notes.extend([note(0, 1, 61), note(6, 1, 62)]);
    let pattern = played(notes);
    let (mut transport, mut graph) = (playing(), graph());
    assert_eq!(
        pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES),
        1
    );
    assert_eq!(given(&mut graph, 1), []);
    // The next block has a budget of its own.
    transport.advance(BLOCK_FRAMES);
    assert_eq!(
        pattern.hand_out(&mut Held::new(), &transport, &mut graph, BLOCK_FRAMES),
        0
    );
    assert_eq!(given(&mut graph, 1), [at(22, 62, 0)]);
}

#[test]
fn a_loop_of_a_tick_under_a_chord_stays_within_the_budget() {
    let chord: Vec<_> = (0..100).map(|key| note(0, 3, key)).collect();
    let pattern = played(chord);
    let mut transport = Transport::new(SAMPLE_RATE);
    transport.set(true, 1, Place::default()).unwrap();
    // From the start a block passes 6 ticks at 120, 600 notes; at 522, 23, past the budget.
    assert_eq!(transport.stretches(BLOCK_FRAMES).count(), 6);
    let lost = pattern.hand_out(&mut Held::new(), &transport, &mut graph(), BLOCK_FRAMES);
    assert_eq!(lost, 0);
    transport.set_tempo(522.0).unwrap();
    let passes = transport.stretches(BLOCK_FRAMES).count();
    assert_eq!(passes, 23);
    let lost = pattern.hand_out(&mut Held::new(), &transport, &mut graph(), BLOCK_FRAMES);
    assert_eq!(lost, passes * 100 - NOTE_BUDGET);
}

#[test]
fn a_note_is_let_go_of_at_the_frame_that_passes_its_end_in_a_later_block_too() {
    let pattern = played(vec![lasting(3, note(0, 1, 60)), lasting(6, note(0, 1, 62))]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(
        given(&mut graph, 1),
        [at(0, 60, 0), at(0, 62, 1), off(75, 0)]
    );
    transport.advance(BLOCK_FRAMES);
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [off(22, 1)]);
    assert_eq!(held.len(), 0);
}

#[test]
fn a_note_is_let_go_of_at_the_loop_s_end_at_the_latest() {
    let pattern = played(vec![lasting(4, note(6, 1, 60))]);
    let mut transport = Transport::new(SAMPLE_RATE);
    transport.set(true, 8, Place::default()).unwrap();
    let (mut graph, mut held) = (graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    transport.advance(BLOCK_FRAMES);
    // Ticks 6, 7, then 0 to 2 of the next pass: the note ends as the loop does.
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(22, 60, 0), off(72, 0)]);
}

#[test]
fn a_note_outlives_the_pattern_that_pressed_it() {
    let pattern = played(vec![lasting(6, note(0, 1, 60))]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(0, 60, 0)]);
    transport.advance(BLOCK_FRAMES);
    Sequencer::default().hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [off(22, 0)]);
}

#[test]
fn a_stopped_transport_lets_go_of_every_note_at_the_block_s_start() {
    let pattern = played(vec![
        lasting(BAR, note(0, 1, 60)),
        lasting(BAR, note(3, 2, 61)),
    ]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    given(&mut graph, 1);
    given(&mut graph, 2);
    transport.advance(BLOCK_FRAMES);
    transport.set(false, BAR, Place::default()).unwrap();
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [off(0, 0)]);
    assert_eq!(given(&mut graph, 2), [off(0, 1)]);
    assert_eq!(held.len(), 0);
}

#[test]
fn play_started_anew_lets_go_of_the_notes_of_the_play_before_at_its_first_frame() {
    let pattern = played(vec![lasting(BAR, note(0, 1, 60))]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    given(&mut graph, 1);
    transport.advance(BLOCK_FRAMES);
    // Between blocks, as when the page puts the position back at the start.
    transport
        .set(true, BAR, Place { press: 1, tick: 0 })
        .unwrap();
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [at(0, 60, 1), off(0, 0)]);
    assert_eq!(held.len(), 1);
}

#[test]
fn play_after_a_stop_lets_go_of_the_notes_before_it_and_goes_on_without_pressing_them_again() {
    let pattern = played(vec![lasting(BAR, note(0, 1, 60))]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    given(&mut graph, 1);
    transport.advance(BLOCK_FRAMES);
    transport.set(false, BAR, Place::default()).unwrap();
    transport.set(true, BAR, Place::default()).unwrap();
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [off(0, 0)]);
    assert_eq!(held.len(), 0);
}

#[test]
fn a_note_whose_node_has_no_room_left_is_let_go_of_at_the_next_block_s_start() {
    let notes = (0..note_room())
        .map(|key| lasting(1, note(0, 1, key)))
        .collect();
    let pattern = played(notes);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1).len(), NOTE_ROOM);
    assert_eq!(held.len(), NOTE_ROOM);
    transport.advance(BLOCK_FRAMES);
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    let expected: Vec<_> = (0..u32::from(note_room())).map(|n| off(0, n)).collect();
    assert_eq!(given(&mut graph, 1), expected);
    assert_eq!(held.len(), 0);
}

#[test]
fn a_note_past_the_held_room_is_lost_and_counted_rather_than_pressed() {
    let mut held = Held::new();
    // Of a node that is gone, so they stay until they end.
    let gone = HeldNote {
        node: NodeHandle::new(3),
        note: NoteId::new(0),
        play: 1,
        until: Some(u64::MAX),
    };
    held.notes.resize(HELD_ROOM - 1, gone);
    let pattern = played(vec![note(0, 1, 60), note(1, 1, 62)]);
    let (transport, mut graph) = (playing(), graph());
    assert_eq!(
        pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES),
        1
    );
    assert_eq!(given(&mut graph, 1), [at(0, 60, 0)]);
    assert_eq!(held.len(), HELD_ROOM);
}

#[test]
fn a_note_of_a_node_gone_since_it_was_pressed_is_dropped_at_its_end() {
    let mut held = Held::new();
    held.notes.push(HeldNote {
        node: NodeHandle::new(3),
        note: NoteId::new(0),
        play: 1,
        until: Some(2),
    });
    let (transport, mut graph) = (playing(), graph());
    Sequencer::default().hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(held.len(), 0);
}

#[test]
fn a_node_s_notes_let_go_of_go_at_the_next_block_s_start_and_no_other_s() {
    let pattern = played(vec![
        lasting(BAR, note(0, 1, 60)),
        lasting(BAR, note(0, 2, 61)),
    ]);
    let (mut transport, mut graph, mut held) = (playing(), graph(), Held::new());
    pattern.hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    given(&mut graph, 1);
    given(&mut graph, 2);
    held.let_go_of(&[NodeHandle::new(1)]);
    transport.advance(BLOCK_FRAMES);
    Sequencer::default().hand_out(&mut held, &transport, &mut graph, BLOCK_FRAMES);
    assert_eq!(given(&mut graph, 1), [off(0, 0)]);
    assert_eq!(given(&mut graph, 2), []);
    assert_eq!(held.len(), 1);
}
