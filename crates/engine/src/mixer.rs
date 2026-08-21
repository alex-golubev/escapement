//! Track levels and the master gain.
//!
//! The mixer proper is a later milestone — buses, sends, effects. What lives
//! here is the data layout those will grow out of, plus the one control that
//! has something to act on today.
//!
//! **A knob is kept twice, and the two copies answer different questions.**
//! `track_gain` and `track_pan` hold what the UI asked for; `channel` holds
//! what a frame is multiplied by, which is the pan law applied to both of them
//! and then smoothed. Only the second reaches a sample.
//!
//! Keeping the raw pair is not redundancy. The law takes gain and pan
//! together, so neither knob can retarget without the other's value — a mixer
//! holding only the derived gains could not answer "the fader moved" at all,
//! because the fader's own position would be nowhere. It is also what the UI
//! reads back and what a project file will store.
//!
//! Every setter here takes untrusted input — values and track numbers alike
//! arrive from the UI over the command protocol. Values go through
//! [`dsp::clamped`](crate::dsp) and indices are dropped when the grid has no
//! room for them; both rules are argued elsewhere, at
//! [`clamped`](crate::dsp::clamped) and at
//! [`Command`](crate::commands::Command). What belongs to this module is the
//! ranges below, and one choice about reading past the end that is genuinely
//! its own — see [`track_gain`](Mixer::track_gain).

use crate::TRACKS;
use crate::dsp::{Smoothed, clamped};

/// Gain limits. The ceiling is above unity on purpose: summing eight tracks
/// needs headroom above the loudest single one, and a fader that cannot go
/// past 0 dB makes a quiet sample unusable. Roughly +6 dB.
pub const MIN_GAIN: f32 = 0.0;
pub const MAX_GAIN: f32 = 2.0;

/// Pan limits: fully left to fully right.
pub const MIN_PAN: f32 = -1.0;
pub const MAX_PAN: f32 = 1.0;

pub const DEFAULT_GAIN: f32 = 1.0;
pub const DEFAULT_PAN: f32 = 0.0;

/// The pan law: what a track's two output channels are multiplied by.
///
/// **Constant power**, so that sweeping a track across the image does not
/// change how loud it is: the two gains square to `gain²` at every position.
/// Centre gives `1/√2` to each side, which is where the −3 dB at the middle
/// comes from, and an edge gives all of the gain to one side and none to the
/// other.
///
/// **In its root form rather than the textbook `cos θ` / `sin θ`, and the
/// reason is `f32` rather than cost** — the trigonometry is evaluated once per
/// command, so there is nothing to save. The trigonometric form is not
/// symmetric in single precision: hard left yields exactly `(1, 0)` and hard
/// right yields `(-4.4e-8, 1)`, an inverted whisper 147 dB down in the channel
/// that should be silent, and only at one of the two ends. Nothing is audible
/// there; what is lost is that "an edge does not sound in the opposite
/// channel" stops being an equality on one side and stays one on the other,
/// which is a difference between a test and its mirror with no cause in the
/// design. The root form is exact and mirrored at every position, and the two
/// tapers part company only in the middle of the travel.
///
/// Public because the engine's tests state their expected amplitudes through
/// it. A second copy of `0.707` written into a test would agree with itself
/// and not with the law.
pub fn channel_gains(gain: f32, pan: f32) -> [f32; 2] {
    [
        gain * ((1.0 - pan) * 0.5).sqrt(),
        gain * ((1.0 + pan) * 0.5).sqrt(),
    ]
}

#[derive(Debug, Clone)]
pub struct Mixer {
    master: Smoothed,
    track_gain: [f32; TRACKS],
    track_pan: [f32; TRACKS],
    /// Per track, the left and right gains a frame is multiplied by: the pan
    /// law over the two knobs above, interpolated per frame.
    channel: [[Smoothed; 2]; TRACKS],
}

impl Mixer {
    pub fn new(sample_rate: f64) -> Self {
        let [left, right] = channel_gains(DEFAULT_GAIN, DEFAULT_PAN);
        Self {
            master: Smoothed::new(DEFAULT_GAIN, sample_rate),
            track_gain: [DEFAULT_GAIN; TRACKS],
            track_pan: [DEFAULT_PAN; TRACKS],
            channel: std::array::from_fn(|_| {
                [
                    Smoothed::new(left, sample_rate),
                    Smoothed::new(right, sample_rate),
                ]
            }),
        }
    }

