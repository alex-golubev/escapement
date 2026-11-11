//! Audio engine core: DSP, sequencer, mixer graph. No web dependencies.

pub mod build;
pub mod commands;
mod engine;
pub mod events;
pub mod framing;
mod graph;
mod handle;
mod handoff;
pub mod heap;
mod node;
pub mod notes;
pub mod pool;
pub mod schema;
mod sequencer;
pub mod strip;
pub mod telemetry;
#[cfg(test)]
mod testing;
pub mod transport;

use engine_plugins::SampleRate;

use build::Builder;

pub use engine::Engine;
pub use engine_plugins::{BLOCK_FRAMES, CHANNELS};

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
