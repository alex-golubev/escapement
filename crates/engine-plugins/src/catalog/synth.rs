//! A synthesizer of three oscillators, each a wave of its chosen shape at the note's pitch moved by its own tuning, Osc
//! 2 and Osc 3 each taking its mix's share of the sound from those before it. Each note's level follows the envelope
//! from its press. Notes overlap, each in a voice of its own.

use std::f32::consts::TAU;

use crate::envelope::{self, Contour, Envelope};
use crate::events::{Step, steps};
use crate::smoothing::Smoothed;
use crate::{
    BLOCK_FRAMES, Choice, Event, ParamDescription, Plugin, PluginDescription, ProcessContext,
    Scale, Unit, Values,
};

/// From the smoothest to the brightest. Projects keep them by place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Sine,
    Triangle,
    Square,
    Saw,
    Noise,
}

impl Shape {
    pub const ALL: [Self; 5] = [
        Self::Sine,
        Self::Triangle,
        Self::Square,
        Self::Saw,
        Self::Noise,
    ];

    const fn choice(self) -> Choice {
        let (id, label) = match self {
            Self::Sine => ("sine", "Sine"),
            Self::Triangle => ("triangle", "Triangle"),
            Self::Square => ("square", "Square"),
            Self::Saw => ("saw", "Saw"),
            Self::Noise => ("noise", "Noise"),
        };
        Choice { id, label }
    }

    /// From -1 to 1 at `phase`, of the period.
    fn wave(self, phase: f32, increment: f32, noise: &mut Noise) -> f32 {
        match self {
            Self::Sine => (TAU * phase).sin(),
            Self::Triangle => triangle(phase, increment),
            Self::Square => square(phase, increment),
            Self::Saw => saw(phase, increment),
            Self::Noise => noise.next(),
        }
    }
}

const SHAPES: [Choice; Shape::ALL.len()] = {
    let mut choices = [Shape::Sine.choice(); Shape::ALL.len()];
    let mut place = 0;
    while place < choices.len() {
        choices[place] = Shape::ALL[place].choice();
        place += 1;
    }
    choices
};

/// Osc 1 first.
pub const OSCILLATORS: usize = 3;

const fn shape(id: &'static str, group: &'static str) -> ParamDescription {
    ParamDescription {
        id,
        label: "Shape",
        group: Some(group),
        unit: None,
        scale: Scale::Linear,
        values: Values::Choices(&SHAPES),
        min: 0.0,
        max: (SHAPES.len() - 1) as f32,
        default: Shape::Saw as usize as f32,
        // How long one shape takes to give way to another.
        smoothing_seconds: 0.02,
    }
}

/// Two octaves either way. A turn moves a sounding note at once, a semitone at a time: its wave goes on unbroken, so
/// nothing clicks.
const fn coarse(id: &'static str, group: &'static str, default: f32) -> ParamDescription {
    ParamDescription {
        id,
        label: "Coarse",
        group: Some(group),
        unit: Some(Unit::Semitones),
        scale: Scale::Linear,
        values: Values::Whole,
        min: -24.0,
        max: 24.0,
        default,
        smoothing_seconds: 0.0,
    }
}

/// A semitone either way.
const fn fine(id: &'static str, group: &'static str) -> ParamDescription {
    ParamDescription {
        id,
        label: "Fine",
        group: Some(group),
        unit: Some(Unit::Cents),
        scale: Scale::Linear,
        values: Values::Any,
        min: -100.0,
        max: 100.0,
        default: 0.0,
        smoothing_seconds: 0.02,
    }
}

/// The share of the sound it takes from the oscillators before it: three are no louder than one.
const fn mix(id: &'static str, group: &'static str) -> ParamDescription {
    ParamDescription {
        id,
        label: "Mix",
        group: Some(group),
        unit: Some(Unit::Percent),
        scale: Scale::Linear,
        values: Values::Any,
        min: 0.0,
        max: 1.0,
        default: 0.0,
        smoothing_seconds: 0.02,
    }
}

/// What an oscillator is known by: its group and its parameters' IDs, and where its pitch starts.
struct Named {
    group: &'static str,
    shape: &'static str,
    coarse: &'static str,
    fine: &'static str,
    /// Osc 1 has none: it takes what the others leave.
    mix: Option<&'static str>,
    coarse_default: f32,
}

// Osc 2 an octave down and Osc 3 two, so a mix turned up is heard at once; unmixed, Osc 1 plays alone.
const NAMED: [Named; OSCILLATORS] = [
    Named {
        group: "Osc 1",
        shape: "osc1.shape",
        coarse: "osc1.coarse",
        fine: "osc1.fine",
        mix: None,
        coarse_default: 0.0,
    },
    Named {
        group: "Osc 2",
        shape: "osc2.shape",
        coarse: "osc2.coarse",
        fine: "osc2.fine",
        mix: Some("osc2.mix"),
        coarse_default: -12.0,
    },
    Named {
        group: "Osc 3",
        shape: "osc3.shape",
        coarse: "osc3.coarse",
        fine: "osc3.fine",
        mix: Some("osc3.mix"),
        coarse_default: -24.0,
    },
];

/// Four each, but Osc 1, without a mix.
const OSCILLATOR_PARAM_COUNT: usize = 4 * OSCILLATORS - 1;
const PARAM_COUNT: usize = OSCILLATOR_PARAM_COUNT + envelope::PARAMS.len();

/// Oscillator by oscillator, in its order, then the envelope.
const PARAMS: [ParamDescription; PARAM_COUNT] = {
    let mut params = [shape("", ""); PARAM_COUNT];
    let (mut osc, mut place) = (0, 0);
    while osc < OSCILLATORS {
        let named = &NAMED[osc];
        params[place] = shape(named.shape, named.group);
        params[place + 1] = coarse(named.coarse, named.group, named.coarse_default);
        params[place + 2] = fine(named.fine, named.group);
        place += 3;
        if let Some(id) = named.mix {
            params[place] = mix(id, named.group);
            place += 1;
        }
        osc += 1;
    }
    assert!(place == OSCILLATOR_PARAM_COUNT);
    let mut knob = 0;
    while knob < envelope::PARAMS.len() {
        params[place + knob] = envelope::PARAMS[knob];
        knob += 1;
    }
    params
};

pub const DESCRIPTION: PluginDescription = PluginDescription {
    id: 4,
    version: 1,
    label: "Synth",
    params: &PARAMS,
    samples: &[],
};

/// An oscillator's parameters, by number.
#[derive(Clone, Copy, Debug)]
pub struct OscillatorParams {
    pub shape: u32,
    pub coarse: u32,
    pub fine: u32,
    /// Osc 1 has none: it takes what the others leave.
    pub mix: Option<u32>,
}

