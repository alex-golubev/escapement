//! A note's level over its life: silent over a delay, up over an attack, at the top over a hold, down over a decay to
//! the sustain level, there until let go of, then down to silence over a release. Each time is its own stretch's
//! length; the attack rises in a straight line, the decay and the release fall evenly in decibels. Each voice goes its
//! own way through it; the knobs are the instrument's.

use crate::smoothing::{Smoothed, ramp_samples};
use crate::{
    BLOCK_FRAMES, ParamDescription, ParamNumber, PluginDescription, SampleRate, Scale, Unit, Values,
};

/// Where a fall evenly in decibels ends, 80 dB down: it cuts to silence there, a step below the least a 16-bit sound
/// holds.
pub const FLOOR: f32 = 1e-4;

/// How near a level counts as there, so rounding over a long stretch adds no sample.
const HAIR: f64 = 1e-9;

/// How long a voice that gives way takes to fall silent, rather than one sample.
pub const GIVE_WAY_SECONDS: f32 = 0.02;

pub const GROUP: &str = "Envelope";

const fn time(id: &'static str, label: &'static str, min: f32, default: f32) -> ParamDescription {
    ParamDescription {
        id,
        label,
        group: Some(GROUP),
        unit: Some(Unit::Seconds),
        scale: Scale::Time,
        values: Values::Any,
        min,
        max: 10.0,
        default,
        // A turn takes the stretch a voice is in on from its frame.
        smoothing_seconds: 0.0,
    }
}

// A new note sounds short and without a click: at once, up in 3 ms, held at full level, down in 100 ms; its decay,
// unheard at full sustain, half a second. Even the shortest rise and falls don't click: a fall evenly in decibels over
// 10 ms starts no steeper than a straight rise over 1 ms.
const DELAY: ParamDescription = time("envelope.delay", "Delay", 0.0, 0.0);
const ATTACK: ParamDescription = time("envelope.attack", "Attack", 0.001, 0.003);
const HOLD: ParamDescription = time("envelope.hold", "Hold", 0.0, 0.0);
const DECAY: ParamDescription = time("envelope.decay", "Decay", 0.01, 0.5);
const SUSTAIN: ParamDescription = ParamDescription {
    id: "envelope.sustain",
    label: "Sustain",
    group: Some(GROUP),
    unit: Some(Unit::Percent),
    scale: Scale::Linear,
    values: Values::Any,
    min: 0.0,
    max: 1.0,
    default: 1.0,
    // How long a held note takes to reach a new level.
    smoothing_seconds: 0.02,
};
const RELEASE: ParamDescription = time("envelope.release", "Release", 0.01, 0.1);

/// In the order a note goes through them, for an instrument to list one after another.
pub const PARAMS: [ParamDescription; 6] = [DELAY, ATTACK, HOLD, DECAY, SUSTAIN, RELEASE];

/// The envelope's parameters by number in an instrument's description.
#[derive(Clone, Copy, Debug)]
pub struct Numbers {
    pub delay: ParamNumber,
    pub attack: ParamNumber,
    pub hold: ParamNumber,
    pub decay: ParamNumber,
    pub sustain: ParamNumber,
    pub release: ParamNumber,
}

impl Numbers {
    /// For an instrument's own constants: one that doesn't list [`PARAMS`] fails the build.
    #[must_use]
    pub const fn of(description: &PluginDescription) -> Self {
        Self {
            delay: ParamNumber::of(description.params, DELAY.id),
            attack: ParamNumber::of(description.params, ATTACK.id),
            hold: ParamNumber::of(description.params, HOLD.id),
            decay: ParamNumber::of(description.params, DECAY.id),
            sustain: ParamNumber::of(description.params, SUSTAIN.id),
            release: ParamNumber::of(description.params, RELEASE.id),
        }
    }

    #[must_use]
    pub const fn all(self) -> [ParamNumber; PARAMS.len()] {
        [
            self.delay,
            self.attack,
            self.hold,
            self.decay,
            self.sustain,
            self.release,
        ]
    }
}

