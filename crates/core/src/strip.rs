//! One stage of the route, and what it does to the signal passing through it.
//!
//! A channel and an insert are different entities in the document (§2.6) and
//! the same three numbers by the time the audio thread has them — what made
//! them different is a source and a name, and both are gone before anything
//! here runs.
//!
//! **The two stages pan differently, and that is not a detail.** A channel
//! places a mono source between the speakers, so its law is equal power and the
//! centre is −3 dB on both sides — panning a source must not make it louder at
//! the edges than in the middle. An insert is handed a stereo signal and can
//! only lean it one way, so its centre is untouched and hard over silences the
//! far side. Give an insert the channel's law and every neutral strip on the
//! route quietly costs 3 dB.

use escapement_time::SampleRate;

/// Seconds a control takes to travel the full scale.
///
/// **Measured in samples once a rate is known, and never in blocks** — a ramp
/// written per quantum makes the output depend on how long a block is, and the
/// offline render for export chooses its own, so the file stops matching what
/// was heard (`.claude/rules/rt-safety.md`).
///
/// Five milliseconds is below what a person hears as a slide and above what
/// they hear as a click.
const TRAVEL_SECONDS: f32 = 0.005;

/// What one stage does: how loud, where between the speakers, and whether it
/// is silent at all.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strip {
    gain: f32,
    pan: f32,
    mute: bool,
}

impl Strip {
    /// Untouched: the signal as it arrived, in the middle, audible.
    pub const UNITY: Self = Self {
        gain: 1.0,
        pan: 0.0,
        mute: false,
    };

    /// Refuses a gain that is not one and leaves the last good value standing.
    ///
    /// Negative is refused because it is not quieter than silence — it is the
    /// signal inverted, which is a different operation wearing this one's name,
    /// and `mixer::Gain` refuses it in the document for the same reason. Above
    /// unity is **kept**: a quiet recording is brought up, and a ceiling here
    /// would be a limit the document does not have.
    pub fn set_gain(&mut self, gain: f32) {
        if gain.is_finite() && gain >= 0.0 {
            self.gain = gain;
        }
    }

    /// Refuses a place that is not a number; anything outside the two ends is
    /// held at the end it passed.
    ///
    /// Clamped rather than refused, unlike the gain above and unlike
    /// `mixer::Pan`: that one is guarding what a document may hold, this one is
    /// guarding arithmetic that has already been decided somewhere else.
    pub fn set_pan(&mut self, pan: f32) {
        if pan.is_finite() {
            self.pan = pan.clamp(-1.0, 1.0);
        }
    }

    pub const fn set_mute(&mut self, mute: bool) {
        self.mute = mute;
    }

    #[must_use]
    pub const fn gain(self) -> f32 {
        self.gain
    }

    #[must_use]
    pub const fn pan(self) -> f32 {
        self.pan
    }

    #[must_use]
    pub const fn mute(self) -> bool {
        self.mute
    }

    /// What a mono source becomes: equal power, −3 dB in the centre.
    #[must_use]
    pub fn spread(self) -> (f32, f32) {
        if self.mute {
            return (0.0, 0.0);
        }

        // Zero at hard left, a quarter turn at hard right, so the two sides
        // are a cosine and a sine of one angle and their squares sum to one
        // wherever the source is put.
        let angle = (self.pan + 1.0) * core::f32::consts::FRAC_PI_4;
        (self.gain * libm::cosf(angle), self.gain * libm::sinf(angle))
    }

    /// What a stereo signal is leaned by: untouched in the centre, one side
    /// gone at the end.
    #[must_use]
    pub fn balance(self) -> (f32, f32) {
        if self.mute {
            return (0.0, 0.0);
        }

        (
            self.gain * (1.0 + self.pan).min(1.0),
            self.gain * (1.0 - self.pan).min(1.0),
        )
    }
}

impl Default for Strip {
    fn default() -> Self {
        Self::UNITY
    }
}

