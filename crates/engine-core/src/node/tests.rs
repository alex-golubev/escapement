use engine_plugins::catalog::CATALOG;

use super::*;
use crate::BLOCK_FRAMES;
use crate::heap;
use crate::pool::SamplePool;
use crate::testing::plugins::{CONSTANT, GIVEN, READER, RECORDER};
use crate::testing::pool::store;
use crate::testing::{SAMPLE_RATE, param_number, ramp, sample_number};

const HANDLE: NodeHandle = NodeHandle::new(1);

const KICK: [u8; 32] = [1; 32];

#[test]
fn an_insert_passes_on_what_it_hears() {
    let mut insert = Node::insert(SAMPLE_RATE, HANDLE, false);
    let left: [f32; BLOCK_FRAMES] = array::from_fn(|i| i as f32 / 128.0);
    let right: [f32; BLOCK_FRAMES] = array::from_fn(|i| -(i as f32) / 64.0);
    insert.process(&[left, right], BLOCK_FRAMES);
    assert_eq!(insert.output(), &[left, right]);
    // A shorter block leaves the rest of the output as it was.
    insert.process(&SILENCE, 3);
    assert_eq!(insert.output()[0][..4], [0.0, 0.0, 0.0, left[3]]);
}

#[test]
fn an_insert_takes_no_parameter_or_sound_and_lets_notes_pass_unheard() {
    let mut insert = Node::insert(SAMPLE_RATE, HANDLE, false);
    assert_eq!(
        insert.set_param(param_number(1), 0.5),
        Err(Rejection::UnknownTarget)
    );
    let sound = || -> Arc<Sample> { unreachable!("an insert has no sample to take a sound for") };
    assert_eq!(
        insert.set_sample(sample_number(1), sound),
        Err(Rejection::UnknownTarget)
    );
    assert_eq!(insert.note_on(0, 60, 1.0, NoteId::new(60)), Ok(()));
    assert_eq!(
        insert.note_on(0, 128, 1.0, NoteId::new(128)),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(insert.note_off(0, NoteId::new(60)), Ok(()));
}

#[test]
fn the_first_block_starts_with_every_parameter_at_its_default() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(
        GIVEN.take(),
        [
            Event::param_at_start(param_number(1), 0.25),
            Event::param_at_start(param_number(2), 0.75)
        ]
    );
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(GIVEN.take(), []);
}

#[test]
fn values_given_before_the_first_block_replace_the_defaults() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    assert_eq!(node.set_param(param_number(2), 0.1), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(
        GIVEN.take(),
        [
            Event::param_at_start(param_number(1), 0.25),
            Event::param_at_start(param_number(2), 0.1)
        ]
    );
}

#[test]
fn a_later_change_to_a_parameter_replaces_the_earlier_one_of_the_block() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    for (number, value) in [(1, 0.1), (2, 0.3), (1, 0.2)] {
        assert_eq!(node.set_param(param_number(number), value), Ok(()));
    }
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(
        GIVEN.take(),
        [
            Event::param_at_start(param_number(1), 0.2),
            Event::param_at_start(param_number(2), 0.3)
        ]
    );
}

/// Named by its key.
fn note(key: u8, velocity: f32) -> Event {
    Event::NoteOn {
        time: 0,
        key,
        velocity,
        note: NoteId::new(key.into()),
    }
}

#[test]
fn notes_reach_the_plugin_after_the_block_s_parameter_values() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    assert_eq!(node.note_on(0, 60, 1.0, NoteId::new(60)), Ok(()));
    assert_eq!(node.set_param(param_number(1), 0.1), Ok(()));
    assert_eq!(node.note_on(0, 62, 0.5, NoteId::new(62)), Ok(()));
    assert_eq!(node.set_param(param_number(1), 0.2), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    let given = [
        Event::param_at_start(param_number(1), 0.2),
        note(60, 1.0),
        note(62, 0.5),
    ];
    assert_eq!(GIVEN.take(), given);
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(GIVEN.take(), []);
}