/// Where a voice is in the envelope.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    /// Held, silent over the delay: so many samples so far.
    Waiting(u32),
    /// Held, up to full level.
    Rising,
    /// Held at full level over the hold: so many samples so far.
    Holding(u32),
    /// Held, down to the sustain level.
    Decaying,
    /// Held at the sustain level.
    Sustaining,
    /// Let go of, down from the level `from` to silence over the release: by `fall` a sample, as worked out for a
    /// release of `release` samples.
    Releasing { from: f64, fall: f64, release: f64 },
    /// Making room for another note: down to silence quickly, in a straight line.
    GivingWay,
    /// Silent for good.
    Over,
}

/// A voice's way through the envelope.
#[derive(Clone, Copy, Debug)]
pub struct Contour {
    stage: Stage,
    /// From 0 to 1. In `f64`, so even a long stretch doesn't drift.
    level: f64,
}

impl Contour {
    /// A note just pressed.
    pub const START: Self = Self {
        stage: Stage::Waiting(0),
        level: 0.0,
    };
    pub const OVER: Self = Self {
        stage: Stage::Over,
        level: 0.0,
    };

    #[must_use]
    pub fn is_held(&self) -> bool {
        matches!(
            self.stage,
            Stage::Waiting(_)
                | Stage::Rising
                | Stage::Holding(_)
                | Stage::Decaying
                | Stage::Sustaining
        )
    }

    #[must_use]
    pub fn is_giving_way(&self) -> bool {
        self.stage == Stage::GivingWay
    }

    #[must_use]
    pub fn is_over(&self) -> bool {
        self.stage == Stage::Over
    }

    #[must_use]
    pub fn level(&self) -> f64 {
        self.level
    }

    /// Held at a sustain level of none, where it can sound again only if the sustain is turned up.
    #[must_use]
    pub fn has_fallen_silent(&self) -> bool {
        self.stage == Stage::Sustaining && self.level == 0.0
    }

    /// Wherever it is, unless over.
    pub fn give_way(&mut self) {
        if !self.is_over() {
            self.stage = Stage::GivingWay;
        }
    }
}

/// A stretch a level walks, which is divided by: at least a sample, unlike a delay or a hold.
fn samples(seconds: f32, sample_rate: SampleRate) -> f64 {
    f64::from(ramp_samples(seconds, sample_rate))
}

/// The knobs, which every voice of an instrument follows.
pub struct Envelope {
    numbers: Numbers,
    sample_rate: SampleRate,
    /// In samples.
    delay: u32,
    /// Of full level, a sample.
    attack: f64,
    /// In samples.
    hold: u32,
    /// In samples.
    decay: f64,
    sustain: Smoothed,
    /// In samples.
    release: f64,
    /// Of full level, a sample.
    give_way: f64,
    /// Over the stretch of frames `prepare` walked: the sustain level at each, and what a decaying level is multiplied
    /// by there.
    sustains: [f32; BLOCK_FRAMES],
    falls: [f64; BLOCK_FRAMES],
}

impl Envelope {
    /// At the defaults.
    #[must_use]
    pub fn new(numbers: Numbers, sample_rate: SampleRate) -> Self {
        let mut envelope = Self {
            numbers,
            sample_rate,
            delay: 0,
            attack: 0.0,
            hold: 0,
            decay: 0.0,
            sustain: Smoothed::for_param(&SUSTAIN, sample_rate),
            release: 0.0,
            give_way: samples(GIVE_WAY_SECONDS, sample_rate).recip(),
            sustains: [0.0; BLOCK_FRAMES],
            falls: [1.0; BLOCK_FRAMES],
        };
        for (number, param) in numbers.all().into_iter().zip(PARAMS) {
            envelope.set(number, param.default);
        }
        envelope
    }

    /// Takes the value if the parameter is one of its own.
    pub fn set(&mut self, param: ParamNumber, value: f32) {
        let Numbers {
            delay,
            attack,
            hold,
            decay,
            sustain,
            release,
        } = self.numbers;
        let rate = self.sample_rate;
        if param == delay {
            self.delay = rate.frames(value);
        } else if param == attack {
            self.attack = samples(value, rate).recip();
        } else if param == hold {
            self.hold = rate.frames(value);
        } else if param == decay {
            self.decay = samples(value, rate);
        } else if param == sustain {
            self.sustain.set(value);
        } else if param == release {
            self.release = samples(value, rate);
        }
    }

