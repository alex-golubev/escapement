use crate::Sine;

/// Roughly -14 dB, for headphones. The mixer replaces it.
const DEFAULT_GAIN: f32 = 0.2;

/// Concert pitch, and slice 1's entire instrument.
const DEFAULT_FREQUENCY_HZ: f32 = 440.0;

/// The audio graph, which for now is one oscillator behind a gain and a
/// transport.
///
/// Everything the engine can be asked to do is a method here, and none of them
/// know how the asking arrived. The wire encoding lives in
/// `escapement-protocol` and the translation in the worklet, so this crate
/// stays about sound and can be built and tested without either
/// (ARCHITECTURE.md §3).
pub struct Engine {
    sine: Sine,
    gain: f32,
    playing: bool,
    clock: u64,
}

impl Engine {
    /// Stopped, because a transport that has not been started has not been
    /// started — the interface says when (ARCHITECTURE.md §2.4).
    #[must_use]
    pub fn new(sample_rate_hz: f32) -> Self {
        Self {
            sine: Sine::new(DEFAULT_FREQUENCY_HZ, sample_rate_hz),
            gain: DEFAULT_GAIN,
            playing: false,
            clock: 0,
        }
    }

    /// Run the transport from wherever it stands.
    pub fn start(&mut self) {
        self.playing = true;
    }

    /// Stop it. The clock below is the engine's and keeps running; what stops
    /// is the sound.
    ///
    /// Mid-cycle, that is a step to zero and therefore a click. The fix is a
    /// short fade, and it belongs to the mixer rather than to a transport flag.
    pub fn stop(&mut self) {
        self.playing = false;
    }

    /// See [`Sine::set_frequency`] for what happens to a value that is not one.
    pub fn set_frequency(&mut self, hz: f32) {
        self.sine.set_frequency(hz);
    }

    /// Master gain, linear, held below unity — above it a full-scale oscillator
    /// only clips. A value that is not a number leaves the last one standing,
    /// for the reason given in [`Sine::set_frequency`].
    ///
    /// It takes effect at the next quantum with no ramp, so moving it while
    /// playing zippers. Ramps belong to the mixer, with the fade above.
    pub fn set_gain(&mut self, gain: f32) {
        if gain.is_finite() {
            self.gain = gain.clamp(0.0, 1.0);
        }
    }

    /// Renders one block, and moves the clock by it whether or not the
    /// transport is running.
    ///
    /// Overwrites every element of `out`; previous contents are not read. The
    /// length is the caller's, not a constant here — the offline render for
    /// export drives this same engine in blocks of its own choosing.
    pub fn process(&mut self, out: &mut [f32]) {
        if self.playing {
            self.sine.process(out);
            for sample in out.iter_mut() {
                *sample *= self.gain;
            }
        } else {
            out.fill(0.0);
        }

        // Wrapping, so that nothing on this path can panic in a debug build.
        // At 48 kHz the wrap is twelve million years out.
        self.clock = self.clock.wrapping_add(out.len() as u64);
    }

    /// Samples produced since the engine was built. Monotonic, running whether
    /// or not the transport is, and what a scheduled command's moment is
    /// measured against.
    #[must_use]
    pub const fn clock(&self) -> u64 {
        self.clock
    }

    /// What the transport is actually doing, which is what a button should
    /// follow rather than what it was last told.
    #[must_use]
    pub const fn playing(&self) -> bool {
        self.playing
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RENDER_QUANTUM;

    const RATE: f32 = 48_000.0;

    fn quantum(engine: &mut Engine) -> [f32; RENDER_QUANTUM] {
        let mut block = [0.0f32; RENDER_QUANTUM];
        engine.process(&mut block);
        block
    }

    fn peak(block: &[f32]) -> f32 {
        block.iter().fold(0.0f32, |loudest, s| loudest.max(s.abs()))
    }

    #[test]
    fn a_new_engine_is_stopped_and_silent() {
        let mut engine = Engine::new(RATE);
        assert!(!engine.playing());
        assert_eq!(peak(&quantum(&mut engine)), 0.0);
    }

    #[test]
    fn the_clock_runs_whether_or_not_the_transport_does() {
        let mut engine = Engine::new(RATE);
        quantum(&mut engine);
        assert_eq!(engine.clock(), RENDER_QUANTUM as u64);

        engine.start();
        quantum(&mut engine);
        assert_eq!(engine.clock(), 2 * RENDER_QUANTUM as u64);
    }

    #[test]
    fn starting_makes_sound_and_stopping_takes_it_away() {
        let mut engine = Engine::new(RATE);
        engine.start();
        assert!(peak(&quantum(&mut engine)) > 0.0);

        engine.stop();
        assert_eq!(peak(&quantum(&mut engine)), 0.0);
    }

    /// A block written under an earlier command must not be readable through
    /// a later one: `process` overwrites rather than mixes.
    #[test]
    fn a_stopped_engine_overwrites_what_was_in_the_block() {
        let mut engine = Engine::new(RATE);
        let mut block = [0.5f32; RENDER_QUANTUM];
        engine.process(&mut block);
        assert_eq!(peak(&block), 0.0);
    }

    #[test]
    fn the_gain_scales_the_output() {
        let mut engine = Engine::new(RATE);
        engine.start();
        engine.set_gain(1.0);
        let loud = peak(&quantum(&mut engine));

        engine.set_gain(0.5);
        let half = peak(&quantum(&mut engine));

        assert!((half / loud - 0.5).abs() < 0.01, "{loud} then {half}");
    }

    /// Against a second engine rather than against a remembered peak: two
    /// quanta of the same tone do not peak at the same sample, so a peak is not
    /// a thing to compare across blocks.
    #[test]
    fn a_gain_that_is_not_one_leaves_the_last_good_one_standing() {
        let mut untouched = Engine::new(RATE);
        let mut poisoned = Engine::new(RATE);
        untouched.start();
        poisoned.start();

        poisoned.set_gain(f32::NAN);

        assert_eq!(
            quantum(&mut untouched),
            quantum(&mut poisoned),
            "NaN was believed"
        );
    }

    #[test]
    fn the_gain_is_held_between_silence_and_unity() {
        let mut engine = Engine::new(RATE);
        engine.start();

        engine.set_gain(10.0);
        assert!(peak(&quantum(&mut engine)) <= 1.0);

        engine.set_gain(-1.0);
        assert_eq!(peak(&quantum(&mut engine)), 0.0);
    }

    /// Stop leaves the position where it is, so resuming continues the tone
    /// rather than restarting it — a restart would be an audible click at every
    /// stop and start.
    #[test]
    fn stopping_and_starting_again_continues_where_it_left_off() {
        let mut uninterrupted = Engine::new(RATE);
        let mut stopped = Engine::new(RATE);
        uninterrupted.start();
        stopped.start();
        quantum(&mut uninterrupted);
        quantum(&mut stopped);

        stopped.stop();
        quantum(&mut stopped);
        stopped.start();

        assert_eq!(
            quantum(&mut uninterrupted),
            quantum(&mut stopped),
            "the stop was audible in the phase"
        );
    }
}
