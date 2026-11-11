//! One number for every description in a catalog. The page holds a copy of the descriptions generated from this
//! crate and its number: when the two differ, the page and the engine come from different builds.

use crate::catalog::CatalogEntry;
use crate::{Choice, ParamDescription, PluginDescription, SampleDescription, Scale, Unit, Values};

/// 32-bit FNV-1a: simple and the same on every build, unlike the standard library's hashers.
struct Fnv(u32);

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ u32::from(byte)).wrapping_mul(0x0100_0193);
        }
    }

    fn number(&mut self, number: u32) {
        self.bytes(&number.to_le_bytes());
    }

    fn float(&mut self, float: f32) {
        self.number(float.to_bits());
    }

    /// Length first, so neighbouring strings can't trade bytes.
    fn text(&mut self, text: &str) {
        self.number(text.len() as u32);
        self.bytes(text.as_bytes());
    }
}

/// Takes every field by name, so a new one doesn't compile until it counts. `node_params` are the ones the engine gives
/// every node of its own, such as its volume.
#[must_use]
pub fn fingerprint(catalog: &[CatalogEntry], node_params: &[ParamDescription]) -> u32 {
    let mut hash = Fnv(0x811c_9dc5);
    hash.number(catalog.len() as u32);
    for entry in catalog {
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
        hash.text(name);
        hash.number(*id);
        hash.number(*version);
        hash.text(label);
        hash.params(params);
        hash.number(samples.len() as u32);
        for sample in *samples {
            let SampleDescription { id, label } = sample;
            hash.text(id);
            hash.text(label);
        }
    }
    hash.params(node_params);
    hash.0
}

