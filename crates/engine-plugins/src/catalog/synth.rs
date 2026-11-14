//! A synthesizer of three oscillators, each a wave of its chosen shape at the note's pitch moved by its own tuning, Osc
//! 2 and Osc 3 each taking its mix's share of the sound from those before it. Each note's level follows the envelope
//! from its press. Notes overlap, each in a voice of its own.

use std::f32::consts::TAU;

use crate::description::listed;
use crate::envelope::{self, Contour, Envelope};
use crate::smoothing::Smoothed;
use crate::voices::{self, Level, Standing, Voices};
use crate::{
    BLOCK_FRAMES, Choice, Event, NoteId, ParamDescription, ParamNumber, Plugin, PluginDescription,
    ProcessContext, SampleRate, Scale, Step, Unit, Values, steps,
};

listed! {
    /// From the smoothest to the brightest. Projects keep them by place.
    pub enum Shape {
        Sine,
        Triangle,
        Square,
        Saw,
        Noise,
    }
}

impl Shape {
    /// As its parameter's value.
    const fn value(self) -> f32 {
        Choice::value(self as usize)
    }

    /// The shape a value of its parameter names; none past the last.
    fn of(value: f32) -> Option<Self> {
        Self::ALL.get(Choice::place(value)).copied()
    }

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

