//! A node of the graph: a plugin in its slot, or a mixer insert of the core, then its strip. Only values a plugin's
//! description allows reach the plugin, and its defaults come from there too; an insert has no parameters, sounds or
//! notes.

use std::array;
use std::ops::Range;
use std::sync::Arc;

use engine_plugins::catalog::CatalogEntry;
use engine_plugins::{
    BLOCK_FRAMES, CHANNELS, Event, Frames, NoteId, ParamNumber, Plugin, PluginDescription,
    ProcessContext, SampleNumber, SampleRate, SampleReader,
};

use crate::handle::NodeHandle;
use crate::notes::note_velocity;
use crate::pool::Sample;
use crate::schema::Rejection;
use crate::strip::{Strip, StripNumber};
use crate::telemetry::NodeMeter;

/// Notes a node takes in one block: far more than hands or a pattern's steps give.
pub(crate) const NOTE_ROOM: usize = 32;

/// As the page names it: 0 is refused, as is a number the node's plugin doesn't have, once it is asked.
pub(crate) fn page_param(number: u32) -> Result<ParamNumber, Rejection> {
    ParamNumber::new(number).ok_or(Rejection::UnknownTarget)
}

/// As [`page_param`].
pub(crate) fn page_sample(number: u32) -> Result<SampleNumber, Rejection> {
    SampleNumber::new(number).ok_or(Rejection::UnknownTarget)
}

pub struct Node {
    handle: NodeHandle,
    kind: Kind,
    strip: Strip,
    /// Of what it passes on, for the page, if the page gave it one.
    meter: Option<NodeMeter>,
    /// The last block's.
    output: [[f32; BLOCK_FRAMES]; CHANNELS],
}

/// What the node does with what it hears.
enum Kind {
    Plugin(Slot),
    /// Passes on the sum of what it hears.
    Insert,
}

/// A plugin in its slot, and what it gets at the start of the next block.
struct Slot {
    plugin: Box<dyn Plugin>,
    description: &'static PluginDescription,
    /// A change to each parameter at most, then the notes.
    events: Vec<Event>,
    /// How many of `events` are parameter changes.
    changed: usize,
    /// Where each parameter's change lies in `events`, by the parameter's place in the description.
    changes: Box<[Option<usize>]>,
    /// The sound each sample names, by its place in the description; none until the node's creation names one.
    samples: Box<[Option<Arc<Sample>>]>,
}

impl Node {
    /// A plugin of the catalog, every parameter at its default. Allocates, so only on the build thread.
    pub(crate) fn new(
        entry: &'static CatalogEntry,
        sample_rate: SampleRate,
        handle: NodeHandle,
    ) -> Self {
        let description = entry.description;
        let params = description.params.len();
        let mut slot = Slot {
            plugin: (entry.create)(sample_rate),
            description,
            events: Vec::with_capacity(params + NOTE_ROOM),
            changed: 0,
            changes: vec![None; params].into_boxed_slice(),
            samples: vec![None; description.samples.len()].into_boxed_slice(),
        };
        for (number, param) in ParamNumber::each(description.params) {
            slot.change(number, param.default);
        }
        Self::with(handle, Kind::Plugin(slot), sample_rate)
    }

    /// A mixer insert, with a meter if the page asked for one. Allocates, so only on the build thread.
    pub(crate) fn insert(sample_rate: SampleRate, handle: NodeHandle, metered: bool) -> Self {
        Self {
            meter: metered.then(|| NodeMeter::new(handle, sample_rate)),
            ..Self::with(handle, Kind::Insert, sample_rate)
        }
    }

    fn with(handle: NodeHandle, kind: Kind, sample_rate: SampleRate) -> Self {
        Self {
            handle,
            kind,
            strip: Strip::new(sample_rate),
            meter: None,
            output: [[0.0; BLOCK_FRAMES]; CHANNELS],
        }
    }

    /// A value is taken as [`engine_plugins::ParamDescription::taken`] has it. An insert has no parameters a
    /// plugin's could be taken for.
    pub fn set_param(&mut self, number: ParamNumber, value: f32) -> Result<(), Rejection> {
        let Kind::Plugin(slot) = &mut self.kind else {
            return Err(Rejection::UnknownTarget);
        };
        let param = number
            .entry(slot.description.params)
            .ok_or(Rejection::UnknownTarget)?;
        let value = param.taken(value).ok_or(Rejection::InvalidValue)?;
        slot.change(number, value);
        Ok(())
    }