impl Fnv {
    fn params(&mut self, params: &[ParamDescription]) {
        self.number(params.len() as u32);
        for param in params {
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
            self.text(id);
            self.text(label);
            match group {
                None => self.number(0),
                Some(group) => {
                    self.number(1);
                    self.text(group);
                }
            }
            self.number(match unit {
                None => 0,
                Some(Unit::Hertz) => 1,
                Some(Unit::Pan) => 2,
                Some(Unit::Gain) => 3,
                Some(Unit::Semitones) => 4,
                Some(Unit::Cents) => 5,
                Some(Unit::Percent) => 6,
                Some(Unit::Seconds) => 7,
            });
            self.number(match scale {
                Scale::Linear => 0,
                Scale::Logarithmic => 1,
                Scale::Volume => 2,
                Scale::Time => 3,
            });
            match values {
                Values::Any => self.number(0),
                Values::Whole => self.number(2),
                Values::Choices(choices) => {
                    self.number(1);
                    self.number(choices.len() as u32);
                    for Choice { id, label } in *choices {
                        self.text(id);
                        self.text(label);
                    }
                }
            }
            for number in [min, max, default, smoothing_seconds] {
                self.float(*number);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tone;

    const PARAM: ParamDescription = ParamDescription {
        id: "cutoff",
        label: "Cutoff",
        group: None,
        unit: Some(Unit::Hertz),
        scale: Scale::Logarithmic,
        values: Values::Any,
        min: 20.0,
        max: 20_000.0,
        default: 1000.0,
        smoothing_seconds: 0.02,
    };

    const TWO: &[Choice] = &[
        Choice {
            id: "low",
            label: "Low",
        },
        Choice {
            id: "high",
            label: "High",
        },
    ];
    const DOUBLED: &[Choice] = &[TWO[0], TWO[0]];
    const RELABELLED: &[Choice] = &[
        TWO[0],
        Choice {
            id: "high",
            label: "Top",
        },
    ];
    const RENAMED: &[Choice] = &[
        TWO[0],
        Choice {
            id: "top",
            label: "High",
        },
    ];

    const SAMPLE: SampleDescription = SampleDescription {
        id: "noise",
        label: "Noise",
    };

    const PLUGIN: PluginDescription = PluginDescription {
        id: 2,
        version: 1,
        label: "Filter",
        params: &[PARAM],
        samples: &[SAMPLE],
    };

    fn of(name: &'static str, description: PluginDescription) -> u32 {
        with_node_params(name, description, &[PARAM])
    }

    fn with_node_params(
        name: &'static str,
        description: PluginDescription,
        node_params: &[ParamDescription],
    ) -> u32 {
        fingerprint(
            &[CatalogEntry {
                name,
                description: Box::leak(Box::new(description)),
                create: tone::create,
            }],
            node_params,
        )
    }

    fn with_param(change: fn(&mut ParamDescription)) -> PluginDescription {
        let mut param = PARAM;
        change(&mut param);
        PluginDescription {
            params: Box::leak(Box::new([param])),
            ..PLUGIN
        }
    }

    fn with_sample(change: fn(&mut SampleDescription)) -> PluginDescription {
        let mut sample = SAMPLE;
        change(&mut sample);
        PluginDescription {
            samples: Box::leak(Box::new([sample])),
            ..PLUGIN
        }
    }

    #[test]
    #[expect(clippy::too_many_lines, reason = "every field there is")]
    fn every_field_changes_the_number() {
        let base = of("filter", PLUGIN);
        let changed = [
            of("filters", PLUGIN),
            of("filter", PluginDescription { id: 3, ..PLUGIN }),
            of(
                "filter",
                PluginDescription {
                    version: 2,
                    ..PLUGIN
                },
            ),
            of(
                "filter",
                PluginDescription {
                    label: "Low-pass",
                    ..PLUGIN
                },
            ),
            of(
                "filter",
                PluginDescription {
                    params: &[],
                    ..PLUGIN
                },
            ),
            of(
                "filter",
                PluginDescription {
                    params: &[PARAM, PARAM],
                    ..PLUGIN
                },
            ),
            of("filter", with_param(|param| param.id = "frequency")),
            of("filter", with_param(|param| param.label = "Frequency")),
            of("filter", with_param(|param| param.group = Some("Osc 1"))),
            of("filter", with_param(|param| param.group = Some(""))),
            of("filter", with_param(|param| param.unit = None)),
            of("filter", with_param(|param| param.scale = Scale::Linear)),
            of("filter", with_param(|param| param.min = 21.0)),
            of("filter", with_param(|param| param.max = 19_000.0)),
            of("filter", with_param(|param| param.default = 1001.0)),
            of("filter", with_param(|param| param.smoothing_seconds = 0.03)),
            of(
                "filter",
                PluginDescription {
                    samples: &[],
                    ..PLUGIN
                },
            ),
            of(
                "filter",
                PluginDescription {
                    samples: &[SAMPLE, SAMPLE],
                    ..PLUGIN
                },
            ),
            of("filter", with_sample(|sample| sample.id = "hiss")),
            of("filter", with_sample(|sample| sample.label = "Hiss")),
            of("filter", with_param(|param| param.unit = Some(Unit::Pan))),
            of("filter", with_param(|param| param.unit = Some(Unit::Gain))),
            of(
                "filter",
                with_param(|param| param.unit = Some(Unit::Semitones)),
            ),
            of("filter", with_param(|param| param.unit = Some(Unit::Cents))),
            of(
                "filter",
                with_param(|param| param.unit = Some(Unit::Percent)),
            ),
            of(
                "filter",
                with_param(|param| param.unit = Some(Unit::Seconds)),
            ),
            of("filter", with_param(|param| param.scale = Scale::Volume)),
            of("filter", with_param(|param| param.scale = Scale::Time)),
            of("filter", with_param(|param| param.values = Values::Whole)),
            of(
                "filter",
                with_param(|param| param.values = Values::Choices(&[])),
            ),
            of(
                "filter",
                with_param(|param| param.values = Values::Choices(TWO)),
            ),
            of(
                "filter",
                with_param(|param| param.values = Values::Choices(DOUBLED)),
            ),
            of(
                "filter",
                with_param(|param| param.values = Values::Choices(RELABELLED)),
            ),
            of(
                "filter",
                with_param(|param| param.values = Values::Choices(RENAMED)),
            ),
            with_node_params("filter", PLUGIN, &[]),
            with_node_params(
                "filter",
                PLUGIN,
                &[ParamDescription {
                    default: 1001.0,
                    ..PARAM
                }],
            ),
        ];
        for (i, number) in changed.into_iter().enumerate() {
            assert_ne!(number, base, "change {i}");
        }
        assert_eq!(of("filter", PLUGIN), base);
    }

    #[test]
    fn neighbouring_texts_can_not_trade_bytes() {
        let a = of(
            "ab",
            PluginDescription {
                label: "c",
                ..PLUGIN
            },
        );
        let b = of(
            "a",
            PluginDescription {
                label: "bc",
                ..PLUGIN
            },
        );
        assert_ne!(a, b);
    }
}
