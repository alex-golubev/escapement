//! The built-in plugins: one entry each, for its current version only. The tests here hold for every entry, so a
//! plugin is checked as soon as it is listed.

pub mod filter;
pub mod sampler;
pub mod synth;
pub mod tone;

use crate::{Plugin, PluginDescription, SampleRate};

pub struct CatalogEntry {
    /// What code calls the plugin: its module's name. Never stored, unlike its ID.
    pub name: &'static str,
    pub description: &'static PluginDescription,
    /// Allocates, so only on the build thread.
    pub create: fn(sample_rate: SampleRate) -> Box<dyn Plugin>,
}

/// An entry for each plugin module, named after it.
macro_rules! catalog {
    ($($plugin:ident),* $(,)?) => {
        &[$(CatalogEntry {
            name: stringify!($plugin),
            description: &$plugin::DESCRIPTION,
            create: $plugin::create,
        }),*]
    };
}

pub static CATALOG: &[CatalogEntry] = catalog![tone, filter, sampler, synth];

/// Only the exact version: another one may sound different.
#[must_use]
pub fn find(plugin: u32, version: u32) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| {
        let description = entry.description;
        description.id == plugin && description.version == version
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smoothing::ramp_samples;
    use crate::testing::{
        NOTE_NAME, SAMPLE_RATE, difference, first_block_with_note, largest_step, note_off, render,
        seconds, silence, sine,
    };
    use crate::{BLOCK_FRAMES, CHANNELS, Event, ParamDescription, ParamNumber};

    #[test]
    fn every_plugin_has_its_own_id_and_name_a_version_and_a_label() {
        for entry in CATALOG {
            let name = entry.name;
            let PluginDescription {
                id, version, label, ..
            } = *entry.description;
            assert_ne!(id, 0, "{name}");
            assert_ne!(version, 0, "{name}");
            assert!(!label.is_empty(), "{name}");
            let holders = CATALOG.iter().filter(|other| other.description.id == id);
            assert_eq!(holders.count(), 1, "{name}: ID {id} is taken twice");
            let holders = CATALOG.iter().filter(|other| other.name == name);
            assert_eq!(holders.count(), 1, "{name}: the name is taken twice");
        }
    }

    /// Their ranges and scales are checked with the strip's, by `describe-plugins`, which sends them all to the page.
    #[test]
    fn every_parameter_has_its_own_id_and_a_label() {
        for entry in CATALOG {
            let params = entry.description.params;
            for param in params {
                let at = format!("{} {:?}", entry.name, param.id);
                assert!(!param.id.is_empty(), "{at}");
                assert!(!param.label.is_empty(), "{at}");
                let holders = params.iter().filter(|other| other.id == param.id);
                assert_eq!(holders.count(), 1, "{at}: the ID is taken twice");
            }
        }
    }

    #[test]
    fn every_sample_has_its_own_id_and_a_label() {
        for entry in CATALOG {
            let samples = entry.description.samples;
            for sample in samples {
                let at = format!("{} {:?}", entry.name, sample.id);
                assert!(!sample.id.is_empty(), "{at}");
                assert!(!sample.label.is_empty(), "{at}");
                let holders = samples.iter().filter(|other| other.id == sample.id);
                assert_eq!(holders.count(), 1, "{at}: the ID is taken twice");
            }
        }
    }

    #[test]
    fn plugins_are_found_by_their_exact_version_only() {
        for entry in CATALOG {
            let PluginDescription { id, version, .. } = *entry.description;
            assert!(find(id, version).is_some_and(|found| std::ptr::eq(found, entry)));
            assert!(find(id, version - 1).is_none());
            assert!(find(id, version + 1).is_none());
        }
        assert!(find(0, 1).is_none());
    }

    #[test]
    fn every_plugin_writes_its_whole_output() {
        for entry in CATALOG {
            let mut plugin = (entry.create)(SAMPLE_RATE);
            let first = first_block_with_note(entry.description, &[]);
            // A short last block too.
            let output = render(
                entry.description,
                plugin.as_mut(),
                &first,
                &sine(3 * BLOCK_FRAMES + 5),
            );
            let written = output.iter().flatten().all(|sample| sample.is_finite());
            assert!(written, "{}", entry.name);
        }
    }

    #[test]
    fn turning_any_parameter_all_the_way_at_once_has_no_click() {
        let input = sine(seconds(1.0));
        for entry in CATALOG {
            for (number, param) in ParamNumber::each(entry.description.params) {
                // Of the change, what a sample may move by: on a ramp, its share; unsmoothed, none, as the parameter
                // must change the sound without a jump, such as a pitch whose wave goes on unbroken.
                let share = match param.smoothing_seconds {
                    0.0 => 0.0,
                    seconds => 1.0 / ramp_samples(seconds, SAMPLE_RATE) as f32,
                };
                for (from, to) in [(param.min, param.max), (param.max, param.min)] {
                    let steady = |value| {
                        let mut plugin = (entry.create)(SAMPLE_RATE);
                        let first = first_block_with_note(entry.description, &[(number, value)]);
                        render(entry.description, plugin.as_mut(), &first, &input)
                    };
                    let (at_from, at_to) = (steady(from), steady(to));
                    // A click is a step beyond the plugin's own at either end plus the share of the change; a hair
                    // over, as a turn by a wave's jump smooths it half for one pitch and half for the other.
                    let limits: [f32; CHANNELS] = std::array::from_fn(|channel| {
                        let (at_from, at_to) = (&at_from[channel], &at_to[channel]);
                        let change = difference(at_from, at_to, 0..at_from.len());
                        largest_step(at_from).max(largest_step(at_to)) * 1.001
                            + change * share
                            + 1e-6
                    });
                    // At a few block starts, so the jump can't hide in a zero crossing.
                    for jump in (90..94).map(|block| block * BLOCK_FRAMES) {
                        let (before, after) = input.split_at(jump);
                        let mut plugin = (entry.create)(SAMPLE_RATE);
                        let first = first_block_with_note(entry.description, &[(number, from)]);
                        let mut output = render(entry.description, plugin.as_mut(), &first, before);
                        let turn = Event::param_at_start(number, to);
                        let rest = render(entry.description, plugin.as_mut(), &[turn], after);
                        for (channel, limit) in limits.into_iter().enumerate() {
                            output[channel].extend(&rest[channel]);
                            let step = largest_step(&output[channel]);
                            assert!(
                                step <= limit,
                                "{} {:?} {from} → {to} at {jump}, channel {channel}: step {step} > {limit}",
                                entry.name,
                                param.id,
                            );
                        }
                    }
                }
            }
        }
    }

    /// The end farther from the default, so a change to it shows.
    fn far_end(param: &ParamDescription) -> f32 {
        if param.default - param.min > param.max - param.default {
            param.min
        } else {
            param.max
        }
    }

    #[test]
    fn a_change_in_the_middle_of_a_block_is_heard_from_its_time() {
        let input = sine(4 * BLOCK_FRAMES);
        let (before, after) = input.split_at(2 * BLOCK_FRAMES);
        // Off any grid a plugin may keep, such as every 16th frame.
        let time = BLOCK_FRAMES / 2 + 7;
        let at = before.len() + time;
        // Early in its first block, so its release is under way by the change.
        let let_go = note_off(u32::try_from(BLOCK_FRAMES / 2).unwrap(), NOTE_NAME);
        for entry in CATALOG {
            let params = || ParamNumber::each(entry.description.params);
            for (number, param) in params() {
                // To the far end and back: a time already gone by, such as a delay, is heard only cut short.
                let turns = [
                    (param.default, far_end(param)),
                    (far_end(param), param.default),
                ];
                let mut heard = false;
                for (from, to) in turns {
                    let event = Event::Param {
                        time: u32::try_from(time).unwrap(),
                        param: number,
                        value: to,
                    };
                    // At the defaults, then with each other parameter at its far end: one of them lets it be heard, as
                    // a mix turned up does an oscillator's tuning. Its note held, then let go of, as a release needs.
                    let others = params().filter(|&(other, _)| other != number);
                    let settings = std::iter::once(None)
                        .chain(others.map(|(other, param)| Some((other, far_end(param)))));
                    for (setting, let_go) in
                        settings.flat_map(|setting| [(setting, None), (setting, Some(let_go))])
                    {
                        let values: Vec<_> =
                            std::iter::once((number, from)).chain(setting).collect();
                        let mut first = first_block_with_note(entry.description, &values);
                        first.extend(let_go);
                        let unchanged = render(
                            entry.description,
                            (entry.create)(SAMPLE_RATE).as_mut(),
                            &first,
                            &input,
                        );
                        let mut plugin = (entry.create)(SAMPLE_RATE);
                        let mut changed =
                            render(entry.description, plugin.as_mut(), &first, before);
                        let rest = render(entry.description, plugin.as_mut(), &[event], after);
                        for (channel, unchanged) in unchanged.iter().enumerate() {
                            changed[channel].extend(&rest[channel]);
                            #[expect(clippy::float_cmp, reason = "any difference counts")]
                            let differs = unchanged
                                .iter()
                                .zip(&changed[channel])
                                .position(|(a, b)| a != b);
                            if let Some(first) = differs {
                                heard = true;
                                assert_eq!(
                                    first,
                                    at,
                                    "{} {:?} {from} → {to} with {setting:?}, let go of: {}, channel {channel}: the \
                                     first sample it changes",
                                    entry.name,
                                    param.id,
                                    let_go.is_some(),
                                );
                            }
                        }
                    }
                }
                assert!(heard, "{} {:?}: never heard", entry.name, param.id);
            }
        }
    }

    #[test]
    fn silence_after_sound_leaves_no_denormal_numbers() {
        // Long enough for the slowest memory to fade past them.
        let mut input = sine(seconds(0.1));
        input.extend(silence(seconds(2.0)));
        for entry in CATALOG {
            let extremes = ParamNumber::each(entry.description.params)
                .flat_map(|(number, param)| [(number, param.min), (number, param.max)]);
            // At the defaults too.
            for setting in std::iter::once(None).chain(extremes.map(Some)) {
                let mut plugin = (entry.create)(SAMPLE_RATE);
                let first = first_block_with_note(entry.description, setting.as_slice());
                let output = render(entry.description, plugin.as_mut(), &first, &input);
                let denormal = output.iter().flatten().any(|sample| sample.is_subnormal());
                assert!(!denormal, "{} with {setting:?}", entry.name);
            }
        }
    }
}
