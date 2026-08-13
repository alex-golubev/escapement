//! Primitives shared by everything that touches samples.
//!
//! None of them exist because the arithmetic was hard. They exist because the
//! same two dangers arrive at every door in the engine, and answering them
//! once per door is how the answers drift apart.
//!
//! # The two dangers, argued here and nowhere else
//!
//! **A non-finite value is permanent.** One NaN multiplied into a feedback path
//! stays there: the filter state never recovers, the track is silent until the
//! engine is rebuilt. It cannot be clamped away either — `f32::clamp` returns
//! NaN for a NaN input, being neither below the low bound nor above the high
//! one — so every guard below tests for it separately, before any range is
//! considered.
//!
//! **A denormal is expensive.** WASM has no FPU-level flush-to-zero: the x86
//! MXCSR flags native plugins use are unreachable, and the spec requires IEEE
//! 754 denormals to be handled properly, which browsers may not opt out of.
//! Arithmetic on them costs an order of magnitude, and the symptom is
//! distinctive and misleading — CPU climbing *during silence*, once the sound
//! has already died away. The house rule names feedback state as the source,
//! and that is where it is usually made; but `1e-40` is finite and inside every
//! range anyone would check, so a value that small crossing the ABI lands in a
//! multiplier and produces denormal products on every frame from then on, with
//! no feedback involved at all. A slider cannot produce such a value; a project
//! file, a MIDI controller and an automation curve can.
//!
//! # Two doors, because there are two answers
//!
//! [`clamped`] is for a parameter: it has a range, and there is somebody to
//! refuse. [`sanitized`] is for sample data: it has no range — a value above
//! unity is a legitimate sample — and nobody to refuse to, since the values
//! arrive by the thousand from across the ABI. They are not one function with
//! an argument; they are two answers, and the difference has to be visible at
//! the call.

/// Denormal flush threshold.
///
/// Room to spare rather than tuned: `f32` denormals begin below 1.2e-38, so
/// cutting at 1e-20 covers the products too — no sample times a multiplier that
/// small is audible, whatever the sample.
const DENORMAL_THRESHOLD: f32 = 1e-20;

/// Flush denormals to zero. The narrowest of the three guards: it answers only
/// the second danger, for callers that have already ruled out the first.
#[inline(always)]
pub fn fz(x: f32) -> f32 {
    if x.abs() < DENORMAL_THRESHOLD { 0.0 } else { x }
}

/// Make one sample of audio data safe to multiply.
///
/// Non-finite becomes silence rather than a refusal, and that is the whole
/// difference from [`clamped`]. Sample data arrives in blocks of hundreds of
/// thousands with no per-value channel to report on, so there is nobody to
/// refuse to; and one zeroed frame costs a click where dropping the sample
/// costs a track.
#[inline(always)]
pub fn sanitized(x: f32) -> f32 {
    if x.is_finite() { fz(x) } else { 0.0 }
}

/// Take a parameter from across the ABI, or refuse it.
///
/// Refusing rather than substituting, because a parameter has a caller that can
/// leave the previous value standing — which is the right answer to a value
/// that means nothing. Clamping the range is a guard and not a channel: a UI
/// sending out-of-range values has a bug, and it is not told.
pub fn clamped(value: f32, low: f32, high: f32) -> Option<f32> {
    value.is_finite().then(|| fz(value.clamp(low, high)))
}

/// The longest a ramp may be.
///
/// One second at 768 kHz, the highest rate any audio device reports. Every
/// legitimate pairing of a duration in this crate with a rate a device could
/// name lands orders of magnitude below it; only a rate no hardware has can
/// reach it.
const MAX_RAMP_FRAMES: u32 = 768_000;

/// A duration in frames, bounded at both ends.
///
/// Every ramp in the engine is written in seconds and run in frames, and the
/// sample rate it is converted through is whatever the audio device said — so
/// it is input, like everything else that arrives from outside.
///
/// **Both bounds guard the same failure from opposite sides, and the upper one
/// is the surprise.** A rate of zero gives a length of zero and a division by
/// zero in the ramp. But `as` saturates upward as well as downward: an infinite
/// rate, or merely an enormous one, arrives here as `u32::MAX`. That is not a
/// crash and not a NaN — it is a ramp four billion frames long, which is a fader
/// that never reaches its target and a voice that never finishes releasing and
/// so never returns to the pool. Silent, permanent, and attributed to anything
/// but the sample rate.
///
/// Neither end is hypothetical from here: [`engine_new`](crate::engine_new)
/// deliberately places no ceiling on the rate, having nothing left that
/// allocates by it, so an absurd rate reaches this function and is answered
/// here rather than three layers up.
pub fn frames_for(seconds: f64, sample_rate: f64) -> u32 {
    // NaN converts to 0 and lands on the floor; infinity converts to u32::MAX
    // and lands on the ceiling. Both answers are abrupt, which is the right
    // answer to a rate that means nothing.
    ((seconds * sample_rate) as u32).clamp(1, MAX_RAMP_FRAMES)
}