pub const OSCILLATOR_PARAMS: [OscillatorParams; OSCILLATORS] = {
    let none = OscillatorParams {
        shape: 0,
        coarse: 0,
        fine: 0,
        mix: None,
    };
    let mut numbers = [none; OSCILLATORS];
    let mut osc = 0;
    while osc < OSCILLATORS {
        let named = &NAMED[osc];
        numbers[osc] = OscillatorParams {
            shape: DESCRIPTION.param_number(named.shape),
            coarse: DESCRIPTION.param_number(named.coarse),
            fine: DESCRIPTION.param_number(named.fine),
            mix: match named.mix {
                Some(mix) => Some(DESCRIPTION.param_number(mix)),
                None => None,
            },
        };
        osc += 1;
    }
    numbers
};

pub const ENVELOPE: envelope::Numbers = envelope::Numbers::of(&DESCRIPTION);

/// Notes that sound at once; one more makes the one heard least give way, as `Voice::room` has it.
pub const VOICES: usize = 16;
/// A voice's peak at full velocity: a sawtooth is loud, and chords add up.
pub const VOICE_GAIN: f32 = 0.2;

#[derive(Clone, Copy)]
struct Voice {
    /// Over once the voice is free.
    contour: Contour,
    /// The note it plays, as its `NoteOn` named it.
    note: u32,
    /// Each oscillator's, of its period, from 0 to 1.
    phases: [f32; OSCILLATORS],
    /// Of the key's period a sample moves on; an oscillator's tuning moves it.
    increment: f32,
    gain: f32,
    /// Notes started before it.
    order: u64,
    noises: [Noise; OSCILLATORS],
}

const FREE: Voice = Voice {
    contour: Contour::OVER,
    note: 0,
    phases: [0.0; OSCILLATORS],
    increment: 0.0,
    gain: 0.0,
    order: 0,
    noises: [Noise(1); OSCILLATORS],
};

impl Voice {
    /// Heard as a note, held or let go of, not on its way out to make room.
    fn is_playing(&self) -> bool {
        !self.contour.is_over() && !self.contour.is_giving_way()
    }

    /// How readily it makes room for a new note, lowest first: one fallen silent while held, then a tail, the quietest
    /// first, then one held, the oldest first, as a note on its way up or waiting out its delay is about to sound.
    fn room(&self) -> (u8, f64, u64) {
        let contour = &self.contour;
        match (contour.has_fallen_silent(), contour.is_held()) {
            (true, _) => (0, 0.0, self.order),
            (false, false) => (1, contour.level(), self.order),
            (false, true) => (2, 0.0, self.order),
        }
    }
}

/// What an oscillator plays, in every voice.
struct Oscillator {
    /// Each shape's share of its sound: the chosen one's rises to 1 as the others fall to 0, so a change glides.
    shares: [Smoothed; Shape::ALL.len()],
    chosen: Shape,
    /// In semitones.
    coarse: Smoothed,
    /// In cents.
    fine: Smoothed,
    /// Of the sound left to it and those before it. Osc 1's stays at 1: it takes what the others leave.
    mix: Smoothed,
}

impl Oscillator {
    fn new(params: OscillatorParams, sample_rate: f32) -> Self {
        let param = |number| DESCRIPTION.param(number).expect("its own");
        let chosen = Shape::ALL[param(params.shape).default as usize];
        Self {
            shares: Shape::ALL.map(|shape| {
                let share = if shape == chosen { 1.0 } else { 0.0 };
                Smoothed::new(share, param(params.shape).smoothing_seconds, sample_rate)
            }),
            chosen,
            coarse: Smoothed::for_param(param(params.coarse), sample_rate),
            fine: Smoothed::for_param(param(params.fine), sample_rate),
            mix: match params.mix {
                Some(mix) => Smoothed::for_param(param(mix), sample_rate),
                None => Smoothed::new(1.0, 0.0, sample_rate),
            },
        }
    }

    fn choose(&mut self, chosen: Shape) {
        if chosen == self.chosen {
            return;
        }
        self.chosen = chosen;
        for (shape, share) in Shape::ALL.into_iter().zip(&mut self.shares) {
            share.set(if shape == chosen { 1.0 } else { 0.0 });
        }
    }

    /// How much faster than the key's its pitch runs at each frame.
    fn tune(&mut self, over: &mut [f32]) {
        let ratio = |semitones: f32, cents: f32| ((semitones + cents / 100.0) / 12.0).exp2();
        match (self.coarse.steady(), self.fine.steady()) {
            (Some(semitones), Some(cents)) => over.fill(ratio(semitones, cents)),
            _ => {
                for (at, (semitones, cents)) in
                    over.iter_mut().zip((&mut self.coarse).zip(&mut self.fine))
                {
                    *at = ratio(semitones, cents);
                }
            }
        }
    }
}

/// How much of a pitched wave is heard at `increment`: all of it up to half an octave below half the sample rate, then
/// less and less, none from there on, where it could only alias. So a glide across it fades rather than cuts off.
fn below_half_the_sample_rate(increment: f32) -> f32 {
    const FADE_FROM: f32 = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
    ((0.5 - increment) / (0.5 - FADE_FROM)).clamp(0.0, 1.0)
}

/// The smoothed value at each frame.
fn fill(smoothed: &mut Smoothed, over: &mut [f32]) {
    match smoothed.steady() {
        Some(steady) => over.fill(steady),
        None => over
            .iter_mut()
            .zip(smoothed)
            .for_each(|(at, value)| *at = value),
    }
}

/// Over a block's frames.
type Frames = [f32; BLOCK_FRAMES];

struct Synth {
    /// Half of them for voices giving way.
    voices: [Voice; 2 * VOICES],
    oscillators: [Oscillator; OSCILLATORS],
    /// For each oscillator over the block: each shape's part of the sound, and whether it is heard.
    parts: [[Frames; Shape::ALL.len()]; OSCILLATORS],
    heard: [[bool; Shape::ALL.len()]; OSCILLATORS],
    /// For each oscillator over the block: as `Oscillator::tune` has it.
    ratios: [Frames; OSCILLATORS],
    sample_rate: f32,
    envelope: Envelope,
    notes: u64,
}

pub(crate) fn create(sample_rate: f32) -> Box<dyn Plugin> {
    Box::new(Synth {
        voices: [FREE; 2 * VOICES],
        oscillators: OSCILLATOR_PARAMS.map(|params| Oscillator::new(params, sample_rate)),
        parts: [[[0.0; BLOCK_FRAMES]; Shape::ALL.len()]; OSCILLATORS],
        heard: [[false; Shape::ALL.len()]; OSCILLATORS],
        ratios: [[1.0; BLOCK_FRAMES]; OSCILLATORS],
        sample_rate,
        envelope: Envelope::new(ENVELOPE, sample_rate),
        notes: 0,
    })
}

impl Plugin for Synth {
    fn process(&mut self, context: ProcessContext<'_>) {
        let ProcessContext {
            output: [left, right],
            events,
            ..
        } = context;
        for step in steps(events, left.len()) {
            match step {
                Step::Event(Event::Param { param, value, .. }) => self.set(param, value),
                Step::Event(Event::NoteOn {
                    key,
                    velocity,
                    note,
                    ..
                }) => self.start(key, velocity, note),
                Step::Event(Event::NoteOff { note, .. }) => self.let_go(note),
                Step::Frames(frames) => self.render(&mut left[frames.clone()], &mut right[frames]),
            }
        }
    }
}

