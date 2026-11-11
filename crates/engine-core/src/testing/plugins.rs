//! Plugins that show what a node does with them.

use std::cell::RefCell;

use engine_plugins::catalog::CatalogEntry;
use engine_plugins::{
    Event, ParamDescription, Plugin, PluginDescription, ProcessContext, SampleDescription, Scale,
    Values,
};

use super::sample_number;

thread_local! {
    pub(crate) static GIVEN: RefCell<Vec<Event>> = const { RefCell::new(Vec::new()) };
}

/// Keeps every event it is given in `GIVEN`, which takes the heap.
struct Recorder;

impl Plugin for Recorder {
    fn process(&mut self, context: ProcessContext<'_>) {
        GIVEN.with_borrow_mut(|given| given.extend(context.events));
        for channel in context.output {
            channel.fill(0.0);
        }
    }
}

const fn param(id: &'static str, default: f32) -> ParamDescription {
    ParamDescription {
        id,
        label: id,
        group: None,
        unit: None,
        scale: Scale::Linear,
        values: Values::Any,
        min: 0.0,
        max: 1.0,
        default,
        smoothing_seconds: 0.0,
    }
}

pub(crate) static RECORDER: CatalogEntry = CatalogEntry {
    name: "recorder",
    description: &PluginDescription {
        id: 1,
        version: 1,
        label: "Recorder",
        params: &[param("low", 0.25), param("high", 0.75)],
        samples: &[],
    },
    create: |_| Box::new(Recorder),
};

/// Plays its input.
struct Through;

impl Plugin for Through {
    fn process(&mut self, context: ProcessContext<'_>) {
        for (output, input) in context.output.into_iter().zip(context.input) {
            output.copy_from_slice(input);
        }
    }
}

pub(crate) static THROUGH: CatalogEntry = CatalogEntry {
    name: "through",
    description: &PluginDescription {
        id: 2,
        version: 1,
        label: "Through",
        params: &[],
        samples: &[],
    },
    create: |_| Box::new(Through),
};

/// Plays 1 on the left and −1 on the right.
struct Constant;

impl Plugin for Constant {
    fn process(&mut self, context: ProcessContext<'_>) {
        let [left, right] = context.output;
        left.fill(1.0);
        right.fill(-1.0);
    }
}

pub(crate) static CONSTANT: CatalogEntry = CatalogEntry {
    name: "constant",
    description: &PluginDescription {
        id: 3,
        version: 1,
        label: "Constant",
        params: &[],
        samples: &[],
    },
    create: |_| Box::new(Constant),
};

/// Plays the first frames of its sample's sound in every block: its first channel on the left, its last on the
/// right; silence past the sound's end and without one.
struct Reader;

impl Plugin for Reader {
    fn process(&mut self, context: ProcessContext<'_>) {
        let [left, right] = context.output;
        left.fill(0.0);
        right.fill(0.0);
        if let Some(frames) = context.samples.frames(sample_number(1), 0..left.len()) {
            let (first, last) = (
                frames.channels()[0],
                frames.channels()[frames.channels().len() - 1],
            );
            left[..frames.len()].copy_from_slice(first);
            right[..frames.len()].copy_from_slice(last);
        }
    }
}

pub(crate) static READER: CatalogEntry = CatalogEntry {
    name: "reader",
    description: &PluginDescription {
        id: 4,
        version: 1,
        label: "Reader",
        params: &[],
        samples: &[SampleDescription {
            id: "sound",
            label: "Sound",
        }],
    },
    create: |_| Box::new(Reader),
};
