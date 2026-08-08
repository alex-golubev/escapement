//! Primitives shared by everything that touches samples.
//!
//! Two of them so far, and both exist because of a house rule rather than
//! because the arithmetic was hard: denormals are flushed by hand because WASM
//! cannot be told to flush them, and a controlled parameter slides to its
//! target because stepping it is audible.

/// Denormal flush threshold.
const DENORMAL_THRESHOLD: f32 = 1e-20;

/// Flush denormals to zero.
///
/// WASM has no FPU-level flush-to-zero: the x86 MXCSR flags native plugins use
/// for this are not reachable, and the spec requires IEEE 754 denormals to be
/// handled properly, which browsers may not opt out of. Decaying tails
/// therefore have to be cut off by hand, and the symptom of forgetting is
/// distinctive and misleading — CPU climbing *during silence*, once the sound
/// has already died away.
#[inline(always)]
pub fn fz(x: f32) -> f32 {
    if x.abs() < DENORMAL_THRESHOLD { 0.0 } else { x }
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
        // At least one frame, so that a nonsensical sample rate produces an
        // instant parameter rather than a division by zero.
        let frames = ((SMOOTHING_SECONDS * sample_rate) as u32).max(1);
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