/// A pair of gains walking towards where the strips say they should be.
///
/// One ramp per side rather than one per control: the route is three strips and
/// a pan law, and what reaches a sample is the product. Smoothing that product
/// costs two additions a sample and cannot be got wrong in the way smoothing
/// six controls separately can — where two of them move at once and their
/// product overshoots on the way.
#[derive(Clone, Copy, Debug)]
pub struct Level {
    left: f32,
    right: f32,
    towards: (f32, f32),
    /// Full scale per sample.
    step: f32,
}

impl Level {
    /// Silent, and going nowhere until it is told to.
    #[must_use]
    pub fn new(rate: SampleRate) -> Self {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a rate, narrowed for f32 audio arithmetic"
        )]
        let samples = (rate.hz() as f32) * TRAVEL_SECONDS;

        Self {
            left: 0.0,
            right: 0.0,
            towards: (0.0, 0.0),
            // A rate below one sample of travel would make this infinite; the
            // step is capped at the whole scale instead, which is a jump and
            // the best a rate that low can do.
            step: if samples > 1.0 { 1.0 / samples } else { 1.0 },
        }
    }

    /// Where it is heading. Reached [`TRAVEL_SECONDS`] later at the most.
    pub const fn towards(&mut self, left: f32, right: f32) {
        self.towards = (left, right);
    }

    /// Silence, on the way to which nothing clicks — what a stop asks for.
    pub const fn fade_out(&mut self) {
        self.towards = (0.0, 0.0);
    }

    /// The next sample's pair, one step closer to where it is heading.
    pub fn next(&mut self) -> (f32, f32) {
        self.left = approach(self.left, self.towards.0, self.step);
        self.right = approach(self.right, self.towards.1, self.step);
        (self.left, self.right)
    }
}