    /// A parameter of its strip, by its place in [`crate::strip::STRIP`].
    pub fn set_strip_param(&mut self, number: StripNumber, value: f32) -> Result<(), Rejection> {
        self.strip.set(number, value)
    }

    /// `sound` is taken only for a sample the plugin has.
    pub(crate) fn set_sample(
        &mut self,
        number: SampleNumber,
        sound: impl FnOnce() -> Arc<Sample>,
    ) -> Result<(), Rejection> {
        let Kind::Plugin(slot) = &mut self.kind else {
            return Err(Rejection::UnknownTarget);
        };
        number
            .entry(slot.description.samples)
            .ok_or(Rejection::UnknownTarget)?;
        slot.samples[number.index()] = Some(sound());
        Ok(())
    }

    /// At the frame `time` of the next block, in time order among its notes. An insert doesn't hear notes, as a plugin
    /// that plays none doesn't.
    /// `note` names it until it is let go of.
    pub fn note_on(
        &mut self,
        time: u32,
        key: u8,
        velocity: f32,
        note: NoteId,
    ) -> Result<(), Rejection> {
        let velocity = note_velocity(key, velocity)?;
        self.note(Event::NoteOn {
            time,
            key,
            velocity,
            note,
        })
    }

    /// As [`Node::note_on`]: lets go of the note it named.
    pub fn note_off(&mut self, time: u32, note: NoteId) -> Result<(), Rejection> {
        self.note(Event::NoteOff { time, note })
    }

    fn note(&mut self, note: Event) -> Result<(), Rejection> {
        let Kind::Plugin(slot) = &mut self.kind else {
            return Ok(());
        };
        let notes = &slot.events[slot.changed..];
        if notes.len() == NOTE_ROOM {
            return Err(Rejection::TooManyNotes);
        }
        // After the notes of its frame that came before it; one pressed before one let go of.
        let place = notes.partition_point(|other| note_order(other) <= note_order(&note));
        slot.events.insert(slot.changed + place, note);
        Ok(())
    }

    /// Renders `frames` of `input` into its output, at most [`BLOCK_FRAMES`].
    pub fn process(&mut self, input: &[[f32; BLOCK_FRAMES]; CHANNELS], frames: usize) {
        match &mut self.kind {
            Kind::Plugin(slot) => slot.process(input, &mut self.output, frames),
            Kind::Insert => {
                for (output, input) in self.output.iter_mut().zip(input) {
                    output[..frames].copy_from_slice(&input[..frames]);
                }
            }
        }
        self.strip.apply(&mut self.output, frames);
        if let Some(meter) = &mut self.meter {
            meter.update(&self.output, frames);
        }
    }

    pub fn output(&self) -> &[[f32; BLOCK_FRAMES]; CHANNELS] {
        &self.output
    }

    pub(crate) fn meter_mut(&mut self) -> Option<&mut NodeMeter> {
        self.meter.as_mut()
    }

    pub(crate) fn handle(&self) -> NodeHandle {
        self.handle
    }
}

/// At one frame, notes pressed come before notes let go of.
fn note_order(note: &Event) -> (u32, bool) {
    (note.time(), matches!(note, Event::NoteOff { .. }))
}

impl Slot {
    /// A parameter has one value at a time, so a later change replaces the earlier one: the changes never outgrow
    /// the room for one each. They go before the notes, so a note hears its block's values. `number` is in the
    /// description.
    fn change(&mut self, number: ParamNumber, value: f32) {
        let event = Event::param_at_start(number, value);
        let place = &mut self.changes[number.index()];
        if let Some(at) = *place {
            self.events[at] = event;
        } else {
            *place = Some(self.changed);
            self.events.insert(self.changed, event);
            self.changed += 1;
        }
    }

    fn process(
        &mut self,
        input: &[[f32; BLOCK_FRAMES]; CHANNELS],
        output: &mut [[f32; BLOCK_FRAMES]; CHANNELS],
        frames: usize,
    ) {
        self.plugin.process(ProcessContext {
            input: input.each_ref().map(|channel| &channel[..frames]),
            output: output.each_mut().map(|channel| &mut channel[..frames]),
            events: &self.events,
            samples: &mut Sounds(&self.samples),
        });
        for event in &self.events[..self.changed] {
            if let Event::Param { param, .. } = event {
                self.changes[param.index()] = None;
            }
        }
        self.events.clear();
        self.changed = 0;
    }
}

