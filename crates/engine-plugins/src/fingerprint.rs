//! One number for every description in a catalog. The page holds a copy of the descriptions generated from this
//! crate and its number: when the two differ, the page and the engine come from different builds.

use crate::catalog::CatalogEntry;
use crate::{Choice, ParamDescription, PluginDescription, SampleDescription, Values};

/// 32-bit FNV-1a: simple and the same on every build, unlike the standard library's hashers.
struct Fnv(u32);

impl Fnv {
    const fn new() -> Self {
        Self(0x811c_9dc5)
    }

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

    /// In 32 bits, so a 64-bit build counts as wasm does: a description's lists and texts are short.
    fn length(&mut self, length: usize) {
        self.number(u32::try_from(length).expect("a length below 2³²"));
    }

    /// Length first, so neighbouring strings can't trade bytes.
    fn text(&mut self, text: &str) {
        self.length(text.len());
        self.bytes(text.as_bytes());
    }

    fn params(&mut self, params: &[ParamDescription]) {
        self.length(params.len());
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
            // A unit or a scale by its place in its list, a unit's after 0 for none.
            self.number(unit.map_or(0, |unit| unit as u32 + 1));
            self.number(*scale as u32);
            match values {
                Values::Any => self.number(0),
                Values::Whole => self.number(2),
                Values::Choices(choices) => {
                    self.number(1);
                    self.length(choices.len());
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

/// Takes every field by name, so a new one doesn't compile until it counts. `node_params` are the ones the engine gives
/// every node of its own, such as its volume.
#[must_use]
pub fn fingerprint(catalog: &[CatalogEntry], node_params: &[ParamDescription]) -> u32 {
    let mut hash = Fnv::new();
    hash.length(catalog.len());
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
        hash.length(samples.len());
        for sample in *samples {
            let SampleDescription { id, label } = sample;
            hash.text(id);
            hash.text(label);
        }
    }
    hash.params(node_params);
    hash.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tone;
    use crate::{Scale, Unit};

    #[test]
    fn neighbouring_texts_cannot_trade_bytes() {
        let hash = |texts: &[&str]| {
            let mut hash = Fnv::new();
            for text in texts {
                hash.text(text);
            }
            hash.0
        };
        assert_ne!(hash(&["ab", "c"]), hash(&["a", "bc"]));
    }

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

    fn with_param(change: impl FnOnce(&mut ParamDescription)) -> PluginDescription {
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
    fn every_field_changes_the_number() {
        let base = of("filter", PLUGIN);
        let mut changed = vec![
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
        // Every other unit and scale.
        let units = Unit::ALL
            .into_iter()
            .filter(|&unit| Some(unit) != PARAM.unit);
        changed.extend(units.map(|unit| of("filter", with_param(|param| param.unit = Some(unit)))));
        let scales = Scale::ALL.into_iter().filter(|&scale| scale != PARAM.scale);
        changed.extend(scales.map(|scale| of("filter", with_param(|param| param.scale = scale))));
        for (i, number) in changed.into_iter().enumerate() {
            assert_ne!(number, base, "change {i}");
        }
        assert_eq!(of("filter", PLUGIN), base);
    }
}
