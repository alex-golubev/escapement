use escapement_time::SampleRate;

use crate::{Player, Samples, Sine};

/// Roughly -14 dB, for headphones. The mixer replaces it.
///
/// Public because the interface's controls have to start where the engine
/// already is. A literal in the markup instead is a second copy of this number,
/// and every export taken before that control is touched then differs from what
/// was heard, with nothing wrong anywhere to point at.
pub const DEFAULT_GAIN: f32 = 0.2;

/// Concert pitch, and slice 1's entire instrument. Public for the reason
/// [`DEFAULT_GAIN`] is.
pub const DEFAULT_FREQUENCY_HZ: f32 = 440.0;

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
    player: Player,
    gain: f32,
    playing: bool,
    clock: u64,
}

impl Engine {
    /// Stopped, because a transport that has not been started has not been
    /// started — the interface says when (ARCHITECTURE.md §2.4).
    ///
    /// Takes a [`SampleRate`] rather than a number: this is where the engine
    /// meets the clock (§2.5), and the rate arrives from a host that is not this
    /// program. Refusing one that is not a rate has to happen before anything
    /// divides by it, and nothing further in has an error to report.
    #[must_use]
    pub fn new(rate: SampleRate) -> Self {
        Self {
            sine: Sine::new(DEFAULT_FREQUENCY_HZ, rate),
            player: Player::new(),
            gain: DEFAULT_GAIN,
            playing: false,
            clock: 0,
        }
    }

    /// Run the transport from wherever it stands.
    ///
    /// Which for a published sample is the beginning, because [`Engine::rewind`]
    /// is what starting means while there is one position to start from.
    pub fn start(&mut self) {
        self.playing = true;
        self.rewind();
    }

