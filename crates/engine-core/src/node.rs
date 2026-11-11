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
mod tests;