    /// Return to the as-constructed state, keeping the sample rate the glide
    /// was derived from.
    pub fn reset(&mut self) {
        self.master.snap_to(DEFAULT_GAIN);
        self.track_gain = [DEFAULT_GAIN; TRACKS];
        self.track_pan = [DEFAULT_PAN; TRACKS];
        // Snapped rather than retargeted, for the reason the master is: a
        // reset instance has to render identically to a fresh one from its
        // first frame, and a glide back to unity would make the two differ for
        // ten milliseconds — which is exactly the window an offline render
        // starts in.
        let [left, right] = channel_gains(DEFAULT_GAIN, DEFAULT_PAN);
        for pair in &mut self.channel {
            pair[0].snap_to(left);
            pair[1].snap_to(right);
        }
    }

    /// One frame of the track bus: each track's frame scaled by its own two
    /// gains, all of them summed.
    ///
    /// **Every pair is ticked, including the tracks that are silent**, and the
    /// loop is written here rather than at the caller so that it cannot be
    /// otherwise. Advancing only the tracks that sound looks like the same
    /// thing for a saving: it is not, and the cost lands on the next strike
    /// rather than on the silence. A fader moved while its track is quiet
    /// would then take ten milliseconds *of sounding* to arrive, so the strike
    /// after it opens with a step — the zipper this smoothing exists to
    /// prevent, moved to where nothing is looking for it.
    ///
    /// Seventeen ticks a frame counting the master, 816 thousand a second at
    /// 48 kHz, which is nothing to weigh against that.
    #[inline]
    pub fn mix_tracks(&mut self, tracks: &[[f32; 2]; TRACKS]) -> [f32; 2] {
        let mut bus = [0.0f32; 2];
        for (gains, frame) in self.channel.iter_mut().zip(tracks) {
            bus[0] += frame[0] * gains[0].tick();
            bus[1] += frame[1] * gains[1].tick();
        }
        bus
    }

    /// Recompute where one track's channel gains are heading.
    ///
    /// **Both knobs come here, because the law needs both.** Setting a target
    /// from the gain alone is not expressible: the pan decides how that gain
    /// divides. Written as two paths, one per knob, the second to move would
    /// compute its target from whatever the first had left behind, and a gain
    /// change during a pan glide would aim at a pan that is no longer current.
    fn retarget(&mut self, track: usize) {
        debug_assert!(track < TRACKS, "retarget past the grid");
        let [left, right] = channel_gains(self.track_gain[track], self.track_pan[track]);
        self.channel[track][0].set(left);
        self.channel[track][1].set(right);
    }

    /// The master gain for one frame. Called once per rendered frame.
    #[inline]
    pub fn next_master_gain(&mut self) -> f32 {
        self.master.tick()
    }

    /// What the master gain is heading for — the number the UI last asked
    /// for, which is not the number this frame is multiplied by.
    pub fn master_gain(&self) -> f32 {
        self.master.target()
    }

    pub fn set_master_gain(&mut self, gain: f32) {
        if let Some(gain) = clamped(gain, MIN_GAIN, MAX_GAIN) {
            self.master.set(gain);
        }
    }

    /// Reading past the end answers **silence**, not the default gain, and the
    /// difference is the whole point of the line. Both this and
    /// [`crate::pattern::Pattern::velocity`] have to be total — under
    /// `panic = "abort"` an indexing panic ends the sound until the page is
    /// reloaded — but a total function still has to choose which way it fails,
    /// and in audio the two directions are not equally bad. A miscomputed index
    /// answered with `DEFAULT_GAIN` is a track that does not exist playing at
    /// full volume; answered with zero it is a track that does not exist making
    /// no sound. The second is a bug you go looking for, the first is a bug you
    /// hear. The pattern already fails the quiet way; this used to fail the
    /// loud one.
    ///
    /// **What this getter answers no longer multiplies anything**, since the
    /// levels became [`channel`](Mixer::channel) and the summing walks those by
    /// iteration rather than by index. So the choice above is not defending
    /// today's output; it is defending whoever sums through this getter in the
    /// mixer proper, where buses and sends compute indices that are not simply
    /// `0..TRACKS`.
    pub fn track_gain(&self, track: usize) -> f32 {
        self.track_gain.get(track).copied().unwrap_or(0.0)
    }