/// How long a smoothed parameter takes to travel to a new target.
const SMOOTHING_SECONDS: f64 = 0.01;

/// A parameter that slides to its target rather than jumping to it.
///
/// A stepped gain, cutoff or pan is zipper noise — the house rule is that every
/// controlled parameter is interpolated per frame, and this is what does it.
///
/// **A linear ramp, not a one-pole**, and that is a correction rather than a
/// preference. The one-pole was written first, as the more idiomatic of the two
/// the house rules allow, and it does not arrive in `f32`: as the remaining
/// distance shrinks, the per-frame increment `delta × coeff` eventually falls
/// below half an ulp of `current` and rounds away to nothing. The value simply
/// stops. Measured here, gliding to 0.5 at 48 kHz with a 10 ms constant, it
/// froze at 0.5000143 — 2.9e-5 off, from where no threshold small enough to be
/// inaudible is ever reached. Everything downstream inherits that: "gain 0.5"
/// is not half, and only an exact comparison catches it, because the error is
/// far too small to hear.
///
/// The ramp has no such failure. The value is recomputed from the target and
/// the frames still to go rather than accumulated, so error cannot pile up and
/// the last frame lands on the target exactly, by construction.
///
/// It also settles the denormal question by removing it: this type holds no
/// feedback state — `current` is either equal to the target or derived from it
/// afresh — so there is nothing here that can decay into the denormal range,
/// and `fz` would be guarding a condition that cannot arise.
#[derive(Debug, Clone)]
pub struct Smoothed {
    current: f32,
    target: f32,
    /// Distance covered per frame while a ramp is running.
    step: f32,
    /// Frames left in the current ramp; zero means settled.
    remaining: u32,
    /// Ramp length in frames, from the sample rate.
    frames: u32,
}

impl Smoothed {
    pub fn new(value: f32, sample_rate: f64) -> Self {
        let frames = frames_for(SMOOTHING_SECONDS, sample_rate);
        Self { current: value, target: value, step: 0.0, remaining: 0, frames }
    }

    /// Where the parameter is headed — what the UI last asked for, not what
    /// the current frame will be multiplied by.
    pub fn target(&self) -> f32 {
        self.target
    }

    /// Aim at a new value. The division happens here, once per command, and
    /// never in the per-frame path.
    pub fn set(&mut self, target: f32) {
        self.target = target;
        self.step = (target - self.current) / self.frames as f32;
        self.remaining = self.frames;
    }

    /// Jump to a value, with no glide. For construction and `reset` only:
    /// using it on a parameter change is the zipper noise this type exists to
    /// avoid.
    pub fn snap_to(&mut self, value: f32) {
        self.current = value;
        self.target = value;
        self.step = 0.0;
        self.remaining = 0;
    }

    /// The value for one frame. Called once per frame, per parameter.
    #[inline]
    pub fn tick(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            // Backwards from the target rather than forwards from the last
            // value: the final frame is `target - step × 0`, which is the
            // target itself and not a sum of several hundred roundings.
            self.current = self.target - self.step * self.remaining as f32;
        }
        self.current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// Every value that has to be kept out of a multiplier, in one place.
    ///
    /// Enumerated here and not at the four doors that use these guards. Each of
    /// those has its own property to state — that a refusal leaves the previous
    /// value standing, that a flushed velocity is not a struck step — and none
    /// of them has anything to add about the inputs themselves.
    const DANGEROUS: &[f32] = &[
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        1e-40,
        -1e-40,
        f32::MIN_POSITIVE / 2.0,
    ];

    #[test]
    fn fz_clears_denormals_and_leaves_everything_else() {
        assert_eq!(fz(1e-30), 0.0);
        assert_eq!(fz(-1e-30), 0.0);
        assert_eq!(fz(0.0), 0.0);
        assert_eq!(fz(1e-10), 1e-10);
        assert_eq!(fz(-0.5), -0.5);
        assert_eq!(fz(1.0), 1.0);
    }

    #[test]
    fn sample_data_that_cannot_be_multiplied_becomes_silence() {
        // The answer for values with no range and no caller to refuse to. Both
        // dangers land on the same result here, and that is the point: the
        // sweep over a loaded sample cannot branch per value.
        for &bad in DANGEROUS {
            assert_eq!(sanitized(bad), 0.0, "sanitized({bad:e}) still multiplies");
        }
    }

