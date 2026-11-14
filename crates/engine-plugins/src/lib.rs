//! What a plugin sees, and the built-in plugins. The engine depends on this crate and never the other way round, so
//! a plugin can't reach past [`Plugin`] into the engine.

pub mod catalog;
pub mod denormal;
mod description;
pub mod envelope;
mod events;
mod fingerprint;
mod sample_rate;
mod samples;
pub mod smoothing;
#[cfg(test)]
mod testing;
mod voices;

pub use description::{
    Choice, ParamDescription, ParamNumber, PluginDescription, SampleDescription, SampleNumber,
    Scale, Unit, Values,
};
pub use events::{Event, NoteId, Step, steps};
pub use fingerprint::fingerprint;
pub use sample_rate::SampleRate;
pub use samples::{Frames, SampleReader};

/// The Web Audio render quantum: no block is longer.
pub const BLOCK_FRAMES: usize = 128;
/// Every node is stereo, like the engine's output.
pub const CHANNELS: usize = 2;

/// A block of a node's audio.
pub struct ProcessContext<'a> {
    /// The sum of the node's incoming connections; silence without any. At most [`BLOCK_FRAMES`] long.
    pub input: [&'a [f32]; CHANNELS],
    /// As long as the input; the plugin writes every sample.
    pub output: [&'a mut [f32]; CHANNELS],
    /// What happens during the block, in time order: [`steps`] walks through it.
    pub events: &'a [Event],
    pub samples: &'a mut dyn SampleReader,
}

/// What sits in a node's slot. The first block starts with every parameter's value, so values that come before the
/// first sample must apply at once. The audio thread calls `process`, which must not touch the heap.
pub trait Plugin: Send {
    fn process(&mut self, context: ProcessContext<'_>);
}
