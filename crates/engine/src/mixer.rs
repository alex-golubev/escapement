//! Track levels and the master gain.
//!
//! The mixer proper is a later milestone — buses, sends, effects. What lives
//! here is the data layout those will grow out of, plus the one control that
//! has something to act on today.
//!
//! That asymmetry is deliberate and worth stating, because the code looks
//! inconsistent without it. The master gain multiplies the output and is
//! therefore smoothed, per the rule that every controlled parameter is
//! interpolated per frame. Track gain and pan are stored and nothing more:
//! there are no voices yet for them to scale, and smoothing a number that
//! reaches no sample would be a per-frame computation with no listener and no
//! test that could tell it apart from a constant. They become [`Smoothed`] in
//! the same commit that gives them something to multiply.
//!
//! Every setter here takes untrusted input — the values arrive from the UI
//! over the command protocol — so each clamps its range and each ignores a
//! non-finite argument outright. Clamping is a guard, not a channel: a UI that
//! sends out-of-range values is a UI with a bug, and it is not told.

use crate::dsp::Smoothed;

/// Tracks in the drum machine. Fixed for this milestone.
pub const TRACKS: usize = 8;

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

#[derive(Debug, Clone)]
pub struct Mixer {
    master: Smoothed,
    track_gain: [f32; TRACKS],
    track_pan: [f32; TRACKS],
}

impl Mixer {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            master: Smoothed::new(DEFAULT_GAIN, sample_rate),
            track_gain: [DEFAULT_GAIN; TRACKS],
            track_pan: [DEFAULT_PAN; TRACKS],
        }
    }

    /// Return to the as-constructed state, keeping the sample rate the glide
    /// was derived from.
    pub fn reset(&mut self) {
        self.master.snap_to(DEFAULT_GAIN);
        self.track_gain = [DEFAULT_GAIN; TRACKS];
        self.track_pan = [DEFAULT_PAN; TRACKS];
    }

    /// The master gain for one frame. Called once per rendered frame.
    #[inline]
    pub fn next_master_gain(&mut self) -> f32 {
        self.master.next()
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

    pub fn track_gain(&self, track: usize) -> f32 {
        self.track_gain.get(track).copied().unwrap_or(DEFAULT_GAIN)
    }

    pub fn track_pan(&self, track: usize) -> f32 {
        self.track_pan.get(track).copied().unwrap_or(DEFAULT_PAN)
    }

    /// A track index out of range is dropped. It arrives as a `u8` from
    /// another thread, so 200 is as likely as 3 if anything goes wrong, and
    /// under `panic = "abort"` an indexing panic would end the sound entirely.
    pub fn set_track_gain(&mut self, track: u8, gain: f32) {
        if let (Some(slot), Some(gain)) = (
            self.track_gain.get_mut(usize::from(track)),
            clamped(gain, MIN_GAIN, MAX_GAIN),
        ) {
            *slot = gain;
        }
    }

    pub fn set_track_pan(&mut self, track: u8, pan: f32) {
        if let (Some(slot), Some(pan)) = (
            self.track_pan.get_mut(usize::from(track)),
            clamped(pan, MIN_PAN, MAX_PAN),
        ) {
            *slot = pan;
        }
    }
}

/// Clamp a value from across the ABI, or reject it.
///
/// `f32::clamp` passes NaN straight through — it is not less than the low
/// bound nor greater than the high one — so a NaN gain would reach the output
/// and poison it permanently. Non-finite is therefore refused rather than
/// clamped, which is what `Transport::set_bpm` does with the tempo for the
/// same reason.
fn clamped(value: f32, low: f32, high: f32) -> Option<f32> {
    value.is_finite().then(|| value.clamp(low, high))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert_eq!(mixer.track_gain(track), track as f32 / 10.0, "track {track}");
            assert_eq!(mixer.track_pan(track), track as f32 / 10.0 - 0.4, "track {track}");
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
            assert!((MIN_PAN..=MAX_PAN).contains(&mixer.track_pan(0)), "accepted {pan}");
        }
    }

    #[test]
    fn non_finite_values_are_refused_not_clamped() {
        // `f32::clamp` lets NaN through, and one NaN on the output poisons
        // every feedback path downstream of it for good.
        let mut mixer = Mixer::new(SR);
        mixer.set_master_gain(0.5);
        mixer.set_track_gain(3, 0.5);
        mixer.set_track_pan(3, 0.5);

        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            mixer.set_master_gain(bad);
            mixer.set_track_gain(3, bad);
            mixer.set_track_pan(3, bad);
            assert_eq!(mixer.master_gain(), 0.5, "master took {bad}");
            assert_eq!(mixer.track_gain(3), 0.5, "gain took {bad}");
            assert_eq!(mixer.track_pan(3), 0.5, "pan took {bad}");
        }
    }

    #[test]
    fn a_track_index_out_of_range_is_dropped_not_panicked() {
        // The index is a u8 from another thread; every value of it is
        // reachable, and a panic here takes the whole worklet with it.
        let mut mixer = Mixer::new(SR);
        for track in TRACKS as u8..=u8::MAX {
            mixer.set_track_gain(track, 0.5);
            mixer.set_track_pan(track, 0.5);
        }
        for track in 0..TRACKS {
            assert_eq!(mixer.track_gain(track), 1.0, "track {track} was written through");
            assert_eq!(mixer.track_pan(track), 0.0, "track {track} was written through");
        }
        // Reading past the end answers with the default rather than panicking.
        assert_eq!(mixer.track_gain(TRACKS), DEFAULT_GAIN);
        assert_eq!(mixer.track_pan(usize::MAX), DEFAULT_PAN);
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
    }
}