/// Equal temperament, A above middle C at 440 Hz.
#[must_use]
pub fn frequency(key: u8) -> f32 {
    440.0 * ((f32::from(key) - 69.0) / 12.0).exp2()
}

/// What smooths a jump up by 2 at phase 0 over a sample either side (`PolyBLEP`), so high notes don't alias into tones
/// of their own.
fn jump(phase: f32, increment: f32) -> f32 {
    if phase < increment {
        let t = phase / increment;
        2.0 * t - t * t - 1.0
    } else if phase > 1.0 - increment {
        let t = (phase - 1.0) / increment;
        t * t + 2.0 * t + 1.0
    } else {
        0.0
    }
}

/// What rounds a corner at phase 0 where the slope rises by 1 a sample (`PolyBLAMP`), as `jump` smooths a jump.
fn corner(phase: f32, increment: f32) -> f32 {
    let samples = if phase < 0.5 { phase } else { phase - 1.0 } / increment;
    let near = (1.0 - samples.abs()).max(0.0);
    near * near * near / 6.0
}

/// Falls by 2 at phase 0.
fn saw(phase: f32, increment: f32) -> f32 {
    2.0 * phase - 1.0 - jump(phase, increment)
}

/// Up for the first half of the period.
fn square(phase: f32, increment: f32) -> f32 {
    let naive = if phase < 0.5 { 1.0 } else { -1.0 };
    naive + jump(phase, increment) - jump((phase + 0.5).fract(), increment)
}

/// Rises from 0 to its top at a quarter, its bottom at three quarters.
fn triangle(phase: f32, increment: f32) -> f32 {
    let naive = 1.0 - 4.0 * ((phase + 0.25).fract() - 0.5).abs();
    // The slope turns by 8 increments a sample at each corner.
    let turn = 8.0 * increment;
    naive - turn * corner((phase + 0.75).fract(), increment)
        + turn * corner((phase + 0.25).fract(), increment)
}

/// White, the same on every run: xorshift.
#[derive(Clone, Copy)]
struct Noise(u32);

impl Noise {
    /// An oscillator's in a note, so two notes, even of two synths on the same steps, don't sound as one, nor two
    /// oscillators: from the note's name and the oscillator's place, mixed.
    fn of(note: u32, oscillator: usize) -> Self {
        let mut x = note ^ 0x2545_f491 ^ (oscillator as u32).wrapping_mul(0x9e37_79b9);
        x = (x ^ (x >> 16)).wrapping_mul(0x85eb_ca6b);
        x = (x ^ (x >> 13)).wrapping_mul(0xc2b2_ae35);
        Self((x ^ (x >> 16)).max(1))
    }

    fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x as f32 / u32::MAX as f32 * 2.0 - 1.0
    }
}

impl Synth {
    fn set(&mut self, param: u32, value: f32) {
        for (oscillator, params) in self.oscillators.iter_mut().zip(OSCILLATOR_PARAMS) {
            if param == params.shape {
                // As the engine takes it: the nearest.
                if let Some(&shape) = Shape::ALL.get(value.round() as usize) {
                    oscillator.choose(shape);
                }
            } else if param == params.coarse {
                oscillator.coarse.set(value);
            } else if param == params.fine {
                oscillator.fine.set(value);
            } else if Some(param) == params.mix {
                oscillator.mix.set(value);
            }
        }
        self.envelope.set(param, value);
    }

    fn start(&mut self, key: u8, velocity: f32, note: u32) {
        let increment = frequency(key) / self.sample_rate;
        // A silent note takes no voice: it would only push one that is heard out. One too high to sound does, as its
        // oscillators may be tuned down while it is held.
        if velocity == 0.0 {
            return;
        }
        if self
            .voices
            .iter()
            .filter(|voice| voice.is_playing())
            .count()
            == VOICES
        {
            let least = self
                .voices
                .iter_mut()
                .filter(|voice| voice.is_playing())
                .min_by(|a, b| {
                    let ((a_class, a_level, a_order), (b_class, b_level, b_order)) =
                        (a.room(), b.room());
                    (a_class.cmp(&b_class))
                        .then(a_level.total_cmp(&b_level))
                        .then(a_order.cmp(&b_order))
                });
            if let Some(least) = least {
                least.contour.give_way();
            }
        }
        // A free place, or else the voice giving way nearest silence.
        let place = self.voices.iter_mut().max_by(|a, b| {
            let rank =
                |voice: &Voice| match (voice.contour.is_over(), voice.contour.is_giving_way()) {
                    (true, _) => (2, 0.0),
                    (false, true) => (1, -voice.contour.level()),
                    (false, false) => (0, 0.0),
                };
            let ((a_rank, a_level), (b_rank, b_level)) = (rank(a), rank(b));
            a_rank.cmp(&b_rank).then(a_level.total_cmp(&b_level))
        });
        if let Some(place) = place {
            *place = Voice {
                contour: Contour::START,
                note,
                phases: [0.0; OSCILLATORS],
                increment,
                gain: VOICE_GAIN * velocity,
                order: self.notes,
                noises: std::array::from_fn(|oscillator| Noise::of(note, oscillator)),
            };
            self.notes += 1;
        }
    }