#[test]
fn a_note_reaches_the_plugin_at_its_frame() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    assert_eq!(node.note_on(0, 60, 1.0, NoteId::new(60)), Ok(()));
    assert_eq!(node.note_on(37, 62, 0.5, NoteId::new(62)), Ok(()));
    assert_eq!(node.note_on(37, 64, 0.25, NoteId::new(64)), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    let at = |time, key: u8, velocity| Event::NoteOn {
        time,
        key,
        velocity,
        note: NoteId::new(key.into()),
    };
    assert_eq!(
        GIVEN.take(),
        [at(0, 60, 1.0), at(37, 62, 0.5), at(37, 64, 0.25)]
    );
}

#[test]
fn notes_reach_the_plugin_in_time_order_whatever_order_they_come_in() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    let off = |time, note| Event::NoteOff {
        time,
        note: NoteId::new(note),
    };
    let on = |time, key: u8| Event::NoteOn {
        time,
        key,
        velocity: 1.0,
        note: NoteId::new(key.into()),
    };
    assert_eq!(node.note_off(90, NoteId::new(60)), Ok(()));
    assert_eq!(node.note_on(90, 62, 1.0, NoteId::new(62)), Ok(()));
    assert_eq!(node.note_on(10, 60, 1.0, NoteId::new(60)), Ok(()));
    assert_eq!(node.note_off(10, NoteId::new(64)), Ok(()));
    assert_eq!(node.note_on(10, 64, 1.0, NoteId::new(64)), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    // At one frame, pressed before let go of; otherwise in the order they came.
    assert_eq!(
        GIVEN.take(),
        [on(10, 60), on(10, 64), off(10, 64), on(90, 62), off(90, 60)]
    );
}

#[test]
fn a_note_let_go_of_takes_a_place_of_its_own() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    for _ in 0..NOTE_ROOM {
        assert_eq!(node.note_off(0, NoteId::new(127)), Ok(()));
    }
    assert_eq!(
        node.note_off(0, NoteId::new(60)),
        Err(Rejection::TooManyNotes)
    );
    assert_eq!(
        node.note_on(0, 60, 1.0, NoteId::new(60)),
        Err(Rejection::TooManyNotes)
    );
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(GIVEN.take().len(), NOTE_ROOM);
}