    /// Past the end this answers centre, and that is not the safe direction —
    /// there isn't one. A pan has no quiet end: hard left is as loud as hard
    /// right. Centre is simply the value that says least, which is why the
    /// reasoning above does not apply here and this getter is not changed to
    /// match it.
    pub fn track_pan(&self, track: usize) -> f32 {
        self.track_pan.get(track).copied().unwrap_or(DEFAULT_PAN)
    }

    /// The index is checked once, here, and everything below it indexes
    /// directly: the three arrays are all `TRACKS` long, so one comparison
    /// makes all of them safe. Out of range is dropped rather than wrapped —
    /// a track number that does not exist must fall silent rather than move
    /// the track it happens to land on.
    pub fn set_track_gain(&mut self, track: u8, gain: f32) {
        let track = usize::from(track);
        if let (true, Some(gain)) = (track < TRACKS, clamped(gain, MIN_GAIN, MAX_GAIN)) {
            self.track_gain[track] = gain;
            self.retarget(track);
        }
    }

    pub fn set_track_pan(&mut self, track: u8, pan: f32) {
        let track = usize::from(track);
        if let (true, Some(pan)) = (track < TRACKS, clamped(pan, MIN_PAN, MAX_PAN)) {
            self.track_pan[track] = pan;
            self.retarget(track);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_1_SQRT_2;

    const SR: f64 = 48_000.0;

    #[test]
    fn starts_at_unity_gain_and_centre_pan() {
        let mixer = Mixer::new(SR);
        assert_eq!(mixer.master_gain(), 1.0);
        for track in 0..TRACKS {
            assert_eq!(mixer.track_gain(track), 1.0, "track {track}");
            assert_eq!(mixer.track_pan(track), 0.0, "track {track}");
        }
    }

    #[test]
    fn the_master_gain_starts_at_its_value_rather_than_gliding_up_to_it() {
        // Otherwise every engine, and every offline render, would open with a
        // fade-in nobody asked for.
        let mut mixer = Mixer::new(SR);
        assert_eq!(mixer.next_master_gain(), 1.0);
    }

    #[test]
    fn each_track_keeps_its_own_gain_and_pan() {
        // A shared array or an off-by-one in indexing would show up as one
        // fader moving another track.
        let mut mixer = Mixer::new(SR);
        for track in 0..TRACKS {
            mixer.set_track_gain(track as u8, track as f32 / 10.0);
            mixer.set_track_pan(track as u8, track as f32 / 10.0 - 0.4);
        }
        for track in 0..TRACKS {
            assert_eq!(
                mixer.track_gain(track),
                track as f32 / 10.0,
                "track {track}"
            );
            assert_eq!(
                mixer.track_pan(track),
                track as f32 / 10.0 - 0.4,
                "track {track}"
            );
        }
    }

    #[test]
    fn gains_are_clamped_to_their_range() {
        let mut mixer = Mixer::new(SR);
        for gain in [-1.0, -0.0001, MAX_GAIN + 0.0001, 1e9] {
            mixer.set_master_gain(gain);
            mixer.set_track_gain(0, gain);
            assert!(
                (MIN_GAIN..=MAX_GAIN).contains(&mixer.master_gain()),
                "master accepted {gain}"
            );
            assert!(
                (MIN_GAIN..=MAX_GAIN).contains(&mixer.track_gain(0)),
                "track accepted {gain}"
            );
        }
    }

    #[test]
    fn pan_is_clamped_to_its_range() {
        let mut mixer = Mixer::new(SR);
        for pan in [-2.0, 2.0, 1e9, -1e9] {
            mixer.set_track_pan(0, pan);
            assert!(
                (MIN_PAN..=MAX_PAN).contains(&mixer.track_pan(0)),
                "accepted {pan}"
            );
        }
    }

    #[test]
    fn a_refused_value_leaves_the_previous_one_standing() {
        // What a refusal *means* here, which is the mixer's own property and
        // not the guard's: `dsp::clamped` answers `None`, and this is the
        // module that decides a knob keeps its last setting rather than
        // resetting to a default. Every value dangerous enough to refuse is
        // enumerated in `dsp`, so one specimen of each answer is enough — NaN
        // for the refusal, a denormal for the flush.
        let mut mixer = Mixer::new(SR);
        mixer.set_master_gain(0.5);
        mixer.set_track_gain(3, 0.5);
        mixer.set_track_pan(3, 0.5);

        mixer.set_master_gain(f32::NAN);
        mixer.set_track_gain(3, f32::NAN);
        mixer.set_track_pan(3, f32::NAN);

        assert_eq!(mixer.master_gain(), 0.5, "master took a NaN");
        assert_eq!(mixer.track_gain(3), 0.5, "gain took a NaN");
        assert_eq!(mixer.track_pan(3), 0.5, "pan took a NaN");

        // A denormal is taken rather than refused, and becomes exact zero. The
        // distinction matters at this end: refused would leave 0.5 multiplying
        // every frame, where the UI asked for something inaudible.
        mixer.set_master_gain(1e-40);
        assert_eq!(
            mixer.master_gain(),
            0.0,
            "a denormal gain was refused, not flushed"
        );
    }

    #[test]
    fn a_track_index_out_of_range_is_dropped_not_panicked() {
        // What would be heard: one fader moving a track it does not name.
        let mut mixer = Mixer::new(SR);
        for track in TRACKS as u8..=u8::MAX {
            mixer.set_track_gain(track, 0.5);
            mixer.set_track_pan(track, 0.5);
        }
        for track in 0..TRACKS {
            assert_eq!(
                mixer.track_gain(track),
                1.0,
                "track {track} was written through"
            );
            assert_eq!(
                mixer.track_pan(track),
                0.0,
                "track {track} was written through"
            );
        }
        // Reading past the end answers rather than panicking — and answers
        // silence, which is the direction that matters. A track that does not
        // exist reporting unity gain is one that plays at full volume the
        // moment anything sums it in; reporting zero, it makes no sound. Both
        // are the same bug upstream, and only one of them is audible.
        assert_eq!(mixer.track_gain(TRACKS), 0.0);
        assert_eq!(mixer.track_gain(usize::MAX), 0.0);
        // Pan has no quiet end, so there is nothing to choose here: centre is
        // the value that says least, not the safe one.
        assert_eq!(mixer.track_pan(usize::MAX), DEFAULT_PAN);
    }

    /// One frame with a unit sample on `track` and silence on the rest.
    fn one_track(track: usize) -> [[f32; 2]; TRACKS] {
        let mut frame = [[0.0f32; 2]; TRACKS];
        frame[track] = [1.0, 1.0];
        frame
    }

    /// Run the bus until every glide has settled, then read one frame.
    fn settled(mixer: &mut Mixer, frame: &[[f32; 2]; TRACKS]) -> [f32; 2] {
        for _ in 0..1_000 {
            mixer.mix_tracks(frame);
        }
        mixer.mix_tracks(frame)
    }

    #[test]
    fn the_pan_law_holds_its_power_and_is_exact_at_both_edges() {
        // Constant power, stated as the two things it promises. The sum of
        // squares is the promise itself: a track sweeping across the image does
        // not change loudness. The edges are exact because the law is written
        // in its root form — the trigonometric form of the same law answers
        // -4.4e-8 at one edge and 0.0 at the other, so the equality below would
        // hold on one side and want a tolerance on the other.
        for pan in [-1.0f32, -0.75, -0.5, 0.0, 0.5, 0.75, 1.0] {
            let [left, right] = channel_gains(1.0, pan);
            let power = left * left + right * right;
            assert!((power - 1.0).abs() < 1e-6, "pan {pan} has power {power}");
        }
        assert_eq!(channel_gains(1.0, MIN_PAN), [1.0, 0.0]);
        assert_eq!(channel_gains(1.0, MAX_PAN), [0.0, 1.0]);
        assert_eq!(
            channel_gains(0.5, DEFAULT_PAN),
            [0.5 * FRAC_1_SQRT_2, 0.5 * FRAC_1_SQRT_2]
        );
    }

    #[test]
    fn a_track_that_sounds_is_multiplied_by_both_of_its_knobs() {
        let mut mixer = Mixer::new(SR);
        mixer.set_track_gain(2, 0.5);
        mixer.set_track_pan(2, -1.0);

        assert_eq!(settled(&mut mixer, &one_track(2)), [0.5, 0.0]);
    }

    #[test]
    fn moving_one_knob_does_not_undo_the_other() {
        // The failure this guards is a mixer that keeps only the derived gains:
        // the pan law needs both knobs, so a gain change computing its target
        // without the current pan would quietly re-centre the track. Here the
        // pan is set first and the gain second — the order in which a fader is
        // usually touched after a track has been placed.
        let mut mixer = Mixer::new(SR);
        mixer.set_track_pan(0, MAX_PAN);
        mixer.set_track_gain(0, 0.5);
        assert_eq!(
            settled(&mut mixer, &one_track(0)),
            [0.0, 0.5],
            "the gain re-centred the track"
        );

        // And the other way round, because one order can be right by accident.
        let mut mixer = Mixer::new(SR);
        mixer.set_track_gain(1, 0.5);
        mixer.set_track_pan(1, MIN_PAN);
        assert_eq!(
            settled(&mut mixer, &one_track(1)),
            [0.5, 0.0],
            "the pan discarded the gain"
        );
    }

    #[test]
    fn a_level_glides_to_its_new_value_rather_than_stepping() {
        let mut mixer = Mixer::new(SR);
        let opening = mixer.mix_tracks(&one_track(0));
        mixer.set_track_gain(0, 0.0);

        let first = mixer.mix_tracks(&one_track(0));
        assert!(first[0] < opening[0], "the level did not move");
        assert!(
            first[0] > opening[0] * 0.99,
            "the level jumped: {opening:?} → {first:?}"
        );
    }

    #[test]
    fn every_track_advances_whether_or_not_it_sounds() {
        // The invariant `mix_tracks` exists to hold. Advancing only the tracks
        // with a sample in them looks like the same thing for less work, and
        // the cost lands somewhere else entirely: a fader moved during a rest
        // would be caught halfway by the next strike, opening it with a step.
        //
        // Stated as silence in and silence out, because that is the case where
        // skipping is tempting: nothing here has anything to multiply.
        let mut mixer = Mixer::new(SR);
        mixer.set_track_gain(0, 0.5);
        let silence = [[0.0f32; 2]; TRACKS];
        for _ in 0..1_000 {
            assert_eq!(mixer.mix_tracks(&silence), [0.0, 0.0]);
        }

        assert_eq!(
            mixer.mix_tracks(&one_track(0)),
            channel_gains(0.5, DEFAULT_PAN)
        );
    }

    #[test]
    fn the_bus_is_the_sum_of_every_track() {
        let mut mixer = Mixer::new(SR);
        let all = [[1.0f32; 2]; TRACKS];
        let expected = (0..TRACKS).fold(0.0f32, |sum, _| sum + FRAC_1_SQRT_2);

        assert_eq!(settled(&mut mixer, &all), [expected, expected]);
    }

    #[test]
    fn reset_restores_every_control() {
        let mut mixer = Mixer::new(SR);
        mixer.set_master_gain(0.1);
        for track in 0..TRACKS as u8 {
            mixer.set_track_gain(track, 0.2);
            mixer.set_track_pan(track, -0.3);
        }
        mixer.reset();

        assert_eq!(mixer.master_gain(), 1.0);
        // Snapped, not glided: a reset instance has to render identically to a
        // fresh one from its very first frame, or the golden tests compare a
        // warmed-up engine against a cold one.
        assert_eq!(mixer.next_master_gain(), 1.0);
        for track in 0..TRACKS {
            assert_eq!(mixer.track_gain(track), 1.0, "track {track}");
            assert_eq!(mixer.track_pan(track), 0.0, "track {track}");
        }
        // The knobs above are what the UI reads; this is what a sample is
        // multiplied by, and a reset that restored one and not the other would
        // leave an engine reporting unity and rendering something else.
        // Snapped, not glided, for the same reason as the master.
        assert_eq!(
            mixer.mix_tracks(&one_track(0)),
            channel_gains(DEFAULT_GAIN, DEFAULT_PAN)
        );
    }
}