/// One step of `step` towards `target`, never past it.
fn approach(from: f32, target: f32, step: f32) -> f32 {
    if from < target {
        (from + step).min(target)
    } else {
        (from - step).max(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{rate, RATE_HZ};

    /// Squares summing to one is the whole of what equal power means, and it is
    /// what a cast to a linear law would break in the middle rather than at the
    /// ends — where both laws agree.
    #[test]
    fn a_channel_spreads_a_source_at_equal_power() {
        let centre = Strip::UNITY.spread();
        assert!((centre.0 - centre.1).abs() < 1e-6, "the centre is even");
        assert!(
            (centre.0 * centre.0 + centre.1 * centre.1 - 1.0).abs() < 1e-6,
            "and it is -3 dB, not unity: {centre:?}"
        );

        for place in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            let mut strip = Strip::UNITY;
            strip.set_pan(place);
            let (left, right) = strip.spread();
            assert!(
                (left * left + right * right - 1.0).abs() < 1e-6,
                "power moved at {place}"
            );
        }
    }

    #[test]
    fn a_channel_hard_over_is_on_one_side_only() {
        let mut strip = Strip::UNITY;
        strip.set_pan(-1.0);
        let (left, right) = strip.spread();
        assert!((left - 1.0).abs() < 1e-6);
        assert!(right.abs() < 1e-6);
    }

    /// The other law. A neutral insert must not cost anything — this is the
    /// test that fails if both stages are given the channel's.
    #[test]
    fn an_insert_in_the_middle_leaves_the_signal_alone() {
        assert_eq!(Strip::UNITY.balance(), (1.0, 1.0));
    }

    #[test]
    fn an_insert_leaned_over_holds_the_near_side_and_drops_the_far_one() {
        let mut strip = Strip::UNITY;
        strip.set_pan(1.0);
        assert_eq!(strip.balance(), (1.0, 0.0), "hard right");

        strip.set_pan(-1.0);
        assert_eq!(strip.balance(), (0.0, 1.0), "hard left");

        strip.set_pan(0.5);
        let (left, right) = strip.balance();
        assert_eq!(left, 1.0, "the near side is not raised");
        assert_eq!(right, 0.5);
    }

    #[test]
    fn a_muted_strip_is_silent_under_either_law() {
        let mut strip = Strip::UNITY;
        assert!(!strip.mute(), "a strip nobody touched is audible");

        strip.set_mute(true);
        assert!(strip.mute());
        assert_eq!(strip.spread(), (0.0, 0.0));
        assert_eq!(strip.balance(), (0.0, 0.0));

        strip.set_mute(false);
        assert!(!strip.mute(), "unmuting did not");
        assert_ne!(strip.balance(), (0.0, 0.0));
    }

    #[test]
    fn a_gain_that_is_not_one_leaves_the_last_good_value_standing() {
        let mut strip = Strip::UNITY;
        strip.set_gain(0.5);

        strip.set_gain(f32::NAN);
        assert_eq!(strip.gain(), 0.5, "not a number");

        strip.set_gain(-1.0);
        assert_eq!(strip.gain(), 0.5, "quieter than silence is not a gain");

        strip.set_gain(f32::INFINITY);
        assert_eq!(strip.gain(), 0.5, "infinite");
    }

    /// The document allows it, so the engine does: a ceiling here would be a
    /// limit invented on the audio thread.
    #[test]
    fn a_gain_above_unity_is_kept() {
        let mut strip = Strip::UNITY;
        strip.set_gain(2.0);

        assert_eq!(strip.gain(), 2.0);
        assert_eq!(strip.balance(), (2.0, 2.0));
    }

    #[test]
    fn a_place_outside_the_speakers_is_held_at_the_end_it_passed() {
        let mut strip = Strip::UNITY;

        strip.set_pan(9.0);
        assert_eq!(strip.pan(), 1.0);

        strip.set_pan(-9.0);
        assert_eq!(strip.pan(), -1.0);

        strip.set_pan(f32::NAN);
        assert_eq!(strip.pan(), -1.0, "not a number leaves the last one");
    }

    /// The number that matters is samples, not blocks: this is the count the
    /// offline render has to reproduce at whatever length it chooses.
    #[test]
    fn a_level_reaches_where_it_is_heading_in_the_travel_time() {
        let mut level = Level::new(rate());
        level.towards(1.0, 1.0);

        let travel = (RATE_HZ * f64::from(TRAVEL_SECONDS)) as usize;
        for _ in 0..travel {
            level.next();
        }

        let (left, right) = level.next();
        assert!((left - 1.0).abs() < 1e-6, "left stopped at {left}");
        assert!((right - 1.0).abs() < 1e-6, "right stopped at {right}");
    }

    /// A step at a time, which is the whole of what makes it a ramp: a level
    /// that arrived at once would be the click this exists to remove.
    #[test]
    fn a_level_walks_rather_than_arriving() {
        let mut level = Level::new(rate());
        level.towards(1.0, 1.0);

        let travel = (RATE_HZ * f64::from(TRAVEL_SECONDS)) as usize;
        let (left, _) = level.next();
        assert!(left > 0.0, "it did not move at all");
        assert!(left < 0.1, "it arrived in one sample: {left}");

        for _ in 0..travel / 2 {
            level.next();
        }
        let (halfway, _) = level.next();
        assert!(
            (halfway - 0.5).abs() < 0.05,
            "half the travel is not half the way: {halfway}"
        );
    }

    /// Where it already is, it stays — and that is what a stop does not undo.
    #[test]
    fn a_level_at_its_target_does_not_drift() {
        let mut level = Level::new(rate());
        level.towards(0.5, 0.5);
        for _ in 0..10_000 {
            level.next();
        }

        assert_eq!(level.next(), (0.5, 0.5));
        assert_eq!(level.next(), (0.5, 0.5), "and stays there");
    }

    #[test]
    fn a_level_does_not_step_past_where_it_is_heading() {
        let mut level = Level::new(rate());
        level.towards(0.5, 0.25);

        for _ in 0..10_000 {
            let (left, right) = level.next();
            assert!(left <= 0.5, "left overshot to {left}");
            assert!(right <= 0.25, "right overshot to {right}");
        }
    }

    #[test]
    fn a_fade_out_arrives_at_silence() {
        let mut level = Level::new(rate());
        level.towards(1.0, 1.0);
        for _ in 0..10_000 {
            level.next();
        }

        level.fade_out();
        assert_ne!(level.next(), (0.0, 0.0), "still on the way down");
        for _ in 0..10_000 {
            level.next();
        }
        assert_eq!(level.next(), (0.0, 0.0), "arrived at silence");
    }
}