#[test]
fn only_notes_a_plugin_can_play_reach_it() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    assert_eq!(
        node.note_on(0, 128, 1.0, NoteId::new(128)),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(
        node.note_on(0, 60, f32::NAN, NoteId::new(60)),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(
        node.note_on(0, 60, f32::INFINITY, NoteId::new(60)),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(node.note_on(0, 127, 2.0, NoteId::new(127)), Ok(()));
    assert_eq!(node.note_on(0, 0, -1.0, NoteId::new(0)), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(GIVEN.take(), [note(127, 1.0), note(0, 0.0)]);
}

#[test]
fn a_block_takes_notes_up_to_its_room() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    for _ in 0..NOTE_ROOM {
        assert_eq!(node.note_on(0, 60, 1.0, NoteId::new(60)), Ok(()));
    }
    assert_eq!(
        node.note_on(0, 60, 1.0, NoteId::new(60)),
        Err(Rejection::TooManyNotes)
    );
    // Parameter changes still fit.
    assert_eq!(node.set_param(param_number(2), 0.5), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(GIVEN.take().len(), 2 + NOTE_ROOM);
    assert_eq!(node.note_on(0, 60, 1.0, NoteId::new(60)), Ok(()));
}

#[test]
fn only_values_the_description_allows_reach_the_plugin() {
    let mut node = Node::new(&RECORDER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    GIVEN.take();
    assert_eq!(
        node.set_param(param_number(3), 0.5),
        Err(Rejection::UnknownTarget)
    );
    assert_eq!(
        node.set_param(param_number(1), f32::NAN),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(
        node.set_param(param_number(1), f32::INFINITY),
        Err(Rejection::InvalidValue)
    );
    assert_eq!(node.set_param(param_number(1), -2.0), Ok(()));
    assert_eq!(node.set_param(param_number(2), 0.5), Ok(()));
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(
        GIVEN.take(),
        [
            Event::param_at_start(param_number(1), 0.0),
            Event::param_at_start(param_number(2), 0.5)
        ]
    );
}

#[test]
fn no_plugin_of_the_catalog_touches_the_heap_once_created() {
    for entry in CATALOG {
        let mut node = Node::new(entry, SAMPLE_RATE, HANDLE);
        let before = heap::calls();
        node.process(&SILENCE, BLOCK_FRAMES);
        for (number, param) in ParamNumber::each(entry.description.params) {
            for value in [param.min, param.max, f32::NAN] {
                let _ = node.set_param(number, value);
                node.process(&SILENCE, BLOCK_FRAMES);
            }
        }
        // A flood of changes to every parameter and of notes in one block.
        for _ in 0..100 {
            for (number, param) in ParamNumber::each(entry.description.params) {
                let _ = node.set_param(number, param.min);
                let _ = node.note_on(0, 60, 1.0, NoteId::new(60));
                let _ = node.set_param(number, param.max);
            }
            let _ = node.note_on(0, 60, 1.0, NoteId::new(60));
        }
        node.process(&SILENCE, BLOCK_FRAMES);
        let calls = heap::calls().wrapping_sub(before);
        assert_eq!(calls, 0, "{}", entry.name);
    }
}

#[test]
fn a_plugin_reads_the_sound_its_sample_names_once_it_is_stored() {
    let mut pool = SamplePool::new(SAMPLE_RATE);
    let mut node = Node::new(&READER, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(node.output(), &SILENCE, "no sound named");
    assert_eq!(
        node.set_sample(sample_number(1), || pool.refer(KICK)),
        Ok(())
    );
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(node.output(), &SILENCE, "not stored yet");
    // Shorter than a block, so the view is cut at the sound's end.
    let (left, right) = (ramp(100, 1.0), ramp(100, -100.0));
    store(&mut pool, KICK, &[&left, &right], 30).unwrap();
    node.process(&SILENCE, BLOCK_FRAMES);
    let [heard_left, heard_right] = node.output();
    assert_eq!(heard_left[..100], left);
    assert_eq!(heard_right[..100], right);
    assert_eq!(heard_left[100..], [0.0; BLOCK_FRAMES - 100]);
}

#[test]
fn a_mono_sound_reads_as_one_channel() {
    let mut pool = SamplePool::new(SAMPLE_RATE);
    let mono = ramp(BLOCK_FRAMES, 0.5);
    store(&mut pool, KICK, &[&mono], BLOCK_FRAMES).unwrap();
    let mut node = Node::new(&READER, SAMPLE_RATE, HANDLE);
    assert_eq!(
        node.set_sample(sample_number(1), || pool.refer(KICK)),
        Ok(())
    );
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(node.output()[0], *mono);
    assert_eq!(node.output()[1], *mono);
}

#[test]
fn a_sample_the_plugin_does_not_have_takes_no_sound() {
    let mut node = Node::new(&READER, SAMPLE_RATE, HANDLE);
    let set = node.set_sample(sample_number(2), || panic!("taken for sample 2"));
    assert_eq!(set, Err(Rejection::UnknownTarget));
    let mut pool = SamplePool::new(SAMPLE_RATE);
    store(&mut pool, KICK, &[&[0.5]], 1).unwrap();
    let mut sounds = Sounds(&[Some(pool.refer(KICK))]);
    assert!(sounds.frames(sample_number(1), 0..1).is_some());
    assert!(sounds.frames(sample_number(2), 0..1).is_none());
}

#[test]
fn renders_into_its_own_output_from_the_first_sample() {
    let mut node = Node::new(&CONSTANT, SAMPLE_RATE, HANDLE);
    node.process(&SILENCE, BLOCK_FRAMES);
    assert_eq!(node.output(), &[[1.0; BLOCK_FRAMES], [-1.0; BLOCK_FRAMES]]);
}
