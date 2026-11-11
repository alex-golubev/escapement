//! A plugin's static data. A parameter's or a sample's lasting ID is a string; commands and edits address it by
//! number, its place in the description counted from 1, so 0 is none.

#[derive(Clone, Copy, Debug)]
pub struct PluginDescription {
    /// Lasting, never reused; 0 is none.
    pub id: u32,
    /// Matched exactly; 0 is none.
    pub version: u32,
    /// For people, unlike the ID: free to change.
    pub label: &'static str,
    pub params: &'static [ParamDescription],
    pub samples: &'static [SampleDescription],
}

#[derive(Clone, Copy, Debug)]
pub struct ParamDescription {
    /// Projects and automation refer to the parameter by it, so it is never changed or reused: not a label.
    pub id: &'static str,
    /// For people: free to change and to translate.
    pub label: &'static str,
    /// The controls it stands with, for people, such as an oscillator's; its fellows come one after another.
    pub group: Option<&'static str>,
    /// `None` for a plain number.
    pub unit: Option<Unit>,
    pub scale: Scale,
    pub values: Values,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    /// How long a change takes to reach its new value.
    pub smoothing_seconds: f32,
}

/// What a parameter takes: any number in its range, a whole one, or one of a list.
#[derive(Clone, Copy, Debug)]
pub enum Values {
    Any,
    /// Such as semitones.
    Whole,
    /// By place from 0, as projects keep them: a choice is never moved or removed, and new ones come last. The range
    /// runs from the first to the last.
    Choices(&'static [Choice]),
}

#[derive(Clone, Copy, Debug)]
pub struct Choice {
    /// What code calls it, such as the page drawing its picture; never stored, unlike its place.
    pub id: &'static str,
    /// For people: free to change and to translate.
    pub label: &'static str,
}

/// A sound the plugin plays: whoever creates the node names it by its hash.
#[derive(Clone, Copy, Debug)]
pub struct SampleDescription {
    /// Projects refer to the sample by it, so it is never changed or reused: not a label.
    pub id: &'static str,
    /// For people: free to change and to translate.
    pub label: &'static str,
}

/// An enum with the list of all its variants, so the page gets every one, used or not.
macro_rules! listed {
    ($(#[$meta:meta])* pub enum $name:ident { $($(#[$variant_meta:meta])* $variant:ident,)* }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name {
            $($(#[$variant_meta])* $variant,)*
        }

        impl $name {
            pub const ALL: &[Self] = &[$(Self::$variant),*];
        }
    };
}

listed! {
    /// The page writes a value out by its unit, so units come from this list rather than free text.
    pub enum Unit {
        Hertz,
        /// From -1, all the way left, to 1, all the way right.
        Pan,
        /// A multiplier of the sound, read out in decibels: 1 leaves it as it is, 0 silences it.
        Gain,
        Semitones,
        Cents,
        /// From 0 to 1, read out as a share of 100.
        Percent,
        Seconds,
    }
}

listed! {
    /// How a value moves as a knob turns, and as a change is smoothed: evenly in the value, or evenly in octaves.
    /// Projects keep the value itself, so a new scale leaves their values alone but changes how a turn sounds.
    pub enum Scale {
        Linear,
        /// Above 0 only.
        Logarithmic,
        /// A volume knob's: finer near the top, silent at the bottom. Smoothed evenly in the value.
        Volume,
        /// Finer near the bottom, where short times differ most: half way up is 1/16 of the range. Smoothed evenly in
        /// the value.
        Time,
    }
}

/// A list of the description, numbered from 1: a number, the entry it names, and the number of an ID.
macro_rules! numbered {
    ($list:ident: $entry:ty, $one:ident, $all:ident, $number:ident, $missing:literal) => {
        /// `None` for 0 and numbers past the last.
        pub const fn $one(&self, number: u32) -> Option<&'static $entry> {
            let list = self.$list;
            if number == 0 || number as usize > list.len() {
                return None;
            }
            Some(&list[number as usize - 1])
        }

        pub fn $all(&self) -> impl Iterator<Item = (u32, &'static $entry)> {
            (1..).zip(self.$list)
        }

        /// For a plugin's own constants: an ID that isn't there fails the build.
        pub const fn $number(&self, id: &str) -> u32 {
            let list = self.$list;
            let mut index = 0;
            while index < list.len() {
                if same(list[index].id, id) {
                    return index as u32 + 1;
                }
                index += 1;
            }
            panic!($missing)
        }
    };
}

impl ParamDescription {
    /// As the engine takes it: in range, a whole number or a choice the nearest, and 0 far below hearing, so no
    /// denormal reaches a sample; none for what isn't a number.
    #[must_use]
    pub fn taken(&self, value: f32) -> Option<f32> {
        value.is_finite().then(|| {
            let value = value.clamp(self.min, self.max);
            match self.values {
                Values::Any => crate::denormal::flush(value),
                // Halves up, as the page's `Math.round`, so both read a value alike.
                Values::Whole | Values::Choices(_) => (value + 0.5).floor(),
            }
        })
    }

    /// Whole numbers only, such as semitones or a choice's place.
    #[must_use]
    pub const fn whole(&self) -> bool {
        matches!(self.values, Values::Whole | Values::Choices(_))
    }
}

impl PluginDescription {
    numbered!(params: ParamDescription, param, numbered_params, param_number, "no parameter with this ID");
    numbered!(samples: SampleDescription, sample, numbered_samples, sample_number, "no sample with this ID");
}

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;

    const fn param(id: &'static str) -> ParamDescription {
        ParamDescription {
            id,
            label: "Knob",
            group: None,
            unit: None,
            scale: Scale::Linear,
            values: Values::Any,
            min: 0.0,
            max: 1.0,
            default: 0.5,
            smoothing_seconds: 0.0,
        }
    }

    const fn sample(id: &'static str) -> SampleDescription {
        SampleDescription { id, label: "Sound" }
    }

    const DESCRIPTION: PluginDescription = PluginDescription {
        id: 1,
        version: 1,
        label: "Two knobs, two sounds",
        params: &[param("first"), param("second")],
        samples: &[sample("low"), sample("high")],
    };

    #[test]
    fn a_value_is_taken_in_range_and_as_0_far_below_hearing() {
        let pan = ParamDescription {
            min: -1.0,
            ..param("pan")
        };
        assert_eq!(pan.taken(0.25), Some(0.25));
        assert_eq!(pan.taken(-3.0), Some(-1.0));
        assert_eq!(pan.taken(7.0), Some(1.0));
        assert_eq!(pan.taken(1e-6), Some(1e-6));
        for silent in [1e-20, -1e-20, 1e-40] {
            assert_eq!(pan.taken(silent), Some(0.0), "{silent}");
        }
        for nothing in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(pan.taken(nothing), None);
        }
    }

