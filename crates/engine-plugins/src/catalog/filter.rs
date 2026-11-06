//! A low-pass filter: Andrew Simper's state variable filter (Cytomic), which stays stable however fast the cutoff
//! moves. 12 dB per octave, no bump at the cutoff.

use std::f32::consts::{PI, SQRT_2};
use std::ops::Range;

use crate::events::{Step, steps};
use crate::smoothing::Smoothed;
use crate::{
    CHANNELS, Event, ParamDescription, Plugin, PluginDescription, ProcessContext, Scale, Unit,
    Values, denormal,
};

const CUTOFF_PARAM: ParamDescription = ParamDescription {
    id: "cutoff",
    label: "Cutoff",
    group: None,
    unit: Some(Unit::Hertz),
    // So a turn, and its smoothing, moves evenly to the ear.
    scale: Scale::Logarithmic,
    values: Values::Any,
    min: 20.0,
    max: 20_000.0,
    // Open, so a new filter leaves the sound as it is.
    default: 20_000.0,
    smoothing_seconds: 0.02,
};

pub const DESCRIPTION: PluginDescription = PluginDescription {
    id: 2,
    version: 1,
    label: "Filter",
    params: &[CUTOFF_PARAM],
    samples: &[],
};

pub const CUTOFF: u32 = DESCRIPTION.param_number(CUTOFF_PARAM.id);

/// 1/Q of a Butterworth response: −3 dB at the cutoff.
const DAMPING: f32 = SQRT_2;

/// A moving cutoff takes `tan` once in this many samples, and the gain goes in a straight line between: `tan` on
/// every sample would cost more than the filter itself, and changing in steps clicks.
const GAIN_STEP: usize = 16;

/// The integrators' gain; it grows without bound at half the sample rate.
fn gain(cutoff: f32, sample_rate: f32) -> f32 {
    (PI * cutoff.min(0.49 * sample_rate) / sample_rate).tan()
}

#[derive(Clone, Copy)]
struct Coefficients {
    a1: f32,
    a2: f32,
    a3: f32,
}

impl Coefficients {
    fn new(gain: f32) -> Self {
        let a1 = 1.0 / (1.0 + gain * (gain + DAMPING));
        let a2 = gain * a1;
        Self {
            a1,
            a2,
            a3: gain * a2,
        }
    }
}

/// A channel's two integrators.
#[derive(Default)]
struct Memory {
    ic1eq: f32,
    ic2eq: f32,
}

struct Filter {
    sample_rate: f32,
    cutoff: Smoothed,
    /// The cutoff the gain heads for.
    heading: f32,
    /// Samples until the gain heads for the cutoff again; a turn starts the count anew, so it is heard at once.
    until_heading: usize,
    gain: Smoothed,
    /// For the gain they were made from.
    coefficients: (f32, Coefficients),
    memory: [Memory; CHANNELS],
}

impl Filter {
    fn new(sample_rate: f32) -> Self {
        let open = gain(CUTOFF_PARAM.default, sample_rate);
        Self {
            sample_rate,
            cutoff: Smoothed::for_param(&CUTOFF_PARAM, sample_rate),
            heading: CUTOFF_PARAM.default,
            until_heading: 0,
            gain: Smoothed::new(open, GAIN_STEP as f32 / sample_rate, sample_rate),
            coefficients: (open, Coefficients::new(open)),
            memory: Default::default(),
        }
    }

