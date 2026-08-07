//! The transport — the single source of truth about playback position.
//!
//! Position is kept in whole samples (§3.3). Musical position is not
//! accumulated frame by frame but computed from the sample position:
//! accumulating `f64` would drift, and that drift shows up not right away
//! but tens of minutes in, where it is agony to debug.
//!
//! A tempo change does not break continuity: at the moment of the change we
//! drop an anchor (sample position plus musical position at that instant) and
//! count from it afterwards. The difference between positions is always
//! integral, so error cannot pile up from one change to the next.

/// Tempo limits. The value arrives from the UI over the command protocol,
/// which makes it untrusted input.
pub const MIN_BPM: f64 = 20.0;
pub const MAX_BPM: f64 = 999.0;
pub const DEFAULT_BPM: f64 = 120.0;

#[derive(Debug, Clone)]
pub struct Transport {
    sample_rate: f64,
    bpm: f64,
    playing: bool,
    /// Absolute playback position, in samples.
    sample_pos: u64,
    /// Tempo anchor: sample position at the last BPM change.
    epoch_sample: u64,
    /// Tempo anchor: musical position (in beats) at that same instant.
    epoch_beat: f64,
}

impl Transport {
    pub fn new(sample_rate: f64) -> Self {
        debug_assert!(sample_rate > 0.0, "sample rate must be positive");
        Self {
            sample_rate,
            bpm: DEFAULT_BPM,
            playing: false,
            sample_pos: 0,
            epoch_sample: 0,
            epoch_beat: 0.0,
        }
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    pub fn bpm(&self) -> f64 {
        self.bpm
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn sample_pos(&self) -> u64 {
        self.sample_pos
    }

    /// Beat length in samples. Fractional in the general case.
    pub fn samples_per_beat(&self) -> f64 {
        60.0 / self.bpm * self.sample_rate
    }

    /// Change tempo while keeping musical position continuous.
    ///
    /// A non-finite value is ignored outright: `f64::clamp` lets NaN through,
    /// and NaN in the tempo would poison every derived quantity beyond
    /// recovery (§3.10, rule 3).
    pub fn set_bpm(&mut self, bpm: f64) {
        if !bpm.is_finite() {
            return;
        }
        // The anchor is placed before the tempo changes — on the old grid.
        self.epoch_beat = self.beat_at(self.sample_pos);
        self.epoch_sample = self.sample_pos;
        self.bpm = bpm.clamp(MIN_BPM, MAX_BPM);
    }

    pub fn play(&mut self) {
        self.playing = true;
    }

    /// Stop and rewind — the Stop button of a sequencer.
    pub fn stop(&mut self) {
        self.playing = false;
        self.sample_pos = 0;
        self.epoch_sample = 0;
        self.epoch_beat = 0.0;
    }

    /// Advance by a rendered quantum. While paused, position stands still.
    pub fn advance(&mut self, frames: u32) {
        if self.playing {
            self.sample_pos += u64::from(frames);
        }
    }

    /// Musical position (in beats) for a given sample position.
    pub fn beat_at(&self, pos: u64) -> f64 {
        let delta = pos as f64 - self.epoch_sample as f64;
        self.epoch_beat + delta / self.samples_per_beat()
    }

    /// Sample position for a given musical position.
    pub fn sample_of_beat(&self, beat: f64) -> u64 {
        let delta = (beat - self.epoch_beat) * self.samples_per_beat();
        let pos = self.epoch_sample as f64 + delta;
        if pos <= 0.0 { 0 } else { pos.round() as u64 }
    }

    /// The nearest beat boundary at or after `pos`.
    ///
    /// If `pos` is itself a boundary, `pos` is returned — a boundary belongs
    /// to the frame it starts on.
    pub fn next_beat_boundary(&self, pos: u64) -> u64 {
        // Count from floor, not from ceil. Rounding a boundary to a whole
        // sample makes beat_at slightly larger than the integer right on the
        // boundary (4.0000147 instead of 4.0), and ceil would jump past it —
        // the metronome click would silently vanish at fractional beat
        // lengths.
        let beat = self.beat_at(pos).floor();
        let boundary = self.sample_of_beat(beat);
        if boundary >= pos {
            boundary
        } else {
            self.sample_of_beat(beat + 1.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;
    /// A tempo with a fractional beat length: 60/127*48000 = 22677.165...
    /// Round values like 120 BPM hide rounding bugs.
    const AWKWARD_BPM: f64 = 127.0;

    fn at(bpm: f64) -> Transport {
        let mut t = Transport::new(SR);
        t.set_bpm(bpm);
        t
    }

    #[test]
    fn samples_per_beat_at_120() {
        assert_eq!(at(120.0).samples_per_beat(), 24_000.0);
    }

    #[test]
    fn starts_stopped_at_zero() {
        let t = Transport::new(SR);
        assert!(!t.is_playing());
        assert_eq!(t.sample_pos(), 0);
        assert_eq!(t.bpm(), DEFAULT_BPM);
    }

    #[test]
    fn advances_only_while_playing() {
        let mut t = Transport::new(SR);
        t.advance(128);
        assert_eq!(t.sample_pos(), 0, "position must stand still while paused");

        t.play();
        t.advance(128);
        t.advance(128);
        assert_eq!(t.sample_pos(), 256);
    }

    #[test]
    fn stop_rewinds_to_start() {
        let mut t = at(AWKWARD_BPM);
        t.play();
        t.advance(50_000);
        t.stop();
        assert_eq!(t.sample_pos(), 0);
        assert_eq!(t.beat_at(0), 0.0, "the tempo anchor must reset as well");
    }

    #[test]
    fn beat_and_sample_are_inverse() {
        let t = at(AWKWARD_BPM);
        for beat in 0..64 {
            let pos = t.sample_of_beat(beat as f64);
            assert_eq!(
                t.beat_at(pos).round() as i64,
                beat,
                "beat {beat} does not survive the round trip"
            );
        }
    }

    /// The key no-drift test: the position of beat N must be computed from
    /// zero, not accumulated one beat at a time. Catches anyone rewriting
    /// `sample_of_beat` as accumulation.
    #[test]
    fn no_drift_over_long_run() {
        let t = at(AWKWARD_BPM);
        let spb = t.samples_per_beat();
        // 4000 beats at 127 BPM is about half an hour of playback.
        for beat in 0..4_000 {
            let expected = (beat as f64 * spb).round() as u64;
            assert_eq!(
                t.sample_of_beat(beat as f64),
                expected,
                "beat {beat} drifted — accumulation has crept in"
            );
        }
    }

    #[test]
    fn boundary_at_exact_position_is_that_position() {
        let t = at(AWKWARD_BPM);
        for beat in 0..64 {
            let pos = t.sample_of_beat(beat as f64);
            assert_eq!(
                t.next_beat_boundary(pos),
                pos,
                "a boundary belongs to the frame it starts on"
            );
        }
    }

    #[test]
    fn boundary_never_goes_backwards() {
        let t = at(AWKWARD_BPM);
        // Walk the first few beats sample by sample: rounding must never
        // yield a boundary to the left of the requested position.
        for pos in 0..200_000u64 {
            assert!(t.next_beat_boundary(pos) >= pos, "boundary left of pos={pos}");
        }
    }

    #[test]
    fn boundaries_are_evenly_spaced() {
        let t = at(AWKWARD_BPM);
        let spb = t.samples_per_beat();
        let mut pos = 0u64;
        let mut previous = t.next_beat_boundary(pos);
        for _ in 0..1_000 {
            pos = previous + 1;
            let boundary = t.next_beat_boundary(pos);
            let gap = boundary - previous;
            // A fractional beat makes adjacent gaps either floor or ceil.
            assert!(
                gap == spb.floor() as u64 || gap == spb.ceil() as u64,
                "gap between boundaries {gap} is out of range"
            );
            previous = boundary;
        }
    }

    #[test]
    fn tempo_change_keeps_musical_position() {
        let mut t = at(120.0);
        t.play();
        t.advance(24_000); // exactly one beat
        assert_eq!(t.beat_at(t.sample_pos()), 1.0);

        t.set_bpm(240.0);
        assert_eq!(
            t.beat_at(t.sample_pos()),
            1.0,
            "a tempo change must not shift musical position"
        );
        assert_eq!(t.samples_per_beat(), 12_000.0);
        assert_eq!(
            t.sample_of_beat(2.0),
            36_000,
            "the next beat is measured in the new tempo"
        );
    }

    #[test]
    fn tempo_change_is_continuous() {
        // A tempo change at an arbitrary point has no right to shift musical
        // position — not by any amount.
        let mut t = at(AWKWARD_BPM);
        t.play();
        for (frames, bpm) in [(1_000u32, 90.0), (12_345, 174.0), (7, 63.5), (99_999, 128.0)] {
            t.advance(frames);
            let before = t.beat_at(t.sample_pos());
            t.set_bpm(bpm);
            let after = t.beat_at(t.sample_pos());
            assert_eq!(before, after, "the tempo change shifted musical position");
        }
    }

    #[test]
    fn tempo_changes_do_not_accumulate_error() {
        // The tempos are chosen so a beat is a whole number of samples at
        // 48 kHz (24000 and 12000). All arithmetic is then exact, and any
        // discrepancy means error leaking through the anchor mechanism
        // rather than rounding.
        let mut t = at(120.0);
        t.play();
        for i in 0..50 {
            let spb = t.samples_per_beat();
            assert_eq!(spb.fract(), 0.0, "this test requires a whole-sample beat");
            t.advance(spb as u32);
            t.set_bpm(if i % 2 == 0 { 240.0 } else { 120.0 });
        }
        assert_eq!(
            t.beat_at(t.sample_pos()),
            50.0,
            "musical position crept after repeated tempo changes"
        );
    }

    #[test]
    fn bpm_is_clamped() {
        let mut t = Transport::new(SR);
        t.set_bpm(0.0);
        assert_eq!(t.bpm(), MIN_BPM);
        t.set_bpm(-5.0);
        assert_eq!(t.bpm(), MIN_BPM);
        t.set_bpm(100_000.0);
        assert_eq!(t.bpm(), MAX_BPM);
    }

    #[test]
    fn non_finite_bpm_is_ignored() {
        let mut t = at(127.0);
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            t.set_bpm(bad);
            assert_eq!(t.bpm(), 127.0, "a non-finite BPM must be ignored outright");
            assert!(t.samples_per_beat().is_finite());
        }
    }
}
