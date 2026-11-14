//! The test tone: a 440 Hz sine.

use std::f32::consts::TAU;

use crate::smoothing::Smoothed;
use crate::{
    Event, ParamDescription, ParamNumber, Plugin, PluginDescription, ProcessContext, SampleRate,
    Scale, Step, Unit, Values, steps,
};

const VOLUME_PARAM: ParamDescription = ParamDescription {
    id: "volume",
    label: "Volume",
    group: None,
    unit: Some(Unit::Gain),
    scale: Scale::Volume,
    values: Values::Any,
    min: 0.0,
    max: 1.0,
    default: 0.5,
    // A bit longer than the gap between slider events (~17 ms), so their ramps join.
    smoothing_seconds: 0.02,
};

pub const DESCRIPTION: PluginDescription = PluginDescription {
    id: 1,
    version: 1,
    label: "Test tone",
    params: &[VOLUME_PARAM],
    samples: &[],
};

pub const VOLUME: ParamNumber = ParamNumber::of(DESCRIPTION.params, VOLUME_PARAM.id);

/// The peak at full volume, well below full scale: a pure sine is loud.
pub const MAX_GAIN: f32 = 0.2;
pub const FREQUENCY: f32 = 440.0;

struct Tone {
    phase: f32,
    phase_step: f32,
    volume: Smoothed,
}

pub(crate) fn create(sample_rate: SampleRate) -> Box<dyn Plugin> {
    Box::new(Tone {
        phase: 0.0,
        phase_step: TAU * FREQUENCY / sample_rate.hz(),
        volume: Smoothed::for_param(&VOLUME_PARAM, sample_rate),
    })
}

impl Tone {
    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        for ((l, r), volume) in left.iter_mut().zip(right).zip(&mut self.volume) {
            let sample = MAX_GAIN * volume * self.phase.sin();
            *l = sample;
            *r = sample;
            self.phase += self.phase_step;
            if self.phase >= TAU {
                self.phase -= TAU;
            }
        }
    }
}

impl Plugin for Tone {
    fn process(&mut self, context: ProcessContext<'_>) {
        let ProcessContext {
            output: [left, right],
            events,
            ..
        } = context;
        for step in steps(events, left.len()) {
            match step {
                Step::Event(Event::Param {
                    param: VOLUME,
                    value,
                    ..
                }) => self.volume.set(value),
                Step::Event(_) => {}
                Step::Frames(frames) => self.render(&mut left[frames.clone()], &mut right[frames]),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{SAMPLE_RATE, first_block, peak, render, seconds, silence};

    #[test]
    fn plays_a_440_hz_sine_at_the_default_volume() {
        let mut tone = create(SAMPLE_RATE);
        let first = first_block(&DESCRIPTION, &[]);
        let [left, right] = render(&DESCRIPTION, tone.as_mut(), &first, &silence(seconds(1.0)));
        assert_eq!(left, right);
        let level = peak(&left);
        assert!(
            (level - MAX_GAIN * VOLUME_PARAM.default).abs() < 1e-3,
            "peak {level}"
        );
        // The first period starts at zero and isn't counted as a crossing.
        let crossings = left
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        assert!((439..=440).contains(&crossings), "crossings {crossings}");
    }

    #[test]
    fn starts_at_0_and_rises() {
        let first = first_block(&DESCRIPTION, &[]);
        let [left, _] = render(
            &DESCRIPTION,
            create(SAMPLE_RATE).as_mut(),
            &first,
            &silence(8),
        );
        assert_eq!(left[0], 0.0);
        assert!(left.windows(2).all(|pair| pair[1] > pair[0]), "{left:?}");
    }

    #[test]
    fn volume_sets_the_level() {
        let mut tone = create(SAMPLE_RATE);
        let first = first_block(&DESCRIPTION, &[(VOLUME, 0.25)]);
        let [left, _] = render(&DESCRIPTION, tone.as_mut(), &first, &silence(seconds(0.1)));
        assert!((peak(&left) - MAX_GAIN * 0.25).abs() < 1e-3);
    }
}