    #[test]
    fn sample_data_keeps_everything_it_is_allowed_to() {
        // No range, deliberately: a sample above unity is loud, not wrong, and
        // clamping it here would quietly reshape whatever was loaded.
        for good in [0.0f32, 1.0, -1.0, 4.0, -4.0, 1e-10, 1e30] {
            assert_eq!(sanitized(good), good, "sanitized({good:e}) altered a legal sample");
        }
    }

    #[test]
    fn a_parameter_that_cannot_be_multiplied_is_refused_or_flushed() {
        // The two dangers get different answers here, unlike in `sanitized`,
        // and the difference is the reason both are enumerated: non-finite has
        // no value to stand in for it, a denormal has exactly one — zero.
        for &bad in DANGEROUS {
            let taken = clamped(bad, 0.0, 2.0);
            if bad.is_finite() {
                assert_eq!(taken, Some(0.0), "clamped({bad:e}) reached a multiplier");
            } else {
                assert_eq!(taken, None, "clamped({bad:e}) was let through");
            }
        }
    }

    #[test]
    fn a_parameter_outside_its_range_is_clamped_rather_than_refused() {
        // Deliberately not symmetric with the refusal above. An out-of-range
        // value still names a direction — loudest, hard left — and answering it
        // with the nearest legal value is closer to what was meant than
        // answering with nothing.
        assert_eq!(clamped(3.0, 0.0, 2.0), Some(2.0));
        assert_eq!(clamped(-3.0, 0.0, 2.0), Some(0.0));
        assert_eq!(clamped(-2.0, -1.0, 1.0), Some(-1.0));
        assert_eq!(clamped(0.5, 0.0, 2.0), Some(0.5));
        // The bounds themselves are inside the range.
        assert_eq!(clamped(0.0, 0.0, 2.0), Some(0.0));
        assert_eq!(clamped(2.0, 0.0, 2.0), Some(2.0));
    }

    #[test]
    fn a_duration_is_a_whole_number_of_frames_at_the_rate_it_is_given() {
        assert_eq!(frames_for(0.01, SR), 480);
        assert_eq!(frames_for(0.002, SR), 96);
        assert_eq!(frames_for(0.01, 44_100.0), 441);
        assert_eq!(frames_for(0.01, 96_000.0), 960);
    }

    #[test]
    fn a_rate_that_means_nothing_gives_an_abrupt_ramp_at_either_end() {
        // Both bounds, because both are reachable and only one is obvious. Zero
        // and negative and NaN collapse to a single frame — an instant
        // parameter. Infinity and an absurd-but-finite rate saturate *upward*
        // through `as`, and a ramp of `u32::MAX` frames is the failure worth
        // naming: not a crash, but a fader that never arrives and a voice that
        // never leaves the pool.
        for rate in [0.0, -48_000.0, f64::NAN, f64::NEG_INFINITY] {
            assert_eq!(frames_for(0.01, rate), 1, "sample_rate={rate}");
        }
        for rate in [f64::INFINITY, 1e12, f64::MAX] {
            let frames = frames_for(0.01, rate);
            assert!(frames <= MAX_RAMP_FRAMES, "sample_rate={rate} gave {frames} frames");
        }
        assert_eq!(frames_for(0.0, SR), 1, "a zero duration is still one frame");
    }

    #[test]
    fn every_rate_a_device_could_report_passes_through_untouched() {
        // The ceiling must not be reachable by anything real, or it would be
        // silently shortening ramps on legitimate hardware — which is the same
        // stuck-parameter bug, arriving from the direction of the fix.
        for rate in [8_000.0, 44_100.0, 48_000.0, 96_000.0, 192_000.0, 768_000.0] {
            for seconds in [0.002, 0.01, 1.0] {
                let frames = frames_for(seconds, rate);
                assert_eq!(
                    frames,
                    (seconds * rate) as u32,
                    "{seconds}s at {rate} Hz was clamped"
                );
            }
        }
    }

    #[test]
    fn a_new_parameter_is_already_at_its_value() {
        // Construction is not a change: an engine built with gain 1.0 must
        // render at 1.0 from the first frame, not fade up to it.
        let mut gain = Smoothed::new(0.75, SR);
        assert_eq!(gain.tick(), 0.75);
        assert_eq!(gain.target(), 0.75);
    }

    #[test]
    fn a_new_target_is_approached_rather_than_taken() {
        let mut gain = Smoothed::new(1.0, SR);
        gain.set(0.0);

        // The size of the first step is the whole point: a jump straight to
        // the target is the zipper noise, and one 480th of the distance is
        // what 10 ms at 48 kHz comes to.
        let first = gain.tick();
        assert!(first < 1.0, "the parameter did not move");
        assert!(first > 0.99, "the parameter jumped: {first}");
    }

