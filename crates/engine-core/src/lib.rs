//! Audio engine core: DSP, sequencer, mixer graph. No web dependencies.

mod builder;
mod commands;
mod engine;
mod events;
mod framing;
mod graph;
mod handle;
mod handoff;
mod heap;
mod node;
mod notes;
mod pool;
mod schema;
mod sequencer;
mod strip;
mod telemetry;
#[cfg(test)]
mod testing;
mod transport;

pub use builder::Builder;
pub use commands::{CommandInput, INPUT_CAPACITY};
pub use engine::Engine;
pub use engine_plugins::{BLOCK_FRAMES, CHANNELS};
pub use events::{EVENT_CAPACITY, EventOutput};
pub use framing::MAX_MESSAGE;
pub use notes::{HIGHEST_KEY, MAX_VELOCITY, MIN_VELOCITY};
pub use pool::{Hash, SamplePool};
pub use schema::{Rejection, SCHEMA_FINGERPRINT};
pub use strip::STRIP;
pub use telemetry::{METERS, MeterRecord, TELEMETRY_WORDS, Telemetry};
pub use transport::{DEFAULT_TEMPO, MAX_TEMPO, MIN_TEMPO, TICKS_PER_QUARTER};

use engine_plugins::SampleRate;

/// A block of stereo sound, by channel.
pub(crate) type Block = [[f32; BLOCK_FRAMES]; CHANNELS];

pub(crate) const SILENCE: Block = [[0.0; BLOCK_FRAMES]; CHANNELS];

/// The build thread keeps the builder and hands the engine to the audio thread. All of the engine's own memory is
/// allocated here; what grows comes in parcels.
#[must_use]
pub fn new(sample_rate: SampleRate) -> (Builder, Engine) {
    let (build, audio) = handoff::channel();
    (
        Builder::new(sample_rate, build),
        Engine::new(sample_rate, audio),
    )
}

/// Never returns, so the page's recovery from a hung thread can be checked. A test sees it as a panic instead.
fn hang() -> ! {
    #[cfg(test)]
    panic!("hangs");
    #[cfg(not(test))]
    loop {
        std::hint::spin_loop();
    }
}
