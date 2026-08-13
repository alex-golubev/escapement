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
//! Every setter here takes untrusted input — the values arrive from the UI over
//! the command protocol — so each goes through [`dsp::clamped`](crate::dsp),
//! which is where the reasoning about non-finite values and denormals lives.
//! What belongs to this module is only the ranges below.

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
    /// Unreachable from the sequencer, which walks `0..TRACKS`. It is for
    /// whoever computes an index some other way later.
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
        assert_eq!(mixer.master_gain(), 0.0, "a denormal gain was refused, not flushed");
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