    /// At `phase`, of the period, within -1 to 1: a pitched wave times `pitched`, as [`below_half_the_sample_rate`]
    /// has it; noise, which has no pitch to alias, whole.
    fn wave(self, phase: f32, increment: f32, pitched: f32, noise: &mut Noise) -> f32 {
        let wave = match self {
            Self::Sine => (TAU * phase).sin(),
            Self::Triangle => triangle(phase, increment),
            Self::Square => square(phase, increment),
            Self::Saw => saw(phase, increment),
            Self::Noise => return noise.next(),
        };
        pitched * wave
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

/// Every oscillator's, until a knob turns.
const DEFAULT_SHAPE: Shape = Shape::Saw;

const fn shape(id: &'static str, group: &'static str) -> ParamDescription {
    ParamDescription {
        id,
        label: "Shape",
        group: Some(group),
        unit: None,
        scale: Scale::Linear,
        values: Values::Choices(&SHAPES),
        min: 0.0,
        max: Choice::value(SHAPES.len() - 1),
        default: DEFAULT_SHAPE.value(),
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
    pub shape: ParamNumber,
    pub coarse: ParamNumber,
    pub fine: ParamNumber,
    /// Osc 1 has none: it takes what the others leave.
    pub mix: Option<ParamNumber>,
}

impl OscillatorParams {
    const fn of(named: &Named) -> Self {
        Self {
            shape: ParamNumber::of(DESCRIPTION.params, named.shape),
            coarse: ParamNumber::of(DESCRIPTION.params, named.coarse),
            fine: ParamNumber::of(DESCRIPTION.params, named.fine),
            mix: match named.mix {
                Some(mix) => Some(ParamNumber::of(DESCRIPTION.params, mix)),
                None => None,
            },
        }
    }
}

pub const OSCILLATOR_PARAMS: [OscillatorParams; OSCILLATORS] = {
    let mut numbers = [OscillatorParams::of(&NAMED[0]); OSCILLATORS];
    let mut osc = 1;
    while osc < OSCILLATORS {
        numbers[osc] = OscillatorParams::of(&NAMED[osc]);
        osc += 1;
    }
    numbers
};

pub const ENVELOPE: envelope::Numbers = envelope::Numbers::of(&DESCRIPTION);

/// A voice's peak at full velocity: a sawtooth is loud, and chords add up.
pub const VOICE_GAIN: f32 = 0.2;

#[derive(Clone, Copy)]
struct Voice {
    /// Over once the voice is free.
    contour: Contour,
    /// The note it plays, as its `NoteOn` named it.
    note: NoteId,
    /// Each oscillator's, of its period, from 0 to 1.
    phases: [f32; OSCILLATORS],
    /// Of the key's period a sample moves on; an oscillator's tuning moves it.
    increment: f32,
    gain: f32,
    noises: [Noise; OSCILLATORS],
}

const FREE: Voice = Voice {
    contour: Contour::OVER,
    note: NoteId::new(0),
    phases: [0.0; OSCILLATORS],
    increment: 0.0,
    gain: 0.0,
    noises: [Noise(1); OSCILLATORS],
};

impl voices::Voice for Voice {
    /// One fallen silent while held first, then a tail, the quietest first, then one held, as a note on its way up or
    /// waiting out its delay is about to sound.
    type Room = (u8, Level);
    type Distance = Level;

    fn standing(&self) -> Standing<Self::Room, Self::Distance> {
        let contour = &self.contour;
        if self.is_free() {
            Standing::Free
        } else if contour.is_giving_way() {
            Standing::GivingWay(Level(contour.level()))
        } else {
            Standing::Playing(match (contour.has_fallen_silent(), contour.is_held()) {
                (true, _) => (0, Level(0.0)),
                (false, false) => (1, Level(contour.level())),
                (false, true) => (2, Level(0.0)),
            })
        }
    }

    fn is_free(&self) -> bool {
        self.contour.is_over()
    }

    fn give_way(&mut self, samples: u32) {
        self.contour.give_way(samples);
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
    fn new(params: OscillatorParams, sample_rate: SampleRate) -> Self {
        let param = |number: ParamNumber| number.entry(DESCRIPTION.params).expect("its own");
        let chosen = DEFAULT_SHAPE;
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
                None => Smoothed::over(1.0, 1),
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

/// A value for each of a block's frames.
type Signal = [f32; BLOCK_FRAMES];

struct Synth {
    voices: Voices<Voice>,
    oscillators: [Oscillator; OSCILLATORS],
    /// For each oscillator over the block: each shape's part of the sound, and whether it is heard.
    parts: [[Signal; Shape::ALL.len()]; OSCILLATORS],
    heard: [[bool; Shape::ALL.len()]; OSCILLATORS],
    /// For each oscillator over the block: as `Oscillator::tune` has it.
    ratios: [Signal; OSCILLATORS],
    sample_rate: SampleRate,
    envelope: Envelope,
}

pub(crate) fn create(sample_rate: SampleRate) -> Box<dyn Plugin> {
    Box::new(Synth::new(sample_rate))
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
    fn of(note: NoteId, oscillator: usize) -> Self {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "one of the synth's three oscillators"
        )]
        let oscillator = oscillator as u32;
        let mut x = note.get() ^ 0x2545_f491 ^ oscillator.wrapping_mul(0x9e37_79b9);
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
    fn new(sample_rate: SampleRate) -> Self {
        Self {
            voices: Voices::new(FREE, sample_rate),
            oscillators: OSCILLATOR_PARAMS.map(|params| Oscillator::new(params, sample_rate)),
            parts: [[[0.0; BLOCK_FRAMES]; Shape::ALL.len()]; OSCILLATORS],
            heard: [[false; Shape::ALL.len()]; OSCILLATORS],
            ratios: [[1.0; BLOCK_FRAMES]; OSCILLATORS],
            sample_rate,
            envelope: Envelope::new(ENVELOPE, sample_rate),
        }
    }

    fn set(&mut self, param: ParamNumber, value: f32) {
        for (oscillator, params) in self.oscillators.iter_mut().zip(OSCILLATOR_PARAMS) {
            if param == params.shape {
                if let Some(shape) = Shape::of(value) {
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

    /// A note too high to sound still takes a voice: its oscillators may be tuned down while it is held.
    fn start(&mut self, key: u8, velocity: f32, note: NoteId) {
        let increment = frequency(key) / self.sample_rate.hz();
        self.voices.start(velocity, || Voice {
            contour: Contour::START,
            note,
            phases: [0.0; OSCILLATORS],
            increment,
            gain: VOICE_GAIN * velocity,
            noises: std::array::from_fn(|oscillator| Noise::of(note, oscillator)),
        });
    }

    /// A voice that gave way to another note no longer holds its own.
    fn let_go(&mut self, note: NoteId) {
        let held =
            (self.voices.in_use()).find(|voice| voice.contour.is_held() && voice.note == note);
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
            oscillator.mix.fill(&mut taken[..frames]);
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
                share.fill(part);
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
        for voice in voices.in_use() {
            for (frame, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
                let Some(level) = envelope.next(&mut voice.contour, frame) else {
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
                            wave += parts[frame] * shape.wave(*phase, increment, pitched, noise);
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
mod tests;