/// A plugin's view of its sounds, straight into the pool.
struct Sounds<'a>(&'a [Option<Arc<Sample>>]);

impl SampleReader for Sounds<'_> {
    fn frames(&mut self, sample: SampleNumber, frames: Range<usize>) -> Option<Frames<'_>> {
        let sound = self.0.get(sample.index())?.as_deref()?;
        let pcm = sound.pcm()?;
        let channels = array::from_fn(|channel| pcm.view(channel, frames.clone()));
        Some(Frames::new(channels, pcm.channels()))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::RefCell;

    use engine_plugins::catalog::CATALOG;
    use engine_plugins::{ParamDescription, SampleDescription, Scale, Values};

    use super::*;
    use crate::heap;
    use crate::pool::SamplePool;
    use crate::pool::tests::store;
    use crate::testing::{SAMPLE_RATE, SILENCE, param_number, sample_number};

    const HANDLE: NodeHandle = NodeHandle::new(1);

    thread_local! {
        pub(crate) static GIVEN: RefCell<Vec<Event>> = const { RefCell::new(Vec::new()) };
    }

    /// Keeps every event it is given in `GIVEN`, which takes the heap.
    struct Recorder;

    impl Plugin for Recorder {
        fn process(&mut self, context: ProcessContext<'_>) {
            GIVEN.with_borrow_mut(|given| given.extend(context.events));
            for channel in context.output {
                channel.fill(0.0);
            }
        }
    }

    /// Plays 1 on the left and −1 on the right.
    struct Constant;

    impl Plugin for Constant {
        fn process(&mut self, context: ProcessContext<'_>) {
            let [left, right] = context.output;
            left.fill(1.0);
            right.fill(-1.0);
        }
    }

    const fn param(id: &'static str, default: f32) -> ParamDescription {
        ParamDescription {
            id,
            label: id,
            group: None,
            unit: None,
            scale: Scale::Linear,
            values: Values::Any,
            min: 0.0,
            max: 1.0,
            default,
            smoothing_seconds: 0.0,
        }
    }

    /// Plays its input.
    struct Through;

    impl Plugin for Through {
        fn process(&mut self, context: ProcessContext<'_>) {
            for (output, input) in context.output.into_iter().zip(context.input) {
                output.copy_from_slice(input);
            }
        }
    }

    pub static THROUGH: CatalogEntry = CatalogEntry {
        name: "through",
        description: &PluginDescription {
            id: 2,
            version: 1,
            label: "Through",
            params: &[],
            samples: &[],
        },
        create: |_| Box::new(Through),
    };

    pub static CONSTANT: CatalogEntry = CatalogEntry {
        name: "constant",
        description: &PluginDescription {
            id: 3,
            version: 1,
            label: "Constant",
            params: &[],
            samples: &[],
        },
        create: |_| Box::new(Constant),
    };

    /// Plays the first frames of its sample's sound in every block: its first channel on the left, its last on the
    /// right; silence past the sound's end and without one.
    struct Reader;

    impl Plugin for Reader {
        fn process(&mut self, context: ProcessContext<'_>) {
            let [left, right] = context.output;
            left.fill(0.0);
            right.fill(0.0);
            if let Some(frames) = context.samples.frames(sample_number(1), 0..left.len()) {
                let (first, last) = (
                    frames.channels()[0],
                    frames.channels()[frames.channels().len() - 1],
                );
                left[..frames.len()].copy_from_slice(first);
                right[..frames.len()].copy_from_slice(last);
            }
        }
    }

    static READER: CatalogEntry = CatalogEntry {
        name: "reader",
        description: &PluginDescription {
            id: 4,
            version: 1,
            label: "Reader",
            params: &[],
            samples: &[SampleDescription {
                id: "sound",
                label: "Sound",
            }],
        },
        create: |_| Box::new(Reader),
    };

    const KICK: [u8; 32] = [1; 32];

    fn ramp(len: usize, from: f32) -> Vec<f32> {
        (0..len).map(|i| from + i as f32).collect()
    }

    pub(crate) static RECORDER: CatalogEntry = CatalogEntry {
        name: "recorder",
        description: &PluginDescription {
            id: 1,
            version: 1,
            label: "Recorder",
            params: &[param("low", 0.25), param("high", 0.75)],
            samples: &[],
        },
        create: |_| Box::new(Recorder),
    };

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
        let sound =
            || -> Arc<Sample> { unreachable!("an insert has no sample to take a sound for") };
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
}