    /// A voice that gave way to another note no longer holds its own.
    fn let_go(&mut self, note: u32) {
        let held = self
            .voices
            .iter_mut()
            .find(|voice| voice.contour.is_held() && voice.note == note);
        if let Some(voice) = held {
            self.envelope.let_go(&mut voice.contour);
        }
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let frames = left.len();
        let Self {
            voices,
            oscillators,
            parts,
            heard,
            ratios,
            envelope,
            ..
        } = self;
        envelope.prepare(frames);
        // Of the sound, what is left to the oscillators before, from the last one back: each takes its mix of it.
        let mut left_to = [1.0; BLOCK_FRAMES];
        for osc in (0..OSCILLATORS).rev() {
            let oscillator = &mut oscillators[osc];
            let mut taken = [0.0; BLOCK_FRAMES];
            fill(&mut oscillator.mix, &mut taken[..frames]);
            for (taken, left_to) in taken[..frames].iter_mut().zip(&mut left_to) {
                let mix = *taken;
                *taken = mix * *left_to;
                *left_to *= 1.0 - mix;
            }
            let taken_heard = taken[..frames].iter().any(|taken| *taken != 0.0);
            for (shape, share) in Shape::ALL.into_iter().zip(&mut oscillator.shares) {
                heard[osc][shape as usize] = false;
                // A share at none stays so; one on its way is walked, heard or not, to be where it should.
                if share.steady() == Some(0.0) {
                    continue;
                }
                let part = &mut parts[osc][shape as usize][..frames];
                fill(share, part);
                if taken_heard {
                    part.iter_mut()
                        .zip(&taken)
                        .for_each(|(part, taken)| *part *= taken);
                    heard[osc][shape as usize] = true;
                }
            }
            oscillator.tune(&mut ratios[osc][..frames]);
        }
        let sounding = heard.map(|shapes| shapes.contains(&true));
        for voice in voices.iter_mut() {
            for (frame, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
                let Some(level) = envelope.next(&mut voice.contour, frame) else {
                    *voice = FREE;
                    break;
                };
                let mut wave = 0.0;
                let each = (voice.phases.iter_mut().zip(&mut voice.noises))
                    .zip(parts.iter().zip(&*heard).zip(&sounding).zip(&*ratios));
                for ((phase, noise), (((parts, heard), &sounding), ratios)) in each {
                    let increment = voice.increment * ratios[frame];
                    // On by this sample's own increment, heard or not: a change of pitch is heard from its frame, and
                    // an oscillator mixed in later is where the note's time has taken it.
                    *phase = (*phase + increment).fract();
                    // A voice at none, such as one waiting out its delay, would only multiply its wave by 0.
                    if !sounding || level == 0.0 {
                        continue;
                    }
                    let pitched = below_half_the_sample_rate(increment);
                    for ((shape, parts), &heard) in Shape::ALL.into_iter().zip(parts).zip(heard) {
                        if heard {
                            let sample = match shape {
                                Shape::Noise => noise.next(),
                                _ => pitched * shape.wave(*phase, increment, noise),
                            };
                            wave += parts[frame] * sample;
                        }
                    }
                }
                let sample = wave * level * voice.gain;
                *l += sample;
                *r += sample;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_1_SQRT_2;

    use crate::envelope::GIVE_WAY_SECONDS;
    use crate::smoothing::ramp_samples;
    use crate::testing::{SAMPLE_RATE, first_block, largest_step, peak, render, rms, silence};

    const A4: u8 = 69;

    /// The default release's length.
    fn release() -> usize {
        let release = DESCRIPTION.param(ENVELOPE.release).unwrap();
        ramp_samples(release.default, SAMPLE_RATE) as usize
    }

    /// Named by its key.
    fn on(time: u32, key: u8) -> Event {
        named(time, key, u32::from(key), 1.0)
    }

    fn named(time: u32, key: u8, note: u32, velocity: f32) -> Event {
        Event::NoteOn {
            time,
            key,
            velocity,
            note,
        }
    }

    fn off(time: u32, note: u32) -> Event {
        Event::NoteOff { time, note }
    }

    const A: u32 = A4 as u32;

    const SHAPE: u32 = OSCILLATOR_PARAMS[0].shape;

    fn choose(shape: Shape) -> Event {
        Event::param_at_start(SHAPE, shape as usize as f32)
    }

    /// A new synth's sound, `parts` one after another: so many samples each, its events in its first block; it starts
    /// with its default shape.
    fn play_parts(parts: &[(&[Event], usize)]) -> Vec<f32> {
        play_shaped(Shape::ALL[PARAMS[0].default as usize], parts)
    }

    fn play_shaped(shape: Shape, parts: &[(&[Event], usize)]) -> Vec<f32> {
        play_set(&[(SHAPE, shape as usize as f32)], parts)
    }

    /// As `play_parts`, starting with `values` over the defaults.
    fn play_set(values: &[(u32, f32)], parts: &[(&[Event], usize)]) -> Vec<f32> {
        let mut synth = create(SAMPLE_RATE);
        let mut sound = Vec::new();
        for (i, &(notes, samples)) in parts.iter().enumerate() {
            let mut events = match i {
                0 => first_block(&DESCRIPTION, values),
                _ => Vec::new(),
            };
            events.extend_from_slice(notes);
            let [left, right] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(samples));
            assert_eq!(left, right);
            sound.extend(left);
        }
        sound
    }

    fn play(notes: &[Event], samples: usize) -> Vec<f32> {
        play_parts(&[(notes, samples)])
    }

    /// The largest difference between the two over `range`.
    fn difference(a: &[f32], b: &[f32], range: std::ops::Range<usize>) -> f32 {
        a[range.clone()]
            .iter()
            .zip(&b[range])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max)
    }

    fn rising_crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count()
    }

    #[test]
    fn is_silent_until_a_note() {
        assert_eq!(peak(&play(&[], 1000)), 0.0);
    }

    #[test]
    fn plays_the_key_s_pitch_at_its_velocity() {
        let second = play(&[on(0, A4)], SAMPLE_RATE as usize);
        // The sawtooth rises through zero once a period.
        assert!((439..=441).contains(&rising_crossings(&second)));
        let level = peak(&second);
        assert!((level - VOICE_GAIN).abs() < 0.02, "peak {level}");
        let quiet = named(0, A4, 1, 0.5);
        let half = peak(&play(&[quiet], SAMPLE_RATE as usize / 10));
        assert!((half - VOICE_GAIN / 2.0).abs() < 0.01, "peak {half}");
        assert_eq!(frequency(A4 + 12), 880.0);
    }

    #[test]
    fn rises_without_a_click() {
        // Short of the sawtooth's first jump, at sample 109.
        let start = play(&[on(0, A4)], 100);
        // A step of the attack up, a step of the wave on.
        assert!(start[0].abs() < 0.01 * VOICE_GAIN, "{}", start[0]);
        // Without the attack the first samples would jump by the sawtooth's full depth.
        assert!(largest_step(&start) < 0.05 * VOICE_GAIN);
    }

    #[test]
    fn holds_until_let_go_of_then_falls_silent_over_its_release() {
        let release = release();
        let held = 2000;
        let sound = play_parts(&[(&[on(0, A4)], held), (&[off(0, A)], 3 * release)]);
        assert!(peak(&sound[held - 200..held]) > 0.9 * VOICE_GAIN);
        // Half way through the release, 40 dB down, as it falls evenly in decibels to 80 down; over a period up to it.
        let middle = held + release / 2;
        let half_way = 20.0 * (peak(&sound[middle - 110..middle]) / VOICE_GAIN).log10();
        assert!((-41.0..-37.5).contains(&half_way), "{half_way} dB");
        assert!(peak(&sound[held + release - 100..held + release - 1]) > 0.0);
        assert_eq!(peak(&sound[held + release - 1..]), 0.0);
    }

    #[test]
    fn letting_go_of_a_note_lets_go_of_it_and_no_other_even_of_its_key() {
        let release = release();
        let tail = 2 * release;
        let alone = play(&[on(0, A4), on(0, A4 + 7)], 3 * release);
        let both = play(&[on(0, A4), on(0, A4 + 7), off(0, A)], 3 * release);
        // The fifth goes on as it was.
        let fifth = play(&[on(0, A4 + 7)], 3 * release);
        assert!(peak(&alone[tail..]) > 1.5 * VOICE_GAIN);
        assert!((peak(&both[tail..]) - peak(&fifth[tail..])).abs() < 1e-6);
        // Of a loud and a quiet note of one key, the quiet one let go of leaves the loud one.
        let loud = named(0, A4, 1, 1.0);
        let quiet = named(0, A4, 2, 0.5);
        let left = play(&[loud, quiet, off(0, 2)], 3 * release);
        assert!((peak(&left[tail..]) - VOICE_GAIN).abs() < 0.02);
        let none = play(&[loud, quiet, off(0, 2), off(0, 1)], 3 * release);
        assert_eq!(peak(&none[tail..]), 0.0);
    }