    /// Walks the sustain level over the next `frames`, which [`Self::next`] then takes one by one.
    pub fn prepare(&mut self, frames: usize) {
        let decay = self.decay.recip();
        let fall = |sustain: f32| f64::from(sustain.max(FLOOR)).powf(decay);
        let (sustains, falls) = (&mut self.sustains[..frames], &mut self.falls[..frames]);
        match self.sustain.steady() {
            Some(sustain) => {
                sustains.fill(sustain);
                falls.fill(fall(sustain));
            }
            None => {
                for ((at, fall_at), sustain) in
                    sustains.iter_mut().zip(falls).zip(&mut self.sustain)
                {
                    *at = sustain;
                    *fall_at = fall(sustain);
                }
            }
        }
    }

    /// The voice's level at the prepared stretch's `frame`, a sample on from the last; none once it is over.
    pub fn next(&self, contour: &mut Contour, frame: usize) -> Option<f32> {
        let Contour { stage, level } = contour;
        loop {
            match stage {
                Stage::Waiting(waited) => {
                    if *waited < self.delay {
                        *waited += 1;
                        return Some(0.0);
                    }
                    *stage = Stage::Rising;
                }
                Stage::Rising => {
                    *level += self.attack;
                    if *level >= 1.0 - HAIR {
                        *level = 1.0;
                        *stage = Stage::Holding(0);
                    }
                    break;
                }
                Stage::Holding(held) => {
                    if *held < self.hold {
                        *held += 1;
                        break;
                    }
                    *stage = Stage::Decaying;
                }
                Stage::Decaying => {
                    let sustain = self.sustains[frame];
                    *level *= self.falls[frame];
                    // Below the floor, where the fall ends, it cuts to the sustain level.
                    if *level <= f64::from(sustain.max(FLOOR)) * (1.0 + HAIR) {
                        *level = sustain.into();
                        *stage = Stage::Sustaining;
                    }
                    break;
                }
                Stage::Sustaining => {
                    *level = self.sustains[frame].into();
                    break;
                }
                Stage::Releasing {
                    from,
                    fall,
                    release,
                } => {
                    // A turn of the release takes the rest of the fall on at its own pace.
                    #[expect(clippy::float_cmp, reason = "any turn of the release counts")]
                    if *release != self.release {
                        *release = self.release;
                        *fall = (f64::from(FLOOR) / *from).powf(release.recip());
                    }
                    *level *= *fall;
                    if *level <= f64::from(FLOOR) * (1.0 + HAIR) {
                        *contour = Contour::OVER;
                        return None;
                    }
                    break;
                }
                Stage::GivingWay => {
                    *level -= self.give_way;
                    if *level <= HAIR {
                        *contour = Contour::OVER;
                        return None;
                    }
                    break;
                }
                Stage::Over => return None,
            }
        }
        #[expect(
            clippy::cast_possible_truncation,
            reason = "worked out in f64, so a long fall doesn't drift; heard as an f32"
        )]
        let heard = *level as f32;
        Some(heard)
    }

    /// From where it is, unless it isn't held: one still silent, or at the floor, is over at once.
    pub fn let_go(&self, contour: &mut Contour) {
        if !contour.is_held() {
            return;
        }
        let from = contour.level;
        *contour = if from > f64::from(FLOOR) {
            Contour {
                stage: Stage::Releasing {
                    from,
                    fall: (f64::from(FLOOR) / from).powf(self.release.recip()),
                    release: self.release,
                },
                level: from,
            }
        } else {
            Contour::OVER
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{SAMPLE_RATE, decibels, largest_step, seconds};

    const DESCRIPTION: PluginDescription = PluginDescription {
        id: 1,
        version: 1,
        label: "An envelope",
        params: &PARAMS,
        samples: &[],
    };
    const NUMBERS: Numbers = Numbers::of(&DESCRIPTION);

    /// What a voice is told: a knob turned, or its note let go of.
    #[derive(Clone, Copy)]
    enum Told {
        Set(ParamNumber, f32),
        LetGo,
    }

    /// What the envelope is told, then for how many samples.
    type Span<'a> = (&'a [Told], usize);

    /// A note's levels from its press, block by block, with what it is told at the start of each span: so many samples
    /// each. The first span's knobs come before the first sample. None once it is over.
    fn levels(spans: &[Span<'_>]) -> Vec<Option<f32>> {
        let mut envelope = Envelope::new(NUMBERS, SAMPLE_RATE);
        let mut contour = Contour::START;
        let mut levels = Vec::new();
        for &(told, samples) in spans {
            for told in told {
                match *told {
                    Told::Set(param, value) => envelope.set(param, value),
                    Told::LetGo => envelope.let_go(&mut contour),
                }
            }
            let mut left = samples;
            while left > 0 {
                let frames = left.min(BLOCK_FRAMES);
                envelope.prepare(frames);
                levels.extend((0..frames).map(|frame| envelope.next(&mut contour, frame)));
                left -= frames;
            }
        }
        levels
    }

    fn sounding(levels: &[Option<f32>]) -> Vec<f32> {
        levels.iter().map(|level| level.unwrap_or(0.0)).collect()
    }

    fn near(a: f32, b: f32, by: f32) -> bool {
        (a - b).abs() <= by
    }

    #[expect(
        clippy::float_cmp,
        reason = "a level that gets to its target stays on it exactly"
    )]
    fn all_at(levels: &[f32], target: f32) -> bool {
        levels.iter().all(|&level| level == target)
    }

    #[test]
    fn a_new_note_rises_at_once_in_a_straight_line_over_3_ms_and_holds_full_level() {
        let attack = seconds(0.003);
        let levels = sounding(&levels(&[(&[], 10 * attack)]));
        for (i, level) in levels[..attack].iter().enumerate() {
            let line = (i + 1) as f32 / attack as f32;
            assert!(near(*level, line, 1e-6), "{i}: {level} for {line}");
        }
        assert!(all_at(&levels[attack - 1..], 1.0));
    }

    #[test]
    fn each_parameter_is_its_own_and_in_the_envelope_s_group() {
        let numbers = NUMBERS.all();
        let ids = numbers.map(|number| number.entry(DESCRIPTION.params).map(|param| param.id));
        assert_eq!(
            ids.map(Option::unwrap),
            [
                "envelope.delay",
                "envelope.attack",
                "envelope.hold",
                "envelope.decay",
                "envelope.sustain",
                "envelope.release",
            ]
        );
        assert!(PARAMS.iter().all(|param| param.group == Some(GROUP)));
    }

    #[test]
    fn a_delay_keeps_the_note_silent_then_it_rises() {
        let (delay, attack) = (seconds(0.25), seconds(0.003));
        let levels = sounding(&levels(&[(
            &[Told::Set(NUMBERS.delay, 0.25)],
            delay + attack,
        )]));
        assert!(levels[..delay].iter().all(|&level| level == 0.0));
        assert!(near(levels[delay], 1.0 / attack as f32, 1e-6));
        assert_eq!(levels[delay + attack - 1], 1.0);
    }

    #[test]
    fn an_attack_rises_in_a_straight_line_to_full_level_in_its_time_however_long() {
        for time in [0.001, 0.5, 10.0] {
            let attack = seconds(time);
            let levels = sounding(&levels(&[(
                &[Told::Set(NUMBERS.attack, time)],
                attack + 10,
            )]));
            assert!(
                near(levels[attack / 2 - 1], 0.5, 1e-3),
                "{time}: {}",
                levels[attack / 2 - 1]
            );
            assert!(levels[attack - 2] < 1.0, "{time}");
            assert_eq!(levels[attack - 1], 1.0, "{time}");
        }
    }

    #[test]
    fn a_hold_keeps_full_level_then_a_decay_falls_evenly_in_decibels_to_the_sustain_level_in_its_time()
     {
        let (attack, hold, decay) = (seconds(0.003), seconds(0.1), seconds(0.4));
        let knobs = [
            Told::Set(NUMBERS.hold, 0.1),
            Told::Set(NUMBERS.decay, 0.4),
            Told::Set(NUMBERS.sustain, 0.25),
        ];
        let levels = sounding(&levels(&[(&knobs, attack + hold + decay + 1000)]));
        let top = attack - 1;
        assert!(all_at(&levels[top..=top + hold], 1.0));
        let falling = &levels[top + hold + 1..];
        // A quarter of the way down in decibels each quarter of the time.
        for quarter in 1..=4 {
            let level = decibels(falling[quarter * decay / 4 - 1]);
            let line = decibels(0.25) * quarter as f32 / 4.0;
            assert!(near(level, line, 0.01), "{quarter}: {level} for {line}");
        }
        assert!(falling[decay - 2] > 0.25);
        assert!(all_at(&falling[decay - 1..], 0.25));
    }

    #[test]
    fn at_sustain_0_a_held_note_falls_silent_over_its_decay_and_stays_held() {
        let decay = seconds(0.5);
        let mut envelope = Envelope::new(NUMBERS, SAMPLE_RATE);
        envelope.set(NUMBERS.sustain, 0.0);
        let mut contour = Contour::START;
        let mut levels = Vec::new();
        for _ in 0..(seconds(0.003) + decay + 1000).div_ceil(BLOCK_FRAMES) {
            envelope.prepare(BLOCK_FRAMES);
            levels
                .extend((0..BLOCK_FRAMES).map(|frame| envelope.next(&mut contour, frame).unwrap()));
        }
        let fallen = seconds(0.003) - 1 + decay;
        assert!(
            near(decibels(levels[fallen - 1]), -80.0, 0.01),
            "{}",
            levels[fallen - 1]
        );
        assert!(levels[fallen..].iter().all(|&level| level == 0.0));
        assert!(contour.is_held());
    }

    #[test]
    fn a_release_falls_evenly_in_decibels_from_where_the_note_was_to_silence_in_its_time() {
        let release = seconds(0.1);
        // From full level, and from half way up a 10 ms attack.
        for (held, from) in [(seconds(0.05), 1.0), (seconds(0.005), 0.5)] {
            let knobs = [Told::Set(NUMBERS.attack, 0.01)];
            let levels = levels(&[(&knobs, held), (&[Told::LetGo], release + 10)]);
            let falling = &levels[held..];
            assert!(near(levels[held - 1].unwrap(), from, 1e-6));
            let start = decibels(from);
            for quarter in 1..4 {
                let level = decibels(falling[quarter * release / 4 - 1].unwrap());
                let line = start + (-80.0 - start) * quarter as f32 / 4.0;
                assert!(
                    near(level, line, 0.01),
                    "from {from}, {quarter}: {level} for {line}"
                );
            }
            assert!(falling[release - 2].is_some(), "from {from}");
            assert!(
                falling[release - 1..].iter().all(Option::is_none),
                "from {from}"
            );
        }
    }

    #[test]
    fn a_note_let_go_of_during_its_delay_never_sounds() {
        let delay = [Told::Set(NUMBERS.delay, 0.1)];
        let levels = levels(&[(&delay, 100), (&[Told::LetGo], seconds(0.2))]);
        assert!(levels[..100].iter().all(|&level| level == Some(0.0)));
        assert!(levels[100..].iter().all(Option::is_none));
    }

    #[test]
    fn a_time_turned_takes_the_stretch_a_note_is_in_on_from_its_frame() {
        // Half way up a 10 ms attack, the rest of the way in 1 ms.
        let slow = [Told::Set(NUMBERS.attack, 0.01)];
        let half = seconds(0.005);
        let rising = sounding(&levels(&[
            (&slow, half),
            (&[Told::Set(NUMBERS.attack, 0.001)], 100),
        ]));
        let step = 1.0 / seconds(0.001) as f32;
        assert!(near(rising[half] - rising[half - 1], step, 1e-6));
        assert_eq!(rising[half + seconds(0.0005) - 1], 1.0);
        // Half way down a release from the sustain level, the rest at the pace of one ten times as long.
        let (release, sustain) = (seconds(0.1), 0.5);
        let held = [
            Told::Set(NUMBERS.decay, 0.01),
            Told::Set(NUMBERS.sustain, sustain),
        ];
        let turned = levels(&[
            (&held, 1000),
            (&[Told::LetGo], release / 2),
            (&[Told::Set(NUMBERS.release, 1.0)], 10 * release),
        ]);
        let fall = decibels(FLOOR) - decibels(sustain);
        let before = decibels(turned[1000 + release / 2 - 1].unwrap());
        let after = decibels(turned[1000 + release / 2 + release - 1].unwrap());
        assert!(
            near(before, decibels(sustain) + fall / 2.0, 0.01),
            "{before}"
        );
        // A tenth of the fall a release of the new length takes over its whole.
        assert!(near(after - before, fall / 10.0, 0.01), "{after}");
    }

    #[test]
    fn a_note_let_go_of_at_the_floor_is_over_at_once() {
        let envelope = Envelope::new(NUMBERS, SAMPLE_RATE);
        let mut contour = Contour {
            stage: Stage::Sustaining,
            level: f64::from(FLOOR),
        };
        envelope.let_go(&mut contour);
        assert!(contour.is_over());
    }

    #[test]
    fn a_sustain_turned_while_a_note_is_held_glides_to_its_new_level() {
        let glide = seconds(0.02);
        let held = 1000;
        let levels = sounding(&levels(&[
            (&[], held),
            (&[Told::Set(NUMBERS.sustain, 0.5)], 2 * glide),
        ]));
        assert!(levels[held] < 1.0);
        assert!(
            near(levels[held + glide / 2 - 1], 0.75, 1e-3),
            "{}",
            levels[held + glide / 2 - 1]
        );
        assert!(all_at(&levels[held + glide - 1..], 0.5));
    }

    #[test]
    fn a_sustain_raised_past_a_decaying_note_takes_it_on_without_a_jump() {
        let knobs = [
            Told::Set(NUMBERS.sustain, 0.0),
            Told::Set(NUMBERS.decay, 2.0),
        ];
        let raised = [Told::Set(NUMBERS.sustain, 1.0)];
        let levels = sounding(&levels(&[(&knobs, seconds(0.2)), (&raised, seconds(0.1))]));
        let step = largest_step(&levels[seconds(0.003)..]);
        // No more than the glide's own: a 20 ms one over the whole level.
        assert!(step <= 1.0 / seconds(0.02) as f32 + 1e-6, "{step}");
        assert_eq!(levels[levels.len() - 1], 1.0);
    }

    #[test]
    fn no_stretch_moves_the_level_in_a_sample_by_more_than_the_shortest_attack() {
        // Further would click.
        let limit = 1.0 / seconds(ATTACK.min) as f32 + 1e-6;
        let shortest = |param: &ParamDescription| Told::Set(NUMBERS.all()[place(param)], param.min);
        let silent = Told::Set(NUMBERS.sustain, 0.0);
        let long = |param: &ParamDescription| Told::Set(NUMBERS.all()[place(param)], param.max);
        let cases: [(&str, &[Span<'_>]); 6] = [
            ("attack", &[(&[shortest(&ATTACK)], 1000)]),
            ("decay", &[(&[shortest(&DECAY), silent], 2000)]),
            (
                "release",
                &[(&[shortest(&RELEASE)], 1000), (&[Told::LetGo], 2000)],
            ),
            (
                "release cut short",
                &[
                    (&[], 1000),
                    (&[Told::LetGo], 100),
                    (&[shortest(&RELEASE)], 2000),
                ],
            ),
            (
                "delay cut short",
                &[(&[long(&DELAY)], 1000), (&[shortest(&DELAY)], 1000)],
            ),
            (
                "hold cut short",
                &[
                    (&[long(&HOLD), shortest(&DECAY), silent], 1000),
                    (&[shortest(&HOLD)], 2000),
                ],
            ),
        ];
        for (case, stretches) in cases {
            let step = largest_step(&sounding(&levels(stretches)));
            assert!(step <= limit, "{case}: {step} > {limit}");
        }
    }

    /// Its place in [`PARAMS`].
    fn place(param: &ParamDescription) -> usize {
        PARAMS.iter().position(|each| each.id == param.id).unwrap()
    }

    #[test]
    fn a_note_giving_way_falls_silent_in_a_straight_line_over_20_ms() {
        let mut envelope = Envelope::new(NUMBERS, SAMPLE_RATE);
        let mut contour = Contour::START;
        // Past the attack, at full level.
        for _ in 0..2 {
            envelope.prepare(BLOCK_FRAMES);
            (0..BLOCK_FRAMES).for_each(|frame| _ = envelope.next(&mut contour, frame));
        }
        assert_eq!(contour.level(), 1.0);
        contour.give_way();
        let mut levels = Vec::new();
        for _ in 0..seconds(0.03).div_ceil(BLOCK_FRAMES) {
            envelope.prepare(BLOCK_FRAMES);
            levels.extend((0..BLOCK_FRAMES).map(|frame| envelope.next(&mut contour, frame)));
        }
        let give_way = seconds(GIVE_WAY_SECONDS);
        assert!(near(levels[give_way / 2 - 1].unwrap(), 0.5, 1e-6));
        assert!(levels[give_way - 2].is_some());
        assert!(levels[give_way - 1..].iter().all(Option::is_none));
        assert!(contour.is_over());
    }
}
