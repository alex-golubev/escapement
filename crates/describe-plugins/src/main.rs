//! Prints the plugin catalog and the parameters of the engine's strip as JSON for `pnpm gen`, which writes them out
//! for TypeScript.

use engine_core::strip::STRIP;
use engine_plugins::catalog::{CATALOG, CatalogEntry};
use engine_plugins::denormal;
use engine_plugins::{
    Choice, ParamDescription, PluginDescription, SampleDescription, Scale, Unit, Values,
    fingerprint,
};
use serde_json::{Value, json};

fn main() {
    let plugins: Vec<_> = CATALOG.iter().map(plugin).collect();
    let strip: Vec<_> = STRIP.iter().map(param).collect();
    // Every unit and scale, used or not, so the page handles each one there is.
    let units: Vec<_> = Unit::ALL.iter().copied().map(unit_name).collect();
    let scales: Vec<_> = Scale::ALL.iter().copied().map(scale_name).collect();
    println!(
        "{}",
        json!({
            "fingerprint": fingerprint(CATALOG, STRIP),
            "units": units,
            "scales": scales,
            "plugins": plugins,
            "strip": strip,
            "silence": decimal(denormal::THRESHOLD),
        })
    );
}

fn unit_name(unit: Unit) -> &'static str {
    match unit {
        Unit::Hertz => "hertz",
        Unit::Pan => "pan",
        Unit::Gain => "gain",
        Unit::Semitones => "semitones",
        Unit::Cents => "cents",
        Unit::Percent => "percent",
        Unit::Seconds => "seconds",
    }
}

fn scale_name(scale: Scale) -> &'static str {
    match scale {
        Scale::Linear => "linear",
        Scale::Logarithmic => "logarithmic",
        Scale::Volume => "volume",
        Scale::Time => "time",
    }
}

// Every field by name, so a new one doesn't compile until it is printed.

fn plugin(entry: &CatalogEntry) -> Value {
    let CatalogEntry {
        name,
        description,
        create: _,
    } = entry;
    let PluginDescription {
        id,
        version,
        label,
        params,
        samples,
    } = description;
    let params: Vec<_> = params.iter().map(param).collect();
    let samples: Vec<_> = samples.iter().map(sample).collect();
    json!({
        "name": name,
        "id": id,
        "version": version,
        "label": label,
        "params": params,
        "samples": samples,
    })
}

fn sample(sample: &SampleDescription) -> Value {
    let SampleDescription { id, label } = sample;
    json!({ "id": id, "label": label })
}

fn param(param: &ParamDescription) -> Value {
    let ParamDescription {
        id,
        label,
        group,
        unit,
        scale,
        values,
        min,
        max,
        default,
        smoothing_seconds,
    } = param;
    let choices = match values {
        Values::Any | Values::Whole => None,
        Values::Choices(choices) => Some(choices.iter().map(choice).collect::<Vec<_>>()),
    };
    json!({
        "id": id,
        "label": label,
        "group": group,
        "unit": unit.map(unit_name),
        "scale": scale_name(*scale),
        "choices": choices,
        "whole": param.whole(),
        "min": decimal(*min),
        "max": decimal(*max),
        "default": decimal(*default),
        "smoothingSeconds": decimal(*smoothing_seconds),
    })
}

fn choice(choice: &Choice) -> Value {
    let Choice { id, label } = choice;
    json!({ "id": id, "label": label })
}

/// The shortest decimal that reads back as the same `f32`: 0.02 rather than 0.019999999552965164.
fn decimal(value: f32) -> f64 {
    // JSON has no infinity or NaN: they would come out as null.
    assert!(value.is_finite(), "{value} is not a finite number");
    value.to_string().parse().expect("Display gives a number")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each plugin's and the strip's, as the page gets them, with where each is.
    fn every_param() -> impl Iterator<Item = (String, &'static ParamDescription)> {
        let plugins = CATALOG.iter().flat_map(|entry| {
            let params = entry.description.params.iter();
            params.map(move |param| (format!("{} {:?}", entry.name, param.id), param))
        });
        let strip = STRIP
            .iter()
            .map(|param| (format!("strip {:?}", param.id), param));
        plugins.chain(strip)
    }

    #[test]
    fn every_parameter_has_a_range_around_its_default_that_its_scale_can_turn() {
        for (at, param) in every_param() {
            let numbers = [param.min, param.max, param.default, param.smoothing_seconds];
            assert!(numbers.iter().all(|n| n.is_finite()), "{at}");
            assert!(param.min < param.max, "{at}");
            assert!((param.min..=param.max).contains(&param.default), "{at}");
            assert!(param.smoothing_seconds >= 0.0, "{at}");
            match param.scale {
                Scale::Linear => {}
                Scale::Logarithmic => {
                    assert!(param.min > 0.0, "{at}: a logarithmic scale starts above 0");
                }
                Scale::Volume => {
                    assert_eq!(param.min, 0.0, "{at}: a volume is silent at the bottom");
                    assert_eq!(
                        param.unit,
                        Some(Unit::Gain),
                        "{at}: a volume reads in decibels"
                    );
                }
                Scale::Time => {
                    assert!(param.min >= 0.0, "{at}: no time below none");
                    assert_eq!(
                        param.unit,
                        Some(Unit::Seconds),
                        "{at}: a time reads in seconds"
                    );
                }
            }
            if param.whole() {
                let ends = [param.min, param.max, param.default];
                assert!(ends.iter().all(|n| n.fract() == 0.0), "{at}: whole");
                assert_eq!(param.scale, Scale::Linear, "{at}: one a step");
            }
            if param.unit == Some(Unit::Percent) {
                assert!(param.min >= 0.0 && param.max <= 1.0, "{at}: of the whole");
            }
            assert_ne!(param.group, Some(""), "{at}: a group without a name");
            match param.values {
                Values::Any | Values::Whole => {}
                Values::Choices(choices) => {
                    assert!(choices.len() >= 2, "{at}: a choice of one is none");
                    assert_eq!(param.min, 0.0, "{at}: the first choice is 0");
                    assert_eq!(
                        param.max,
                        Choice::value(choices.len() - 1),
                        "{at}: the last"
                    );
                    assert_eq!(param.unit, None, "{at}: a choice reads as its label");
                    for choice in choices {
                        let at = format!("{at} {:?}", choice.id);
                        assert!(!choice.id.is_empty() && !choice.label.is_empty(), "{at}");
                        let holders = choices.iter().filter(|other| other.id == choice.id);
                        assert_eq!(holders.count(), 1, "{at}: the ID is taken twice");
                    }
                }
            }
        }
    }

    #[test]
    fn a_group_s_parameters_stand_together() {
        for entry in CATALOG {
            let mut runs: Vec<_> = entry
                .description
                .params
                .iter()
                .map(|param| param.group)
                .collect();
            runs.dedup();
            for group in runs.iter().flatten() {
                let count = runs.iter().filter(|other| **other == Some(*group)).count();
                assert_eq!(count, 1, "{} {group:?}: apart", entry.name);
            }
        }
    }
}
