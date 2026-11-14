//! Running plugins in tests.

use std::array;
use std::f32::consts::TAU;
use std::ops::Range;
use std::sync::LazyLock;

use crate::{
    BLOCK_FRAMES, CHANNELS, Event, Frames, NoteId, ParamDescription, ParamNumber, Plugin,
    PluginDescription, ProcessContext, SampleNumber, SampleRate, SampleReader, Scale, Values,
};

pub(crate) const SAMPLE_RATE: SampleRate = SampleRate::new(48_000).unwrap();

pub(crate) fn rate(hz: u32) -> SampleRate {
    SampleRate::new(hz).unwrap()
}

/// As a command names it.
pub(crate) fn param_number(number: u32) -> ParamNumber {
    ParamNumber::new(number).unwrap()
}

/// As an edit names it.
pub(crate) fn sample_number(number: u32) -> SampleNumber {
    SampleNumber::new(number).unwrap()
}

/// The frames `seconds` take at [`SAMPLE_RATE`].
pub(crate) const fn seconds(seconds: f32) -> usize {
    SAMPLE_RATE.frames(seconds) as usize
}

pub(crate) fn silence(samples: usize) -> Vec<f32> {
    vec![0.0; samples]
}

/// At half scale, so an effect has something to work on.
pub(crate) fn sine(samples: usize) -> Vec<f32> {
    sine_at(220.0, samples)
}

/// At half scale.
pub(crate) fn sine_at(frequency: f32, samples: usize) -> Vec<f32> {
    (0..samples)
        .map(|i| 0.5 * (TAU * frequency * i as f32 / SAMPLE_RATE.hz()).sin())
        .collect()
}

/// A new node's first block, which starts with every parameter: at its value in `values`, or at its default.
pub(crate) fn first_block(
    description: &PluginDescription,
    values: &[(ParamNumber, f32)],
) -> Vec<Event> {
    ParamNumber::each(description.params)
        .map(|(number, param)| {
            let given = values.iter().rev().find(|&&(given, _)| given == number);
            let value = given.map_or(param.default, |&(_, value)| value);
            Event::param_at_start(number, value)
        })
        .collect()
}

/// A new node's first block with a note at its start, so an instrument sounds; an effect lets it pass.
pub(crate) fn first_block_with_note(
    description: &PluginDescription,
    values: &[(ParamNumber, f32)],
) -> Vec<Event> {
    let mut events = first_block(description, values);
    events.push(NOTE);
    events
}

pub(crate) const NOTE: Event = note_on(0, 60, 1.0, NOTE_NAME);
/// What [`NOTE`] is named, for letting go of it.
pub(crate) const NOTE_NAME: u32 = 0;

/// `key` pressed at `time`, the note named `note`.
pub(crate) const fn note_on(time: u32, key: u8, velocity: f32, note: u32) -> Event {
    Event::NoteOn {
        time,
        key,
        velocity,
        note: NoteId::new(note),
    }
}

/// The note named `note` let go of at `time`.
pub(crate) const fn note_off(time: u32, note: u32) -> Event {
    Event::NoteOff {
        time,
        note: NoteId::new(note),
    }
}

/// A plain knob from 0 to 1, at 0.5 and unsmoothed: a test sets what it needs over it.
pub(crate) const fn param(id: &'static str) -> ParamDescription {
    ParamDescription {
        id,
        label: "Knob",
        group: None,
        unit: None,
        scale: Scale::Linear,
        values: Values::Any,
        min: 0.0,
        max: 1.0,
        default: 0.5,
        smoothing_seconds: 0.0,
    }
}

/// A second of [`sine`]: long enough to sound through a test, short enough to leave silence after. Made once.
static SECOND: LazyLock<Vec<f32>> = LazyLock::new(|| sine(seconds(1.0)));

/// The sound every sample of a plugin names, channel by channel; as in the engine, none for a number its
/// description doesn't have.
pub(crate) struct Sound<C> {
    samples: usize,
    pub channels: Vec<C>,
}

impl<C: AsRef<[f32]>> Sound<C> {
    pub(crate) fn new(description: &PluginDescription, channels: Vec<C>) -> Self {
        Self {
            samples: description.samples.len(),
            channels,
        }
    }
}

impl Sound<&'static [f32]> {
    pub(crate) fn second(description: &PluginDescription) -> Self {
        Self::new(description, vec![SECOND.as_slice()])
    }
}

impl<C: AsRef<[f32]>> SampleReader for Sound<C> {
    fn frames(&mut self, sample: SampleNumber, frames: Range<usize>) -> Option<Frames<'_>> {
        if sample.index() >= self.samples {
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
pub(crate) struct NoSound;

impl SampleReader for NoSound {
    fn frames(&mut self, _: SampleNumber, _: Range<usize>) -> Option<Frames<'_>> {
        None
    }
}

/// [`render_with`] every sample of the plugin's `description` naming a [`Sound::second`].
pub(crate) fn render(
    description: &PluginDescription,
    plugin: &mut dyn Plugin,
    events: &[Event],
    input: &[f32],
) -> [Vec<f32>; CHANNELS] {
    render_with(plugin, events, input, &mut Sound::second(description))
}

/// Feeds `input` to both channels block by block, with `events` in the first block. Samples the plugin didn't write
/// come back as NaN.
pub(crate) fn render_with(
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

pub(crate) fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

pub(crate) fn rms(samples: &[f32]) -> f32 {
    let squares: f32 = samples.iter().map(|sample| sample * sample).sum();
    (squares / samples.len() as f32).sqrt()
}

/// Between neighbouring samples.
pub(crate) fn largest_step(samples: &[f32]) -> f32 {
    samples
        .windows(2)
        .fold(0.0, |step, pair| step.max((pair[1] - pair[0]).abs()))
}

/// A level, full scale being 1, in decibels.
pub(crate) fn decibels(level: f32) -> f32 {
    20.0 * level.log10()
}

/// The largest difference between the two over `range`.
pub(crate) fn difference(a: &[f32], b: &[f32], range: Range<usize>) -> f32 {
    a[range.clone()]
        .iter()
        .zip(&b[range])
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

/// Where the sound rises through 0, from below it to 0 or above, between samples.
pub(crate) fn rising_at(samples: &[f32]) -> Vec<f64> {
    let rising = samples.windows(2).enumerate();
    rising
        .filter(|(_, pair)| pair[0] < 0.0 && pair[1] >= 0.0)
        .map(|(i, pair)| i as f64 + f64::from(pair[0] / (pair[0] - pair[1])))
        .collect()
}

/// How often the sound rises through 0, as [`rising_at`] has it.
pub(crate) fn rising_crossings(samples: &[f32]) -> usize {
    rising_at(samples).len()
}