    #[test]
    fn a_choice_is_taken_as_the_nearest() {
        const CHOICES: &[Choice] = &[
            Choice {
                id: "a",
                label: "A",
            },
            Choice {
                id: "b",
                label: "B",
            },
            Choice {
                id: "c",
                label: "C",
            },
        ];
        let choice = ParamDescription {
            values: Values::Choices(CHOICES),
            max: 2.0,
            default: 0.0,
            ..param("choice")
        };
        assert!(choice.whole() && !param("knob").whole());
        for (value, taken) in [
            (1.0, 1.0),
            (1.4, 1.0),
            (1.6, 2.0),
            (-3.0, 0.0),
            (9.0, 2.0),
            (1e-20, 0.0),
        ] {
            assert_eq!(choice.taken(value), Some(taken), "{value}");
        }
        assert_eq!(choice.taken(f32::NAN), None);
    }

    #[test]
    fn a_whole_number_is_taken_as_the_nearest_halves_up_as_the_page_reads_it() {
        let semitones = ParamDescription {
            values: Values::Whole,
            min: -24.0,
            max: 24.0,
            default: 0.0,
            ..param("semitones")
        };
        assert!(semitones.whole());
        for (value, taken) in [
            (-11.5, -11.0),
            (-11.6, -12.0),
            (-0.4, 0.0),
            (2.5, 3.0),
            (2.4, 2.0),
            (-30.0, -24.0),
            (30.0, 24.0),
        ] {
            assert_eq!(semitones.taken(value), Some(taken), "{value}");
        }
    }

    #[test]
    fn parameters_are_numbered_from_1() {
        assert_eq!(DESCRIPTION.param_number("first"), 1);
        assert_eq!(DESCRIPTION.param_number("second"), 2);
        assert_eq!(DESCRIPTION.param(1).map(|p| p.id), Some("first"));
        assert_eq!(DESCRIPTION.param(2).map(|p| p.id), Some("second"));
        let numbers: Vec<_> = DESCRIPTION
            .numbered_params()
            .map(|(n, p)| (n, p.id))
            .collect();
        assert_eq!(numbers, [(1, "first"), (2, "second")]);
    }

    #[test]
    fn there_is_no_parameter_0_or_past_the_last() {
        for number in [0, 3, u32::MAX] {
            assert!(DESCRIPTION.param(number).is_none(), "{number}");
        }
    }

    #[test]
    #[should_panic(expected = "no parameter with this ID")]
    fn an_id_that_is_not_there_has_no_number() {
        DESCRIPTION.param_number("firs");
    }

    #[test]
    fn samples_are_numbered_from_1_apart_from_parameters() {
        assert_eq!(DESCRIPTION.sample_number("low"), 1);
        assert_eq!(DESCRIPTION.sample_number("high"), 2);
        assert_eq!(DESCRIPTION.sample(2).map(|s| s.id), Some("high"));
        let numbers: Vec<_> = DESCRIPTION
            .numbered_samples()
            .map(|(n, s)| (n, s.id))
            .collect();
        assert_eq!(numbers, [(1, "low"), (2, "high")]);
        for number in [0, 3, u32::MAX] {
            assert!(DESCRIPTION.sample(number).is_none(), "{number}");
        }
    }

    #[test]
    #[should_panic(expected = "no sample with this ID")]
    fn a_sample_id_that_is_not_there_has_no_number() {
        DESCRIPTION.sample_number("first");
    }
}