    /// Back to the beginning of what is being played.
    ///
    /// A transport method rather than one about the source, which is what lets
    /// the worklet call it on a publication without knowing what a player is:
    /// new material is played from its beginning, and the alternative is a
    /// cursor left wherever the last source ran out — silence, with nothing
    /// wrong anywhere. When there is a timeline this becomes a seek to its
    /// start rather than the only position there is.
    ///
    /// The oscillator is not rewound with it: its phase is a continuation
    /// rather than a position, and stopping and starting mid-tone must not
    /// click.
    pub fn rewind(&mut self) {
        self.player.rewind();
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
    /// `samples` is what the interface has published, if anything: the engine
    /// plays that when it is there and the oscillator when it is not. One
    /// branch standing in for a graph, and it goes when the mixer arrives with
    /// something to route between.
    ///
    /// Overwrites every element of `out`; previous contents are not read. The
    /// length is the caller's, not a constant here — the offline render for
    /// export drives this same engine in blocks of its own choosing.
    pub fn process<S: Samples>(&mut self, samples: Option<&S>, out: &mut [f32]) {
        if self.playing {
            match samples {
                Some(samples) => self.player.process(samples, out),
                None => self.sine.process(out),
            }
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

    /// The gain it is applying. Not what [`Engine::set_gain`] was last handed:
    /// that one clamps, and refuses a value that is not a number by leaving the
    /// one before it standing — so what is heard is a function of every command
    /// so far, which nobody outside can replay.
    #[must_use]
    pub const fn gain(&self) -> f32 {
        self.gain
    }

    /// The frequency it is producing, for the reason [`Engine::gain`] gives —
    /// [`Sine::set_frequency`] refuses the same way.
    #[must_use]
    pub const fn frequency_hz(&self) -> f32 {
        self.sine.frequency_hz()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{rate, rising_zero_crossings, RATE_HZ};
    use crate::{Frames, RENDER_QUANTUM};

    /// Nothing published, spelled once: `None` needs a type even where there is
    /// no value, and repeating the turbofish at every call site would read as
    /// though the type mattered.
    const NOTHING: Option<&Frames<'static>> = None;

    fn quantum(engine: &mut Engine) -> [f32; RENDER_QUANTUM] {
        let mut block = [0.0f32; RENDER_QUANTUM];
        engine.process(NOTHING, &mut block);
        block
    }

    fn peak(block: &[f32]) -> f32 {
        block.iter().fold(0.0f32, |loudest, s| loudest.max(s.abs()))
    }

    #[test]
    fn a_new_engine_is_stopped_and_silent() {
        let mut engine = Engine::new(rate());
        assert!(!engine.playing());
        assert_eq!(peak(&quantum(&mut engine)), 0.0);
    }

    #[test]
    fn the_clock_runs_whether_or_not_the_transport_does() {
        let mut engine = Engine::new(rate());
        quantum(&mut engine);
        assert_eq!(engine.clock(), RENDER_QUANTUM as u64);

        engine.start();
        quantum(&mut engine);
        assert_eq!(engine.clock(), 2 * RENDER_QUANTUM as u64);
    }

    #[test]
    fn starting_makes_sound_and_stopping_takes_it_away() {
        let mut engine = Engine::new(rate());

        engine.start();
        assert!(engine.playing());
        assert!(peak(&quantum(&mut engine)) > 0.0);

        engine.stop();
        assert!(!engine.playing());
        assert_eq!(peak(&quantum(&mut engine)), 0.0);
    }

    /// That the engine hands a frequency on to the oscillator rather than
    /// keeping it — the counting is `Sine`'s business and tested there, so what
    /// this asks is only whether the value arrives.
    #[test]
    fn a_new_frequency_reaches_the_oscillator() {
        let mut engine = Engine::new(rate());
        engine.start();
        engine.set_frequency(200.0);

        let mut one_second = [0.0f32; RATE_HZ];
        engine.process(NOTHING, &mut one_second);

        assert_eq!(rising_zero_crossings(&one_second), 200);
    }

    /// What the engine reports is what it is playing, and after a value it
    /// refused that is the one before it. Anything rebuilding this engine from
    /// the commands it was sent — the offline render — lands on its default
    /// instead, and the file stops being what was heard.
    #[test]
    fn a_refused_command_leaves_the_engine_reporting_what_it_kept() {
        let mut engine = Engine::new(rate());

        engine.set_frequency(200.0);
        engine.set_gain(0.5);
        assert_eq!(engine.frequency_hz(), 200.0);
        assert_eq!(engine.gain(), 0.5);

        // Past Nyquist, and not a number: neither reaches the engine, and
        // neither is the default this engine started from.
        engine.set_frequency(RATE_HZ as f32);
        engine.set_gain(f32::NAN);
        assert_eq!(engine.frequency_hz(), 200.0);
        assert_eq!(engine.gain(), 0.5);
    }

    /// And a gain it takes but narrows is reported narrowed.
    #[test]
    fn a_clamped_gain_is_reported_as_the_engine_holds_it() {
        let mut engine = Engine::new(rate());
        engine.set_gain(4.0);

        assert_eq!(engine.gain(), 1.0);
    }

    /// A block written under an earlier command must not be readable through
    /// a later one: `process` overwrites rather than mixes.
    #[test]
    fn a_stopped_engine_overwrites_what_was_in_the_block() {
        let mut engine = Engine::new(rate());
        let mut block = [0.5f32; RENDER_QUANTUM];
        engine.process(NOTHING, &mut block);
        assert_eq!(peak(&block), 0.0);
    }

    /// The published frames are what is heard, not the oscillator behind them.
    /// A half-scale block at unity gain comes back at half scale; the tone it
    /// replaced would come back at one.
    #[test]
    fn published_frames_are_played_instead_of_the_oscillator() {
        let mut engine = Engine::new(rate());
        engine.set_gain(1.0);
        engine.start();

        let held = [0.5; RENDER_QUANTUM];
        let samples = Frames::new(&held, 1);
        let mut block = [0.0f32; RENDER_QUANTUM];
        engine.process(Some(&samples), &mut block);

        assert_eq!(block, [0.5; RENDER_QUANTUM]);
    }

    /// Starting is what rewinds the player, so a sample that has run out plays
    /// again rather than leaving the transport running over silence. Until
    /// there is a timeline there is one position to start from.
    #[test]
    fn starting_again_plays_a_finished_sample_from_its_beginning() {
        let mut engine = Engine::new(rate());
        engine.set_gain(1.0);
        engine.start();

        let held = [0.5; 4];
        let samples = Frames::new(&held, 1);
        let mut block = [0.0f32; RENDER_QUANTUM];

        engine.process(Some(&samples), &mut block);
        assert_eq!(peak(&block[4..]), 0.0, "the sample ran past its end");

        engine.start();
        engine.process(Some(&samples), &mut block);
        assert_eq!(peak(&block[..4]), 0.5, "starting did not rewind");
    }

    #[test]
    fn the_gain_scales_the_output() {
        let mut engine = Engine::new(rate());
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
        let mut untouched = Engine::new(rate());
        let mut poisoned = Engine::new(rate());
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
        let mut engine = Engine::new(rate());
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
        let mut uninterrupted = Engine::new(rate());
        let mut stopped = Engine::new(rate());
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