    #[test]
    fn the_target_is_reached_exactly_and_stays() {
        // Exactly, not nearly: "gain 0" has to be silence, and every test
        // downstream that asks whether the output is silent is an equality
        // rather than a tolerance because of this one.
        let mut gain = Smoothed::new(1.0, SR);
        gain.set(0.0);

        let mut frames = 0;
        while gain.tick() != 0.0 {
            frames += 1;
            assert!(frames < 48_000, "one second was not enough to reach the target");
        }
        assert_eq!(gain.tick(), 0.0, "the parameter left a target it had reached");
    }

    #[test]
    fn a_glide_that_ends_far_from_zero_still_lands_on_its_target() {
        // The defect that decided the shape of this type, kept as a test
        // because nothing else in the repository would have shown it. A
        // one-pole stalls here: approaching 0.5, the per-frame increment falls
        // below half an ulp of the value and rounds to nothing, leaving the
        // parameter at 0.5000143 forever. Gliding to zero hides it — ulps near
        // zero are tiny, so that direction converges fine — which is why the
        // target here is deliberately not zero.
        for target in [0.5f32, 0.75, 1.5, 2.0, -0.5] {
            let mut param = Smoothed::new(1.0, SR);
            param.set(target);
            for _ in 0..SR as usize {
                param.tick();
            }
            assert_eq!(param.tick(), target, "stalled short of {target}");
        }
    }

    #[test]
    fn the_glide_lasts_the_time_it_advertises() {
        // 10 ms at 48 kHz is 480 frames. Stated as an exact count because the
        // ramp makes it exact — and because a glide quietly ten times longer
        // than intended is a fader that feels broken with nothing to point at.
        let mut gain = Smoothed::new(0.0, SR);
        gain.set(1.0);

        let mut frames = 0;
        while gain.tick() != 1.0 {
            frames += 1;
            assert!(frames <= 480, "the glide overran its length");
        }
        assert_eq!(frames, 479, "the glide is not 480 frames long");
    }

    #[test]
    fn retargeting_mid_glide_starts_from_where_it_got_to() {
        // The normal case, not an edge one: a fader drag retargets every few
        // milliseconds. What must not happen is a jump at the moment of
        // retargeting — the value keeps moving from wherever it was.
        let mut gain = Smoothed::new(1.0, SR);
        gain.set(0.0);
        for _ in 0..100 {
            gain.tick();
        }

        let before = gain.tick();
        gain.set(1.0);
        let after = gain.tick();

        assert!(after > before, "the parameter did not turn around");
        assert!(after - before < 0.01, "retargeting produced a step: {before} → {after}");
    }

    #[test]
    fn the_value_never_overshoots_its_target() {
        for (from, to) in [(0.0f32, 1.0f32), (1.0, 0.0), (0.2, 0.9), (2.0, -1.0)] {
            let mut param = Smoothed::new(from, SR);
            param.set(to);
            for _ in 0..10_000 {
                let value = param.tick();
                assert!(value.is_finite(), "non-finite value gliding {from} → {to}");
                let (low, high) = if from < to { (from, to) } else { (to, from) };
                assert!(value >= low && value <= high, "{value} is outside {low}..{high}");
            }
        }
    }

    #[test]
    fn snapping_moves_both_ends() {
        // `reset` uses this, and a snap that moved only the current value
        // would leave the old target to glide back to.
        let mut gain = Smoothed::new(1.0, SR);
        gain.set(0.0);
        gain.tick();
        gain.snap_to(0.5);

        assert_eq!(gain.target(), 0.5);
        assert_eq!(gain.tick(), 0.5);
    }

    #[test]
    fn the_glide_is_the_same_length_at_any_sample_rate() {
        // The ramp length is in frames but derived from the rate, for this
        // reason: a fixed frame count would make the same fader feel twice as
        // slow on a 96 kHz machine as on a 44.1 kHz one.
        let mut at_44 = Smoothed::new(1.0, 44_100.0);
        let mut at_96 = Smoothed::new(1.0, 96_000.0);
        at_44.set(0.0);
        at_96.set(0.0);

        // Half the glide at each rate — the midpoint rather than the end,
        // where both would read 0.0 whatever the length.
        for _ in 0..220 {
            at_44.tick();
        }
        for _ in 0..480 {
            at_96.tick();
        }

        let (left, right) = (at_44.tick(), at_96.tick());
        assert!((left - right).abs() < 1e-3, "5 ms in is not 5 ms in: {left} vs {right}");
    }
}
