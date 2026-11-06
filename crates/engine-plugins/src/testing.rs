//! Running plugins in tests.

use std::array;
use std::f32::consts::TAU;
use std::ops::Range;
use std::sync::LazyLock;

use crate::{
    BLOCK_FRAMES, CHANNELS, Event, Frames, Plugin, PluginDescription, ProcessContext, SampleReader,
};

pub const SAMPLE_RATE: f32 = 48_000.0;

pub fn silence(samples: usize) -> Vec<f32> {
    vec![0.0; samples]
}

/// At half scale, so an effect has something to work on.
pub fn sine(samples: usize) -> Vec<f32> {
    sine_at(220.0, samples)
}

/// At half scale.
pub fn sine_at(frequency: f32, samples: usize) -> Vec<f32> {
    (0..samples)
        .map(|i| 0.5 * (TAU * frequency * i as f32 / SAMPLE_RATE).sin())
        .collect()
}

/// A new node's first block, which starts with every parameter: at its value in `values`, or at its default.
pub fn first_block(description: &PluginDescription, values: &[(u32, f32)]) -> Vec<Event> {
    description
        .numbered_params()
        .map(|(number, param)| {
            let given = values.iter().rev().find(|&&(given, _)| given == number);
            let value = given.map_or(param.default, |&(_, value)| value);
            Event::param_at_start(number, value)
        })
        .collect()
}

/// A new node's first block with a note at its start, so an instrument sounds; an effect lets it pass.
pub fn first_block_with_note(description: &PluginDescription, values: &[(u32, f32)]) -> Vec<Event> {
    let mut events = first_block(description, values);
    events.push(NOTE);
    events
}

pub const NOTE: Event = Event::NoteOn {
    time: 0,
    key: 60,
    velocity: 1.0,
    note: NOTE_NAME,
};
/// What [`NOTE`] is named, for letting go of it.
pub const NOTE_NAME: u32 = 0;

/// A second of [`sine`]: long enough to sound through a test, short enough to leave silence after. Made once.
static SECOND: LazyLock<Vec<f32>> = LazyLock::new(|| sine(SAMPLE_RATE as usize));

/// The sound every sample of a plugin names, channel by channel; as in the engine, none for a number its
/// description doesn't have.
pub struct Sound<C> {
    samples: u32,
    pub channels: Vec<C>,
}

impl<C: AsRef<[f32]>> Sound<C> {
    pub fn new(description: &PluginDescription, channels: Vec<C>) -> Self {
        Self {
            samples: description.samples.len() as u32,
            channels,
        }
    }
}

impl Sound<&'static [f32]> {
    pub fn second(description: &PluginDescription) -> Self {
        Self::new(description, vec![SECOND.as_slice()])
    }
}

impl<C: AsRef<[f32]>> SampleReader for Sound<C> {
    fn frames(&mut self, sample: u32, frames: Range<usize>) -> Option<Frames<'_>> {
        if sample == 0 || sample > self.samples {
            return None;
        }
        let last = self.channels.len() - 1;
        let channels = array::from_fn(|channel| {
            let numbers = self.channels[channel.min(last)].as_ref();
            let end = frames.end.min(numbers.len());
            &numbers[frames.start.min(end)..end]
        });
        Some(Frames::new(channels, self.channels.len()))
    }
}

/// As before a sound is stored.
pub struct NoSound;

impl SampleReader for NoSound {
    fn frames(&mut self, _: u32, _: Range<usize>) -> Option<Frames<'_>> {
        None
    }
}

/// [`render_with`] every sample of the plugin's `description` naming a [`Sound::second`].
pub fn render(
    description: &PluginDescription,
    plugin: &mut dyn Plugin,
    events: &[Event],
    input: &[f32],
) -> [Vec<f32>; CHANNELS] {
    render_with(plugin, events, input, &mut Sound::second(description))
}

/// Feeds `input` to both channels block by block, with `events` in the first block. Samples the plugin didn't write
/// come back as NaN.
pub fn render_with(
    plugin: &mut dyn Plugin,
    events: &[Event],
    input: &[f32],
    samples: &mut dyn SampleReader,
) -> [Vec<f32>; CHANNELS] {
    assert!(
        events.is_empty() || !input.is_empty(),
        "events need a block"
    );
    let mut output = [vec![f32::NAN; input.len()], vec![f32::NAN; input.len()]];
    let [left, right] = &mut output;
    let blocks = input
        .chunks(BLOCK_FRAMES)
        .zip(left.chunks_mut(BLOCK_FRAMES))
        .zip(right.chunks_mut(BLOCK_FRAMES));
    for (block, ((input, left), right)) in blocks.enumerate() {
        plugin.process(ProcessContext {
            input: [input, input],
            output: [left, right],
            events: if block == 0 { events } else { &[] },
            samples: &mut *samples,
        });
    }
    output
}

pub fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

pub fn rms(samples: &[f32]) -> f32 {
    let squares: f32 = samples.iter().map(|sample| sample * sample).sum();
    (squares / samples.len() as f32).sqrt()
}

/// Between neighbouring samples.
pub fn largest_step(samples: &[f32]) -> f32 {
    samples
        .windows(2)
        .fold(0.0, |step, pair| step.max((pair[1] - pair[0]).abs()))
}