    #[test]
    fn a_note_let_go_of_as_it_is_pressed_is_not_left_held() {
        assert_eq!(peak(&play(&[on(0, A4), off(0, A)], 1000)), 0.0);
    }

    #[test]
    fn a_silent_note_or_a_key_not_held_changes_nothing() {
        let silent = named(0, A4, 1, 0.0);
        assert_eq!(peak(&play(&[silent], 1000)), 0.0);
        let held = play(&[on(0, A4)], 1000);
        assert_eq!(play(&[on(0, A4), off(0, A + 1)], 1000), held);
    }

    #[test]
    fn a_note_past_the_voices_makes_the_oldest_give_way() {
        let chord: Vec<_> = (0..VOICES as u8).map(|i| on(0, 40 + i)).collect();
        let extra = [on(0, 90)];
        let over = play_parts(&[(&chord, 1000), (&extra, 4000)]);
        // What is left once the oldest is gone: fifteen of the sixteen and the extra note.
        let rest = play_parts(&[(&chord[1..], 1000), (&extra, 4000)]);
        let give_way = ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize;
        // Up to half way, the oldest is still fading rather than gone at once: its low sawtooth needs that long to
        // show its depth. Past its fade, it is gone.
        assert!(difference(&over, &rest, 1000..1000 + give_way / 2) > 0.25 * VOICE_GAIN);
        assert!(difference(&over, &rest, 1000 + give_way + 1..over.len()) < 1e-5);
    }

    /// The sound of `parts`, then of the same with `extra` pressed at the start of the last: past the fade of the voice
    /// that gave way to it, how much it changed the sound.
    fn traded_for(values: &[(u32, f32)], parts: &[(&[Event], usize)], extra: &[Event]) -> Vec<f32> {
        let without = play_set(values, parts);
        let (last, before) = parts.split_last().unwrap();
        let pressed: Vec<_> = last.0.iter().chain(extra).copied().collect();
        let with: Vec<_> = before
            .iter()
            .copied()
            .chain([(&pressed[..], last.1)])
            .collect();
        let over = play_set(values, &with);
        let past =
            without.len() - last.1 + ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize + 1;
        over.iter()
            .zip(&without)
            .skip(past)
            .map(|(a, b)| a - b)
            .collect()
    }

    /// The sound of a note alone, as `traded_for` takes it, past the same fade: so many samples silent, then the note's
    /// own `parts`.
    fn alone_past_the_fade(
        values: &[(u32, f32)],
        parts: &[(&[Event], usize)],
        extra_at: usize,
    ) -> Vec<f32> {
        let past = extra_at + ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize + 1;
        play_set(values, parts).split_off(past)
    }

