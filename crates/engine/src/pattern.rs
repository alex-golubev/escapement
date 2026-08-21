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
//! Both indices here cross the ABI and are dropped when the grid has no room
//! for them, for the reason [`Command`](crate::commands::Command) gives.

use crate::TRACKS;
use crate::dsp::clamped;

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
        Self {
            steps: [[0.0; STEPS]; TRACKS],
        }
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
    /// the end of the grid drops the command, and the velocity goes through
    /// [`dsp::clamped`](crate::dsp) like every value crossing the ABI.
    ///
    /// What the flush in that guard means *here* is worth knowing, because this
    /// grid is where it stops being about arithmetic: a flushed velocity is a
    /// step that is simply off, since [`is_active`](Self::is_active) asks only
    /// whether the value is above zero. Without it, `1e-40` would be a step that
    /// counts as struck and scales a voice by a denormal on every frame it
    /// sounds.
    pub fn set_step(&mut self, track: u8, step: u16, velocity: f32) {
        if let (Some(slot), Some(velocity)) = (
            self.steps
                .get_mut(usize::from(track))
                .and_then(|row| row.get_mut(usize::from(step))),
            clamped(velocity, MIN_VELOCITY, MAX_VELOCITY),
        ) {
            *slot = velocity;
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
                assert_eq!(
                    pattern.velocity(track, step),
                    0.0,
                    "track {track} step {step}"
                );
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
    fn a_denormal_velocity_is_not_a_struck_step() {
        // What the flush in `dsp::clamped` amounts to on this grid, which is
        // the pattern's own property and the reason it matters here at all:
        // `is_active` asks only whether the value is above zero, so a flushed
        // step is an *off* step. Stated through `is_active` and not just
        // through the stored number, because being active is what makes it cost
        // a voice.
        let mut pattern = Pattern::new();
        pattern.set_step(4, 4, 1e-40);
        assert_eq!(pattern.velocity(4, 4), 0.0);
        assert!(!pattern.is_active(4, 4), "a denormal counted as a strike");
    }

    #[test]
    fn a_refused_velocity_leaves_the_step_as_it_was() {
        // The pattern's answer to a refusal, which the guard does not make: the
        // cell keeps what it held rather than falling silent. One specimen —
        // every dangerous input is enumerated in `dsp`.
        let mut pattern = Pattern::new();
        pattern.set_step(1, 1, 0.6);
        pattern.set_step(1, 1, f32::NAN);
        assert_eq!(pattern.velocity(1, 1), 0.6, "a NaN emptied the step");
    }

    #[test]
    fn indices_past_the_grid_are_dropped_not_wrapped() {
        // What would be heard: every strike in the pattern landing on one
        // row, while an assertion about "the step" went on passing.
        let mut pattern = Pattern::new();
        for track in TRACKS as u8..=u8::MAX {
            pattern.set_step(track, 0, 1.0);
        }
        for step in STEPS as u16..=1_000 {
            pattern.set_step(0, step, 1.0);
        }

        for track in 0..TRACKS {
            for step in 0..STEPS {
                assert_eq!(
                    pattern.velocity(track, step),
                    0.0,
                    "track {track} step {step}"
                );
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
                assert!(
                    !pattern.is_active(track, step),
                    "track {track} step {step} survived"
                );
            }
        }
    }

    /// A value unique to each cell, and inside the velocity range.
    fn velocity_for(track: usize, step: usize) -> f32 {
        (track * STEPS + step + 1) as f32 / (TRACKS * STEPS + 1) as f32
    }
}