    /// `frames` count from the block's start.
    fn render(
        &mut self,
        input: &[&[f32]; CHANNELS],
        output: &mut [&mut [f32]; CHANNELS],
        frames: Range<usize>,
    ) {
        for (i, cutoff) in frames.zip(&mut self.cutoff) {
            if self.until_heading == 0 {
                self.until_heading = GAIN_STEP;
                if cutoff != self.heading {
                    self.heading = cutoff;
                    self.gain.set(gain(cutoff, self.sample_rate));
                }
            }
            self.until_heading -= 1;
            let gain = self.gain.next().unwrap_or(self.coefficients.0);
            if gain != self.coefficients.0 {
                self.coefficients = (gain, Coefficients::new(gain));
            }
            let Coefficients { a1, a2, a3 } = self.coefficients.1;
            for (channel, memory) in self.memory.iter_mut().enumerate() {
                let v3 = input[channel][i] - memory.ic2eq;
                let v1 = a1 * memory.ic1eq + a2 * v3;
                let v2 = memory.ic2eq + a2 * memory.ic1eq + a3 * v3;
                memory.ic1eq = denormal::flush(2.0 * v1 - memory.ic1eq);
                memory.ic2eq = denormal::flush(2.0 * v2 - memory.ic2eq);
                output[channel][i] = v2;
            }
        }
    }
}

pub(crate) fn create(sample_rate: f32) -> Box<dyn Plugin> {
    Box::new(Filter::new(sample_rate))
}

impl Plugin for Filter {
    fn process(&mut self, context: ProcessContext) {
        let ProcessContext {
            input,
            mut output,
            events,
            samples: _,
        } = context;
        for step in steps(events, output[0].len()) {
            match step {
                Step::Event(Event::Param {
                    param: CUTOFF,
                    value,
                    ..
                }) => {
                    self.cutoff.set(value);
                    self.until_heading = 0;
                }
                Step::Event(_) => {}
                Step::Frames(frames) => self.render(&input, &mut output, frames),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{SAMPLE_RATE, first_block, render, rms, sine_at};

    /// A steady sine's level through the filter against its own, once the filter has settled.
    fn gain_db(cutoff: f32, frequency: f32) -> f32 {
        let mut filter = create(SAMPLE_RATE);
        let input = sine_at(frequency, SAMPLE_RATE as usize);
        let first = first_block(&DESCRIPTION, &[(CUTOFF, cutoff)]);
        let [left, right] = render(&DESCRIPTION, filter.as_mut(), &first, &input);
        assert_eq!(left, right);
        // Half a second holds whole periods of every frequency here.
        let settled = SAMPLE_RATE as usize / 2;
        20.0 * (rms(&left[settled..]) / rms(&input[settled..])).log10()
    }

    #[test]
    fn leaves_the_sound_as_it_is_when_open() {
        let gain = gain_db(CUTOFF_PARAM.default, 440.0);
        assert!(gain.abs() < 0.01, "{gain} dB");
    }

    #[test]
    fn passes_what_lies_far_below_the_cutoff() {
        let gain = gain_db(4000.0, 100.0);
        assert!(gain.abs() < 0.01, "{gain} dB");
    }

    #[test]
    fn is_3_db_down_at_the_cutoff_and_12_an_octave_above() {
        let at_cutoff = gain_db(1000.0, 1000.0);
        assert!((at_cutoff + 3.01).abs() < 0.05, "{at_cutoff} dB");
        // A Butterworth response falls 12.3 dB by an octave above the cutoff.
        let octave_above = gain_db(1000.0, 2000.0);
        assert!((octave_above + 12.3).abs() < 0.2, "{octave_above} dB");
    }

    #[test]
    fn a_turn_moves_evenly_in_octaves() {
        let mut filter = Filter::new(SAMPLE_RATE);
        let input = sine_at(440.0, 960);
        render(
            &DESCRIPTION,
            &mut filter,
            &first_block(&DESCRIPTION, &[]),
            &input[..1],
        );
        // Half of the 20 ms ramp.
        let turn = Event::param_at_start(CUTOFF, CUTOFF_PARAM.min);
        render(&DESCRIPTION, &mut filter, &[turn], &input[..480]);
        // Halfway from 20 kHz to 20 Hz in octaves, not 10 kHz: within one coefficient step of it.
        let octaves = (CUTOFF_PARAM.max / CUTOFF_PARAM.min).log2();
        let halfway = (CUTOFF_PARAM.max * CUTOFF_PARAM.min).sqrt().log2();
        let step = GAIN_STEP as f32 * octaves / 960.0;
        let off = (filter.heading.log2() - halfway).abs();
        assert!(off <= step, "{off} octaves off");
    }
}