    fn minus(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(a, b)| a - b).collect()
    }

    const EXTRA: Event = Event::NoteOn {
        time: 0,
        key: 100,
        velocity: 1.0,
        note: 100,
    };

    #[test]
    fn a_tail_gives_way_before_a_note_held_however_old() {
        // The oldest held, then one let go of with a long release, then fourteen more held: sixteen sounding.
        let long = [(ENVELOPE.release, 10.0)];
        let first = [on(0, 40), on(0, 90)];
        let more: Vec<_> = [off(0, 90)]
            .into_iter()
            .chain((41..55).map(|key| on(0, key)))
            .collect();
        let traded = traded_for(
            &long,
            &[(&first, 1000), (&more, 1000), (&[], 4000)],
            &[EXTRA],
        );
        // The extra note heard in place of the tail.
        let tail = alone_past_the_fade(&long, &[(&[on(0, 90)], 1000), (&[off(0, 90)], 5000)], 2000);
        let extra = alone_past_the_fade(&long, &[(&[], 2000), (&[EXTRA], 4000)], 2000);
        let differs = difference(&traded, &minus(&extra, &tail), 0..traded.len());
        assert!(differs < 1e-5, "{differs}");
    }

    #[test]
    fn of_tails_the_quietest_gives_way_whichever_was_pressed_first() {
        let values = [(ENVELOPE.release, 1.0)];
        // Pressed first and let go of last, the loud one; the other well on its way down.
        let (loud, quiet) = (on(0, 90), on(0, 95));
        let first = [on(0, 40), loud, quiet];
        let more: Vec<_> = [off(0, 90)]
            .into_iter()
            .chain((41..54).map(|key| on(0, key)))
            .collect();
        let parts: [(&[Event], usize); 4] = [
            (&first, 1000),
            (&[off(0, 95)], 2000),
            (&more, 1000),
            (&[], 4000),
        ];
        let traded = traded_for(&values, &parts, &[EXTRA]);
        let quiet_alone = [(&[quiet][..], 1000), (&[off(0, 95)], 7000)];
        let quiet = alone_past_the_fade(&values, &quiet_alone, 4000);
        let extra = alone_past_the_fade(&values, &[(&[], 4000), (&[EXTRA], 4000)], 4000);
        let differs = difference(&traded, &minus(&extra, &quiet), 0..traded.len());
        assert!(differs < 1e-5, "{differs}");
    }

    #[test]
    fn a_note_held_fallen_silent_gives_way_before_a_tail() {
        let values = [
            (ENVELOPE.sustain, 0.0),
            (ENVELOPE.decay, 0.05),
            (ENVELOPE.release, 10.0),
        ];
        // Sixteen held; one let go of half way down its decay, still heard as the others fall silent.
        let chord: Vec<_> = (40..56).map(|key| on(0, key)).collect();
        let parts: [(&[Event], usize); 3] = [(&chord, 1000), (&[off(0, 40)], 3000), (&[], 4000)];
        let traded = traded_for(&values, &parts, &[EXTRA]);
        // The extra note heard, and nothing gone.
        let extra = alone_past_the_fade(&values, &[(&[], 4000), (&[EXTRA], 4000)], 4000);
        let differs = difference(&traded, &extra, 0..traded.len());
        assert!(differs < 1e-5, "{differs}");
    }

    #[test]
    fn a_held_note_falls_over_the_decay_to_the_sustain_level() {
        let values = [(ENVELOPE.sustain, 0.5), (ENVELOPE.decay, 0.1)];
        let sound = play_set(&values, &[(&[on(0, A4)], SAMPLE_RATE as usize / 2)]);
        assert!(peak(&sound[150..300]) > 0.95 * VOICE_GAIN);
        let held = peak(&sound[SAMPLE_RATE as usize / 4..]);
        assert!(
            (held - 0.5 * VOICE_GAIN).abs() < 0.01 * VOICE_GAIN,
            "{held}"
        );
    }

    #[test]
    fn each_note_goes_through_the_envelope_from_its_own_press() {
        let values = [
            (ENVELOPE.attack, 0.05),
            (ENVELOPE.sustain, 0.5),
            (ENVELOPE.decay, 0.1),
        ];
        let later = SAMPLE_RATE as usize / 5;
        let both = play_set(&values, &[(&[on(0, A4)], later), (&[on(0, A4 + 7)], later)]);
        let first = play_set(&values, &[(&[on(0, A4)], 2 * later)]);
        let second = play_set(&values, &[(&[], later), (&[on(0, A4 + 7)], later)]);
        let sum: Vec<f32> = first.iter().zip(&second).map(|(a, b)| a + b).collect();
        let differs = difference(&both, &sum, 0..both.len());
        assert!(differs < 1e-6, "{differs}");
    }

    #[test]
    fn a_note_that_gave_way_is_let_go_of_without_touching_the_one_it_gave_way_to() {
        let chord: Vec<_> = (0..VOICES as u8).map(|i| on(0, 40 + i)).collect();
        // Key 40 again, as another note: the first 40 gives way to it.
        let again = [named(0, 40, 99, 1.0)];
        let held = play_parts(&[(&chord, 1000), (&again, 1000), (&[], 2000)]);
        let let_go = play_parts(&[(&chord, 1000), (&again, 1000), (&[off(0, 40)], 2000)]);
        assert_eq!(held, let_go);
    }

    #[test]
    fn a_pitched_wave_fades_out_below_half_the_sample_rate_and_is_silent_from_it() {
        let sample_rate = 8000.0;
        let level = |shape: Shape, key| {
            let mut synth = create(sample_rate);
            let mut events = first_block(&DESCRIPTION, &[(SHAPE, shape as usize as f32)]);
            events.push(on(0, key));
            let [left, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(4000));
            peak(&left)
        };
        // No key runs past full level; from 4 kHz up, only noise sounds, which has no pitch to alias by.
        for shape in Shape::ALL {
            for key in 0..=127 {
                let level = level(shape, key);
                assert!(level <= 1.1 * VOICE_GAIN, "{shape:?} {key}: {level}");
                let silent = shape != Shape::Noise && frequency(key) >= sample_rate / 2.0;
                assert_eq!(level == 0.0, silent, "{shape:?} {key}: {level}");
            }
        }
        // Over the half octave below it, each key quieter than the one before.
        let fading: Vec<_> = (0..=127u8)
            .filter(|&key| {
                (sample_rate / 2.0 * FRAC_1_SQRT_2..sample_rate / 2.0).contains(&frequency(key))
            })
            .map(|key| level(Shape::Sine, key))
            .collect();
        assert!(fading.len() >= 5, "{fading:?}");
        assert!(fading[0] < VOICE_GAIN, "{fading:?}");
        assert!(
            fading.windows(2).all(|pair| pair[1] < pair[0]),
            "{fading:?}"
        );
    }

    #[test]
    fn shapes_are_kept_by_their_place_and_a_new_synth_plays_a_saw() {
        for (place, shape) in Shape::ALL.into_iter().enumerate() {
            assert_eq!(shape as usize, place);
        }
        assert_eq!(Shape::ALL[PARAMS[0].default as usize], Shape::Saw);
    }

    #[test]
    fn every_shape_but_noise_plays_the_key_s_pitch_at_full_level() {
        for shape in [Shape::Sine, Shape::Triangle, Shape::Square, Shape::Saw] {
            let second = play_shaped(shape, &[(&[on(0, A4)], SAMPLE_RATE as usize)]);
            let crossings = rising_crossings(&second);
            assert!((439..=441).contains(&crossings), "{shape:?}: {crossings}");
            let level = peak(&second);
            assert!(
                (level - VOICE_GAIN).abs() < 0.03 * VOICE_GAIN,
                "{shape:?}: peak {level}"
            );
        }
    }

    #[test]
    fn noise_has_no_pitch_and_each_note_its_own() {
        let one = play_shaped(Shape::Noise, &[(&[on(0, A4)], SAMPLE_RATE as usize)]);
        // White: it rises through zero about once in four samples, whatever the key.
        let crossings = rising_crossings(&one);
        assert!((11_000..13_000).contains(&crossings), "{crossings}");
        let level = peak(&one);
        assert!(
            level <= VOICE_GAIN && level > 0.95 * VOICE_GAIN,
            "peak {level}"
        );
        // Two notes of the same noise would be twice as loud; of their own, √2.
        let two = play_shaped(
            Shape::Noise,
            &[(&[on(0, A4), on(0, A4 + 12)], SAMPLE_RATE as usize)],
        );
        let louder = rms(&two) / rms(&one);
        assert!((1.3..1.55).contains(&louder), "{louder}");
    }

    #[test]
    fn two_synths_layered_on_the_same_steps_play_noises_of_their_own() {
        // The engine names each note of a pattern anew, whichever node plays it.
        let noise = |note| play_shaped(Shape::Noise, &[(&[named(0, A4, note, 1.0)], 4800)]);
        assert_eq!(noise(1), noise(1));
        let (one, other) = (noise(1), noise(2));
        let together: Vec<f32> = one.iter().zip(&other).map(|(a, b)| a + b).collect();
        // Twice as loud if they were one noise; √2 as two.
        let louder = rms(&together) / rms(&one);
        assert!((1.3..1.55).contains(&louder), "{louder}");
    }

    #[test]
    fn a_shape_chosen_while_a_note_sounds_takes_over_over_its_smoothing() {
        let ramp = ramp_samples(PARAMS[0].smoothing_seconds, SAMPLE_RATE) as usize;
        let (before, after) = (10 * BLOCK_FRAMES, 3 * ramp);
        let note: &[Event] = &[on(0, A4)];
        let changed = play_shaped(
            Shape::Saw,
            &[(note, before), (&[choose(Shape::Square)], after)],
        );
        let saw = play_shaped(Shape::Saw, &[(note, before + after)]);
        let square = play_shaped(Shape::Square, &[(note, before + after)]);
        assert_eq!(changed[..before], saw[..before]);
        // Half way, half of each; then the square alone, the note going on.
        let middle = before + ramp / 2;
        let half: Vec<f32> = saw
            .iter()
            .zip(&square)
            .map(|(a, b)| (a + b) / 2.0)
            .collect();
        assert!(difference(&changed, &half, middle - 2..middle + 2) < 1e-3);
        assert!(difference(&changed, &square, before + ramp..before + after) < 1e-6);
    }

    #[test]
    fn a_shape_chosen_as_another_takes_over_glides_on_from_where_they_stand() {
        let ramp = ramp_samples(PARAMS[0].smoothing_seconds, SAMPLE_RATE) as usize;
        let note: &[Event] = &[on(0, A4)];
        let length = 10 * BLOCK_FRAMES + 4 * ramp;
        let back = play_shaped(
            Shape::Sine,
            &[
                (note, 10 * BLOCK_FRAMES),
                (&[choose(Shape::Triangle)], ramp / 2),
                (&[choose(Shape::Sine)], 3 * ramp + ramp / 2),
            ],
        );
        let own = |shape| largest_step(&play_shaped(shape, &[(note, length)]));
        // Starting the way back from the sine alone, or from the triangle, would jump by a share of their difference.
        let limit = own(Shape::Sine).max(own(Shape::Triangle)) + 1e-6;
        let step = largest_step(&back);
        assert!(step <= limit, "step {step} > {limit}");
    }

    /// How loud the sound is at `frequency`, windowed so louder neighbours don't leak in.
    fn level_at(sound: &[f32], frequency: f64) -> f64 {
        use std::f64::consts::TAU;
        let length = sound.len() as f64;
        let turn = TAU * frequency / f64::from(SAMPLE_RATE);
        let (re, im) = sound
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(re, im), (i, &sample)| {
                let i = i as f64;
                let hann = 0.5 - 0.5 * (TAU * i / length).cos();
                let x = f64::from(sample) * hann;
                (re + x * (turn * i).cos(), im - x * (turn * i).sin())
            });
        re.hypot(im) / length
    }

    #[test]
    fn a_high_note_aliases_far_less_than_the_bare_wave() {
        type Bare = fn(f32) -> f32;
        let key = 100;
        let increment = frequency(key) / SAMPLE_RATE;
        let note = f64::from(frequency(key));
        let rate = f64::from(SAMPLE_RATE);
        // Each with its jumps and corners as they are, and whether it has only odd harmonics.
        let shapes: [(Shape, Bare, bool); 3] = [
            (Shape::Saw, |phase| 2.0 * phase - 1.0, false),
            (
                Shape::Square,
                |phase| if phase < 0.5 { 1.0 } else { -1.0 },
                true,
            ),
            (
                Shape::Triangle,
                |phase| 1.0 - 4.0 * ((phase + 0.25).fract() - 0.5).abs(),
                true,
            ),
        ];
        for (shape, bare, odd_only) in shapes {
            let second = SAMPLE_RATE as usize;
            let played = play_shaped(shape, &[(&[on(0, key)], second)]);
            let bare: Vec<f32> = (0..second)
                .scan(0.0f32, |phase, _| {
                    let sample = VOICE_GAIN * bare(*phase);
                    *phase = (*phase + increment).fract();
                    Some(sample)
                })
                .collect();
            // Harmonics between half the sample rate and the rate fold back under the half, clear of the note's own.
            #[expect(
                clippy::maybe_infinite_iter,
                reason = "the harmonics rise past the rate"
            )]
            let folded: Vec<f64> = (1..)
                .map(|harmonic| f64::from(harmonic) * note)
                .take_while(|&above| above < rate)
                .enumerate()
                .filter(|&(i, above)| above > rate / 2.0 && (!odd_only || i % 2 == 0))
                .map(|(_, above)| rate - above)
                .collect();
            let aliased = |sound: &[f32]| folded.iter().map(|&at| level_at(sound, at)).sum::<f64>();
            let (played, bare) = (aliased(&played), aliased(&bare));
            assert!(played < bare / 4.0, "{shape:?}: {played} against {bare}");
        }
    }

    const OSC1: OscillatorParams = OSCILLATOR_PARAMS[0];
    const OSC2: OscillatorParams = OSCILLATOR_PARAMS[1];
    const OSC3: OscillatorParams = OSCILLATOR_PARAMS[2];

    const SINE: f32 = Shape::Sine as usize as f32;

    /// A second of A4.
    fn a_second(values: &[(u32, f32)]) -> Vec<f32> {
        play_set(values, &[(&[on(0, A4)], SAMPLE_RATE as usize)])
    }

    /// The values that leave the oscillator heard alone, a sine: its mix whole, and those after it at none, as new.
    fn alone(osc: OscillatorParams) -> Vec<(u32, f32)> {
        let mut values = vec![(osc.shape, SINE)];
        values.extend(osc.mix.map(|mix| (mix, 1.0)));
        values
    }

    /// Where the sound rises through 0, between samples.
    fn rising_at(samples: &[f32]) -> Vec<f64> {
        let rising = samples.windows(2).enumerate();
        rising
            .filter(|(_, pair)| pair[0] < 0.0 && pair[1] >= 0.0)
            .map(|(i, pair)| i as f64 + f64::from(pair[0] / (pair[0] - pair[1])))
            .collect()
    }

    #[test]
    fn every_parameter_is_one_oscillator_s_or_the_envelope_s_and_in_its_group() {
        for (number, param) in DESCRIPTION.numbered_params() {
            let oscillators = (OSCILLATOR_PARAMS.iter().zip(["Osc 1", "Osc 2", "Osc 3"]))
                .filter(|(osc, _)| {
                    [Some(osc.shape), Some(osc.coarse), Some(osc.fine), osc.mix]
                        .contains(&Some(number))
                })
                .map(|(_, group)| group);
            let envelope = ENVELOPE.all().contains(&number).then_some(envelope::GROUP);
            let owners: Vec<_> = oscillators.chain(envelope).collect();
            assert_eq!(owners.len(), 1, "{:?}", param.id);
            assert_eq!(param.group, Some(owners[0]), "{:?}", param.id);
        }
    }

    #[test]
    fn a_new_synth_plays_osc_1_alone_with_osc_2_an_octave_down_and_osc_3_two() {
        let coarse = OSCILLATOR_PARAMS.map(|osc| DESCRIPTION.param(osc.coarse).unwrap().default);
        assert_eq!(coarse, [0.0, -12.0, -24.0]);
        // Their mixes at none, Osc 2's and Osc 3's own settings change nothing.
        let others =
            [OSC2, OSC3].map(|osc| [(osc.shape, SINE), (osc.coarse, 7.0), (osc.fine, 30.0)]);
        assert_eq!(a_second(others.as_flattened()), a_second(&[]));
    }

    #[test]
    fn each_oscillator_plays_its_shape_at_the_key_s_pitch_moved_by_its_tuning() {
        for (place, osc) in OSCILLATOR_PARAMS.into_iter().enumerate() {
            for (coarse, fine) in [
                (0.0, 0.0),
                (12.0, 0.0),
                (-12.0, 0.0),
                (7.0, -50.0),
                (-1.0, 100.0),
            ] {
                let mut values = alone(osc);
                values.extend([(osc.coarse, coarse), (osc.fine, fine)]);
                let second = a_second(&values);
                let at = format!("osc {} at {coarse} st {fine} ct", place + 1);
                let pitch = 440.0 * ((coarse + fine / 100.0) / 12.0).exp2();
                let crossings = rising_crossings(&second) as f32;
                assert!(
                    (crossings - pitch).abs() <= 1.5,
                    "{at}: {crossings} for {pitch}"
                );
                let level = peak(&second);
                assert!(
                    (level - VOICE_GAIN).abs() < 0.01 * VOICE_GAIN,
                    "{at}: peak {level}"
                );
            }
        }
    }

    #[test]
    fn a_mix_takes_its_share_from_the_oscillators_before_as_in_fl() {
        // Sines octaves apart, each heard at its own pitch: Osc 2 at a half and Osc 3 at a third share alike.
        let sines = OSCILLATOR_PARAMS.map(|osc| (osc.shape, SINE));
        let mixes = [(OSC2.mix.unwrap(), 0.5), (OSC3.mix.unwrap(), 1.0 / 3.0)];
        let mixed = a_second(&[sines.as_slice(), &mixes].concat());
        let alone = a_second(&sines);
        let level = |sound: &[f32], pitch| level_at(&sound[4800..], pitch);
        for pitch in [440.0, 220.0, 110.0] {
            let share = level(&mixed, pitch) / level(&alone, 440.0);
            assert!((share - 1.0 / 3.0).abs() < 0.01, "{pitch} Hz: {share}");
        }
    }

    #[test]
    fn three_oscillators_mixed_are_no_louder_than_one() {
        // The same wave in each, so the mix comes back to it.
        let mut values: Vec<_> = OSCILLATOR_PARAMS
            .iter()
            .map(|osc| (osc.coarse, 0.0))
            .collect();
        values.extend([(OSC2.mix.unwrap(), 0.5), (OSC3.mix.unwrap(), 0.3)]);
        let (mixed, plain) = (a_second(&values), a_second(&[]));
        let differs = difference(&mixed, &plain, 0..plain.len());
        assert!(differs < 1e-6, "{differs}");
    }

    #[test]
    fn an_oscillator_past_half_the_sample_rate_is_silent_and_the_others_sound() {
        let sample_rate = 8000.0;
        // 1047 Hz, and two octaves up past 4 kHz.
        let key = 84;
        let sound = |values: &[(u32, f32)]| {
            let mut synth = create(sample_rate);
            let mut events = first_block(&DESCRIPTION, values);
            events.push(on(0, key));
            let [left, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(4000));
            left
        };
        let plain = sound(&[]);
        let half_past = sound(&[(OSC2.coarse, 24.0), (OSC2.mix.unwrap(), 0.5)]);
        assert!(peak(&plain) > 0.5 * VOICE_GAIN);
        // Osc 1 at half its level, Osc 2 nothing.
        let halved: Vec<_> = plain.iter().map(|sample| 0.5 * sample).collect();
        let differs = difference(&half_past, &halved, 0..plain.len());
        assert!(differs < 1e-6, "{differs}");
    }

    #[test]
    fn each_oscillator_s_noise_is_its_own() {
        let noise = Shape::Noise as usize as f32;
        let one = a_second(&[(OSC1.shape, noise)]);
        let two = a_second(&[
            (OSC1.shape, noise),
            (OSC2.shape, noise),
            (OSC2.mix.unwrap(), 0.5),
        ]);
        // Halves of two noises add up to less than a whole one: by a square root of two.
        let ratio = rms(&two) / rms(&one);
        assert!((ratio - FRAC_1_SQRT_2).abs() < 0.02, "{ratio}");
    }

    #[test]
    fn coarse_moves_a_sounding_note_at_once_and_fine_glides_over_its_smoothing() {
        let turn = SAMPLE_RATE as usize / 10;
        let period = f64::from(SAMPLE_RATE) / 440.0;
        // The first period wholly after the turn, and the last one.
        let turned = |param, value| {
            let to = [Event::param_at_start(param, value)];
            let sound = play_set(&[(SHAPE, SINE)], &[(&[on(0, A4)], turn), (&to, turn)]);
            let at = rising_at(&sound);
            let first = at.iter().position(|&at| at > turn as f64).unwrap();
            (
                at[first + 1] - at[first],
                at[at.len() - 1] - at[at.len() - 2],
            )
        };
        let (first, last) = turned(OSC1.coarse, 12.0);
        assert!(
            (first - period / 2.0).abs() < 0.1,
            "an octave up at once: {first}"
        );
        assert!((last - period / 2.0).abs() < 0.1, "{last}");
        let up = period / 2f64.powf(1.0 / 12.0);
        let (first, last) = turned(OSC1.fine, 100.0);
        assert!(
            first > f64::midpoint(period, up),
            "a semitone up from where it stood: {first}"
        );
        assert!((last - up).abs() < 0.1, "{last} for {up}");
    }

    #[test]
    fn a_coarse_turn_on_a_sounding_note_does_not_click() {
        let turn = 90 * BLOCK_FRAMES;
        for shape in [Shape::Sine, Shape::Triangle, Shape::Square, Shape::Saw] {
            for (from, to) in [(-24.0, 24.0), (24.0, -24.0)] {
                let at = |coarse| [(SHAPE, shape as usize as f32), (OSC1.coarse, coarse)];
                let steady = |coarse| largest_step(&a_second(&at(coarse)));
                // No step past the wave's own at either pitch.
                let limit = steady(from).max(steady(to)) + 1e-6;
                let to = [Event::param_at_start(OSC1.coarse, to)];
                let turned = play_set(&at(from), &[(&[on(0, A4)], turn), (&to, turn)]);
                let step = largest_step(&turned);
                assert!(
                    step <= limit,
                    "{shape:?} {from} → {to:?}: step {step} > {limit}"
                );
            }
        }
    }

    #[test]
    fn an_oscillator_mixed_in_during_a_note_is_where_the_note_s_time_has_taken_it() {
        // Osc 2 as Osc 1, so mixed in it changes nothing, unless it starts from where it was left.
        let alike = [(OSC2.coarse, 0.0), (OSC2.shape, PARAMS[0].default)];
        let mixed_in = [Event::param_at_start(OSC2.mix.unwrap(), 0.5)];
        let late = SAMPLE_RATE as usize / 10 + 37;
        let mixed = play_set(&alike, &[(&[on(0, A4)], late), (&mixed_in, late)]);
        let alone = play_set(&alike, &[(&[on(0, A4)], late), (&[], late)]);
        let differs = difference(&mixed, &alone, 0..alone.len());
        assert!(differs < 1e-6, "{differs}");
    }

    #[test]
    fn a_note_too_high_to_sound_still_takes_a_voice_its_oscillator_may_be_tuned_down_to() {
        let sample_rate = 8000.0;
        // 4186 Hz, past 4 kHz.
        let key = 108;
        let mut synth = create(sample_rate);
        let mut events = first_block(&DESCRIPTION, &[(SHAPE, SINE)]);
        events.push(on(0, key));
        let [high, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(1000));
        assert_eq!(peak(&high), 0.0);
        let down = [Event::param_at_start(OSC1.coarse, -12.0)];
        let [tuned, _] = render(&DESCRIPTION, synth.as_mut(), &down, &silence(1000));
        assert!(peak(&tuned) > 0.9 * VOICE_GAIN, "{}", peak(&tuned));
    }
}
