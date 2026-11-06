//! Every node's volume and pan, after what the node does: the engine's own, not a plugin's parameters. Commands
//! number them by their place in [`STRIP`], from 1.

use std::array;
use std::f64::consts::{FRAC_PI_4, SQRT_2};

use engine_plugins::smoothing::Smoothed;
use engine_plugins::{BLOCK_FRAMES, CHANNELS, ParamDescription, Scale, Unit, Values};

use crate::schema::Rejection;

/// Both alike: a change of either moves the same two gains.
const SMOOTHING_SECONDS: f32 = 0.02;

/// Up to 5.6 dB over the sound as it is, a mixer fader's top; at the sound as it is unless something turns it.
pub const VOLUME: ParamDescription = ParamDescription {
    id: "volume",
    label: "Volume",
    group: None,
    unit: Some(Unit::Gain),
    scale: Scale::Volume,
    values: Values::Any,
    min: 0.0,
    // +5.6 dB.
    max: 1.905_460_7,
    default: 1.0,
    smoothing_seconds: SMOOTHING_SECONDS,
};

/// Equal power, the circular pan law: the middle leaves the sound as it is, a side is up to 3 dB louder.
pub const PAN: ParamDescription = ParamDescription {
    id: "pan",
    label: "Pan",
    group: None,
    unit: Some(Unit::Pan),
    scale: Scale::Linear,
    values: Values::Any,
    min: -1.0,
    max: 1.0,
    default: 0.0,
    smoothing_seconds: SMOOTHING_SECONDS,
};

pub const STRIP: &[ParamDescription] = &[VOLUME, PAN];

/// Their numbers in commands, found by ID, so the order lives only in [`STRIP`].
pub const VOLUME_NUMBER: u32 = number(VOLUME.id);
pub const PAN_NUMBER: u32 = number(PAN.id);

/// An ID the strip doesn't have fails the build.
const fn number(id: &str) -> u32 {
    let mut place = 0;
    while place < STRIP.len() {
        if same(STRIP[place].id.as_bytes(), id.as_bytes()) {
            return place as u32 + 1;
        }
        place += 1;
    }
    panic!("no strip parameter with this ID")
}

const fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// By the parameters' numbers, from 1.
type StripValues = [f32; STRIP.len()];

fn value(values: &StripValues, number: u32) -> f32 {
    values[number as usize - 1]
}

pub(crate) struct Strip {
    values: StripValues,
    /// Of the left side, then of the right.
    gains: [Smoothed; CHANNELS],
}

impl Strip {
    /// Every parameter at its default.
    pub(crate) fn new(sample_rate: f32) -> Self {
        let values = array::from_fn(|place| STRIP[place].default);
        Self {
            values,
            gains: gains(values).map(|gain| Smoothed::new(gain, SMOOTHING_SECONDS, sample_rate)),
        }
    }

    /// A value is taken as [`ParamDescription::taken`] has it. Before the first block it is there at once, after it
    /// glides there.
    pub(crate) fn set(&mut self, number: u32, value: f32) -> Result<(), Rejection> {
        let place = (number as usize)
            .checked_sub(1)
            .filter(|&place| place < STRIP.len())
            .ok_or(Rejection::UnknownTarget)?;
        self.values[place] = STRIP[place].taken(value).ok_or(Rejection::InvalidValue)?;
        for (gain, target) in self.gains.iter_mut().zip(gains(self.values)) {
            gain.set(target);
        }
        Ok(())
    }

    /// To the first `frames` of `output`, in place; a side whose gain is still walks its samples only if it isn't 1.
    pub(crate) fn apply(&mut self, output: &mut [[f32; BLOCK_FRAMES]; CHANNELS], frames: usize) {
        for (side, gain) in output.iter_mut().zip(&mut self.gains) {
            let side = &mut side[..frames];
            match gain.steady() {
                Some(1.0) => {}
                Some(steady) => side.iter_mut().for_each(|sample| *sample *= steady),
                None => {
                    for (sample, gain) in side.iter_mut().zip(gain) {
                        *sample *= gain;
                    }
                }
            }
        }
    }
}

