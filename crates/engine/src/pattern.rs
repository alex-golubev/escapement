//! The step grid: which track strikes on which step, and how hard.
//!
//! Stored, and nothing more, for now. Nothing here reaches a sample yet —
//! turning a step into a sound needs voices, and voices arrive with the
//! sampler. What this milestone settles is the shape the sequencer will read.
//!
//! **A step is its velocity, and zero means off.** There is no separate flag,
//! and that is a decision rather than a shortcut. The obvious objection is
//! that switching a step off forgets how hard it was struck — but remembering
//! that is the UI's job, not the engine's: the document holds what the user
//! set, the engine holds what sounds. Turning a step off sends a zero, turning
//! it back on sends the remembered value, and nothing is lost by the one side
//! that was never supposed to be asked.
//!
//! Every index here crosses the ABI, so each is checked and an out-of-range
//! one is dropped rather than clamped into a neighbour: a step meant for track
//! 200 is a bug on the far side, and silently writing it to track 0 would turn
//! that bug into a wrong sound.

use crate::TRACKS;

/// Steps per pattern. Sixteen, i.e. one bar of sixteenths.
pub const STEPS: usize = 16;

/// Velocity limits. Zero is a step that does not sound.
pub const MIN_VELOCITY: f32 = 0.0;
pub const MAX_VELOCITY: f32 = 1.0;

#[derive(Debug, Clone)]
pub struct Pattern {
    /// Velocity per track per step; zero is an inactive step.
    steps: [[f32; STEPS]; TRACKS],
}

impl Default for Pattern {
    fn default() -> Self {
        Self::new()
    }
}

impl Pattern {
    /// An empty grid: every step silent.
    pub fn new() -> Self {
        Self { steps: [[0.0; STEPS]; TRACKS] }
    }

    /// Return to the as-constructed state.
    pub fn reset(&mut self) {
        self.clear();
    }

    pub fn clear(&mut self) {
        self.steps = [[0.0; STEPS]; TRACKS];
    }

    pub fn velocity(&self, track: usize, step: usize) -> f32 {
        self.steps
            .get(track)
            .and_then(|row| row.get(step))
            .copied()
            .unwrap_or(0.0)
    }

    /// Whether this step sounds. The single place the "zero means off" rule
    /// is spelled out, so the sequencer asks a question rather than repeating
    /// a comparison.
    pub fn is_active(&self, track: usize, step: usize) -> bool {
        self.velocity(track, step) > 0.0
    }

    /// Set one step. Both indices arrive from another thread; an index past
    /// the end of the grid drops the command, and a non-finite velocity is
    /// refused outright, the way every value crossing the ABI is.
    pub fn set_step(&mut self, track: u8, step: u16, velocity: f32) {
        if !velocity.is_finite() {
            return;
        }
        if let Some(slot) = self
            .steps
            .get_mut(usize::from(track))
            .and_then(|row| row.get_mut(usize::from(step)))
        {
            *slot = velocity.clamp(MIN_VELOCITY, MAX_VELOCITY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_pattern_is_silent() {
        let pattern = Pattern::new();
        for track in 0..TRACKS {
            for step in 0..STEPS {
                assert_eq!(pattern.velocity(track, step), 0.0, "track {track} step {step}");
                assert!(!pattern.is_active(track, step), "track {track} step {step}");
            }
        }
    }

    #[test]
    fn every_cell_is_its_own() {
        // A row shared between tracks, or an index computed as track * STEPS +
        // step with the wrong stride, shows up as one pad triggering another.
        // Each cell gets a value no other cell has.
        let mut pattern = Pattern::new();
        for track in 0..TRACKS {
            for step in 0..STEPS {
                pattern.set_step(track as u8, step as u16, velocity_for(track, step));
            }
        }
        for track in 0..TRACKS {
            for step in 0..STEPS {
                assert_eq!(
                    pattern.velocity(track, step),
                    velocity_for(track, step),
                    "track {track} step {step}"
                );
            }
        }
    }

    #[test]
    fn a_zero_velocity_is_a_step_that_does_not_sound() {
        // The decision this module rests on, kept as a test because it is the
        // reason there is no separate on/off flag to go out of step with the
        // velocity.
        let mut pattern = Pattern::new();
        pattern.set_step(2, 5, 0.8);
        assert!(pattern.is_active(2, 5));

        pattern.set_step(2, 5, 0.0);
        assert!(!pattern.is_active(2, 5));
        assert_eq!(pattern.velocity(2, 5), 0.0);
    }

    #[test]
    fn velocity_is_clamped_to_its_range() {
        let mut pattern = Pattern::new();
        for velocity in [-1.0, -0.0001, 1.0001, 1e9] {
            pattern.set_step(0, 0, velocity);
            assert!(
                (MIN_VELOCITY..=MAX_VELOCITY).contains(&pattern.velocity(0, 0)),
                "accepted {velocity}"
            );
        }
    }

    #[test]
    fn a_non_finite_velocity_is_refused_not_clamped() {
        // `f32::clamp` passes NaN through, and a NaN velocity would scale a
        // voice by NaN — which is silence that never ends, on a track that
        // cannot be recovered without a reset.
        let mut pattern = Pattern::new();
        pattern.set_step(1, 1, 0.6);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            pattern.set_step(1, 1, bad);
            assert_eq!(pattern.velocity(1, 1), 0.6, "took {bad}");
        }
    }

    #[test]
    fn indices_past_the_grid_are_dropped_not_wrapped() {
        // Both arrive from another thread — a u8 track and a u16 step — so
        // every value of them is reachable. Writing into a neighbour would
        // turn a bug on the far side into a wrong sound here, and a panic
        // would end the sound entirely under `panic = "abort"`.
        let mut pattern = Pattern::new();
        for track in TRACKS as u8..=u8::MAX {
            pattern.set_step(track, 0, 1.0);
        }
        for step in STEPS as u16..=1_000 {
            pattern.set_step(0, step, 1.0);
        }

        for track in 0..TRACKS {
            for step in 0..STEPS {
                assert_eq!(pattern.velocity(track, step), 0.0, "track {track} step {step}");
            }
        }
        // Reading past the end answers "silent" rather than panicking.
        assert_eq!(pattern.velocity(TRACKS, 0), 0.0);
        assert_eq!(pattern.velocity(0, STEPS), 0.0);
        assert_eq!(pattern.velocity(usize::MAX, usize::MAX), 0.0);
    }

    #[test]
    fn clearing_empties_every_track() {
        let mut pattern = Pattern::new();
        for track in 0..TRACKS as u8 {
            for step in 0..STEPS as u16 {
                pattern.set_step(track, step, 1.0);
            }
        }
        pattern.clear();

        for track in 0..TRACKS {
            for step in 0..STEPS {
                assert!(!pattern.is_active(track, step), "track {track} step {step} survived");
            }
        }
    }

    /// A value unique to each cell, and inside the velocity range.
    fn velocity_for(track: usize, step: usize) -> f32 {
        (track * STEPS + step + 1) as f32 / (TRACKS * STEPS + 1) as f32
    }
}