/// The left side's gain and the right's; their squares add up to twice the volume's.
fn gains(values: StripValues) -> [f32; CHANNELS] {
    let volume = f64::from(value(&values, VOLUME_NUMBER));
    let pan = f64::from(value(&values, PAN_NUMBER));
    // In f64, so the middle comes out as exactly 1 and the far side as exactly 0.
    let side = |toward: f64| (volume * SQRT_2 * ((1.0 + toward) * FRAC_PI_4).sin()) as f32;
    [side(-pan), side(pan)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::SAMPLE_RATE;

    /// 0.5 on the left and -0.25 on the right through the strip, one block.
    fn through(strip: &mut Strip) -> [[f32; BLOCK_FRAMES]; CHANNELS] {
        let mut output = [[0.5; BLOCK_FRAMES], [-0.25; BLOCK_FRAMES]];
        strip.apply(&mut output, BLOCK_FRAMES);
        output
    }

    fn values(volume: f32, pan: f32) -> StripValues {
        let mut values = [0.0; STRIP.len()];
        values[VOLUME_NUMBER as usize - 1] = volume;
        values[PAN_NUMBER as usize - 1] = pan;
        values
    }

    fn set(values: &[(u32, f32)]) -> Strip {
        let mut strip = Strip::new(SAMPLE_RATE);
        for &(number, value) in values {
            strip.set(number, value).unwrap();
        }
        strip
    }

    #[test]
    fn the_numbers_follow_the_list() {
        assert_eq!(STRIP[VOLUME_NUMBER as usize - 1].id, "volume");
        assert_eq!(STRIP[PAN_NUMBER as usize - 1].id, "pan");
    }

    #[test]
    fn at_its_defaults_it_leaves_the_sound_as_it_is() {
        let output = through(&mut Strip::new(SAMPLE_RATE));
        assert_eq!(output, [[0.5; BLOCK_FRAMES], [-0.25; BLOCK_FRAMES]]);
    }

    #[test]
    fn the_volume_scales_both_sides() {
        let output = through(&mut set(&[(VOLUME_NUMBER, 0.8)]));
        assert_eq!(output, [[0.4; BLOCK_FRAMES], [-0.2; BLOCK_FRAMES]]);
    }

    #[test]
    fn all_the_way_to_a_side_silences_the_other_and_adds_3_db() {
        let right = through(&mut set(&[(PAN_NUMBER, 1.0)]));
        assert_eq!(right[0], [0.0; BLOCK_FRAMES]);
        assert_eq!(right[1], [-0.25 * std::f32::consts::SQRT_2; BLOCK_FRAMES]);
        let left = through(&mut set(&[(PAN_NUMBER, -1.0)]));
        assert_eq!(left[0], [0.5 * std::f32::consts::SQRT_2; BLOCK_FRAMES]);
        assert_eq!(left[1], [0.0; BLOCK_FRAMES]);
    }

    #[test]
    fn a_sound_alike_in_both_sides_is_as_loud_wherever_it_is() {
        for pan in [-1.0, -0.7, -0.3, 0.0, 0.2, 0.5, 0.9, 1.0] {
            let [left, right] = gains(values(0.6, pan));
            let power = left * left + right * right;
            assert!((power - 2.0 * 0.36).abs() < 1e-6, "{pan}: {power}");
        }
    }

    #[test]
    fn halfway_is_between_the_middle_and_the_side() {
        let [left, right] = gains(values(1.0, 0.5));
        assert!(0.0 < left && left < 1.0, "{left}");
        assert!(1.0 < right && right < std::f32::consts::SQRT_2, "{right}");
    }

    #[test]
    fn the_top_is_5_6_db_over_the_sound_as_it_is() {
        let decibels = 20.0 * VOLUME.max.log10();
        assert!((decibels - 5.6).abs() < 1e-5, "{decibels}");
    }

    #[test]
    fn values_out_of_range_are_clamped() {
        let output = through(&mut set(&[(VOLUME_NUMBER, 3.0), (PAN_NUMBER, 7.0)]));
        assert_eq!(output[0], [0.0; BLOCK_FRAMES]);
        let right = -0.25 * std::f32::consts::SQRT_2 * VOLUME.max;
        assert!(
            output[1]
                .iter()
                .all(|&sample| (sample - right).abs() < 1e-6),
            "{}",
            output[1][0]
        );
        let silent = through(&mut set(&[(VOLUME_NUMBER, -1.0)]));
        assert_eq!(silent, [[0.0; BLOCK_FRAMES]; CHANNELS]);
    }

    #[test]
    fn a_volume_far_below_hearing_is_silence_not_denormals() {
        let output = through(&mut set(&[(VOLUME_NUMBER, 1e-40)]));
        assert_eq!(output, [[0.0; BLOCK_FRAMES]; CHANNELS]);
    }

    #[test]
    fn refuses_what_is_no_value_of_a_parameter_it_has() {
        let mut strip = Strip::new(SAMPLE_RATE);
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                strip.set(VOLUME_NUMBER, value),
                Err(Rejection::InvalidValue)
            );
        }
        for number in [0, PAN_NUMBER + 1, u32::MAX] {
            assert_eq!(strip.set(number, 0.5), Err(Rejection::UnknownTarget));
        }
        // Nothing refused changed it.
        assert_eq!(
            through(&mut strip),
            [[0.5; BLOCK_FRAMES], [-0.25; BLOCK_FRAMES]]
        );
    }

    #[test]
    fn once_it_sounds_a_change_glides_rather_than_jumps() {
        let mut strip = Strip::new(SAMPLE_RATE);
        through(&mut strip);
        strip.set(VOLUME_NUMBER, 0.0).unwrap();
        let output = through(&mut strip);
        let left = output[0];
        // The ramp takes 960 samples.
        assert!(left[0] > 0.49, "{}", left[0]);
        assert!(left.windows(2).all(|pair| pair[1] < pair[0]));
        assert!(left[BLOCK_FRAMES - 1] > 0.4, "{}", left[BLOCK_FRAMES - 1]);
        let ramp = (SMOOTHING_SECONDS * SAMPLE_RATE) as usize;
        for _ in 0..ramp.div_ceil(BLOCK_FRAMES) {
            through(&mut strip);
        }
        assert_eq!(through(&mut strip), [[0.0; BLOCK_FRAMES]; CHANNELS]);
    }

    #[test]
    fn applies_to_the_frames_asked_and_no_more() {
        let mut strip = set(&[(VOLUME_NUMBER, 0.5)]);
        let mut output = [[1.0; BLOCK_FRAMES]; CHANNELS];
        strip.apply(&mut output, 3);
        assert_eq!(output[0][..4], [0.5, 0.5, 0.5, 1.0]);
    }
}
