//! Reading the step grid in time: which step a sample position falls on, where
//! the next one begins, and what a step does when it arrives.
//!
//! **Nothing here is remembered between frames.** The step is computed from the
//! transport position every time it is asked for, never advanced by a counter —
//! the same rule that keeps musical position derived rather than accumulated,
//! and for a sharper reason than drift: a counter would have to be told about a
//! tempo change and about a rewind, and the two places that would tell it are
//! the two places nobody thinks about while writing a sequencer. Computed, the
//! step is right after both by construction.
//!
//! Which is why this is a handful of functions and not a type: there is no state
//! to own. The walk over frames stays in the engine, threaded between the
//! metronome and the sum; what lives here is the arithmetic it asks for — and
//! the arithmetic the telemetry asks for on its way out — where it can be
//! checked against the grid rather than against a rendered buffer.

use crate::TRACKS;
use crate::pattern::{Pattern, STEPS};
use crate::sampler::Sampler;
use crate::transport::Transport;

/// Divisions of a beat the grid is laid out in — four, i.e. sixteenths.
///
/// With [`STEPS`] at sixteen the pattern is exactly four beats, which is what
/// makes the metronome's accent land on step 0 rather than wander across the
/// grid; the two numbers are independent, and that they agree is worth knowing
/// before either is changed.
///
/// Declared here rather than beside [`STEPS`] because the pattern knows nothing
/// about time: it is a table of velocities, and a table has no tempo. Reading
/// that table *in time* is this module's whole subject, and the resolution is
/// the first thing it needs.
pub const STEPS_PER_BEAT: u32 = 4;

/// The step sounding at `pos`, wrapped into the pattern.
///
/// **Rounded, not truncated.** A boundary is a musical position rounded to a
/// whole sample, so asking a boundary for its musical position lands just off
/// the integer — and it lands on either side of it. On the low side truncation
/// answers with the step before: the grid then plays every step twice, once
/// under its own number and once under the next, and a full pattern sounds
/// entirely correct while doing it.
pub fn step_at(transport: &Transport, pos: u64) -> usize {
    let division = transport.division_at(pos, STEPS_PER_BEAT).round() as i64;
    division.rem_euclid(STEPS as i64) as usize
}

/// Where the grid stands at `pos`, in steps, wrapped into the pattern.
///
/// The telemetry word a playhead is drawn from, and it exists because this sum
/// cannot be done on the far side: samples become musical position only through
/// the tempo anchor, and the anchor is here. A page counting from the BPM it
/// last sent would be right until the first tempo change and wrong after it —
/// a second representation of musical time, which is the one thing
/// [`Transport`] exists to keep from happening.
///
/// **Fractional**, where [`step_at`] answers with a step number. The two are
/// different questions: which cell strikes, and where between the cells the
/// playhead is. An integer would leave the page interpolating, and interpolating
/// needs the tempo — the very thing this word is carrying instead.
///
/// **Wrapped**, rather than counted from the start of the session and reduced by
/// the page. That reads cleaner and keeps [`STEPS`] off the wire, and it decays:
/// an unwrapped count grows without bound and the spacing of an `f32` grows with
/// it, so by the eighth hour of a session the word is quantized to milliseconds.
/// Wrapped, it is also the sequencer's own state — which step is playing —
/// rather than a number the page has to reduce to that.
///
/// **`floor` of this and [`step_at`] can disagree by one, and only ever on a
/// boundary sample.** A boundary is a musical position rounded to a whole
/// sample, so asking one for its musical position lands a hair to either side of
/// the integer — [`step_at`] rounds for that reason, and this does not, a
/// position being neither the step before nor the step after. The two are asked
/// of the same instant only when a quantum ends exactly on a boundary, which is
/// regular rather than rare; what it costs is a cell lit one displayed frame
/// early or late, a tenth of a sample of disagreement. Named here because the
/// place it shows is the page, and the place it would be searched for is this
/// module.
pub fn position_in_steps(transport: &Transport, pos: u64) -> f32 {
    let wrapped = transport
        .division_at(pos, STEPS_PER_BEAT)
        .rem_euclid(STEPS as f64);
    // Wrapped a second time after the narrowing, which is not the first wrap
    // repeated. Just below sixteen an `f32` steps by 1.9e-6, so a position
    // inside half of that rounds *up* to the modulus — and the wrap that exists
    // to keep the value inside the pattern would hand out the one index the grid
    // does not have. The reading is right against the position either way: a
    // hair short of the end of the last step is a hair short of the start of the
    // first.
    (wrapped as f32).rem_euclid(STEPS as f32)
}

/// The nearest step boundary at or after `pos`.
///
/// A wrapper, so that the reason boundaries are counted from `floor` stays in
/// the one place it is argued — [`Transport::next_division_boundary`] — rather
/// than being restated by every musical unit that needs one.
pub fn next_boundary(transport: &Transport, pos: u64) -> u64 {
    transport.next_division_boundary(pos, STEPS_PER_BEAT)
}

/// Strike every track whose cell on this step is active.
///
/// Asks [`Pattern::is_active`] rather than comparing a velocity against zero:
/// what "off" means belongs to the grid, and a second copy of the comparison
/// here is a second place for it to mean something else.
///
/// The strike itself goes through [`Sampler::trigger`] and will keep going
/// through it when a preview command arrives with a second caller — a pad that
/// sounded unlike the grid it is editing would be heard long before anyone
/// thought to look for two doors.
pub fn strike(pattern: &Pattern, sampler: &mut Sampler, step: usize) {
    for track in 0..TRACKS {
        if pattern.is_active(track, step) {
            sampler.trigger(track as u8, pattern.velocity(track, step));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;
    /// A tempo whose beat is not a whole number of samples: 60/127*48000 =
    /// 22677.165..., so a sixteenth is 5669.29... Round tempos hide exactly the
    /// rounding this module is made of.
    const AWKWARD_BPM: f64 = 127.0;
    /// Long enough that a wrap of the pattern is crossed several times.
    const BARS: usize = 4;

    fn at(bpm: f64) -> Transport {
        let mut transport = Transport::new(SR);
        transport.set_bpm(bpm);
        transport.play();
        transport
    }

    /// Every boundary in order, walked one at a time the way the render loop
    /// walks them.
    fn boundaries(transport: &Transport, count: usize) -> Vec<u64> {
        let mut pos = 0u64;
        (0..count)
            .map(|_| {
                let boundary = next_boundary(transport, pos);
                pos = boundary + 1;
                boundary
            })
            .collect()
    }

    /// The milestone's criterion, at the level where it is still arithmetic:
    /// onsets stand at `round(step × samples_per_step)`.
    #[test]
    fn boundaries_stand_where_the_grid_says_they_do() {
        for bpm in [120.0, AWKWARD_BPM, 999.0] {
            let transport = at(bpm);
            let expected: Vec<u64> = (0..STEPS * BARS)
                .map(|step| transport.sample_of_division(step as f64, STEPS_PER_BEAT))
                .collect();

            assert_eq!(boundaries(&transport, STEPS * BARS), expected, "bpm={bpm}");
        }
    }

    #[test]
    fn every_boundary_names_its_own_step() {
        // The one thing a full grid cannot check: with every cell struck, a step
        // number computed one off — or never wrapped — sounds exactly right.
        let transport = at(AWKWARD_BPM);
        for (index, boundary) in boundaries(&transport, STEPS * BARS).into_iter().enumerate() {
            assert_eq!(
                step_at(&transport, boundary),
                index % STEPS,
                "boundary {index}"
            );
        }
    }

    #[test]
    fn the_grid_starts_on_the_very_first_sample() {
        let transport = at(AWKWARD_BPM);
        assert_eq!(next_boundary(&transport, 0), 0);
        assert_eq!(step_at(&transport, 0), 0);
    }

    #[test]
    fn a_tempo_change_neither_repeats_nor_skips_a_step() {
        // A tempo change drops an anchor wherever the transport happens to be,
        // and everything musical is counted from that anchor afterwards. The
        // grid has to go on counting from the start of the *pattern* regardless
        // — so the step after a change made just past step 3 is step 4, at the
        // new tempo's spacing. Counting from the anchor instead would restart
        // the pattern at every tempo change, which is audible as a grid that
        // jumps back to its first step.
        let mut transport = at(120.0);
        let third = transport.sample_of_division(3.0, STEPS_PER_BEAT);
        assert_eq!(step_at(&transport, third), 3, "the fixture missed step 3");

        transport.advance(third as u32 + 1);
        transport.set_bpm(AWKWARD_BPM);

        let fourth = next_boundary(&transport, transport.sample_pos());
        assert_eq!(
            step_at(&transport, fourth),
            4,
            "the step after a tempo change"
        );
        assert!(fourth > third, "the grid stepped backwards");
    }

    #[test]
    fn the_word_is_measured_in_steps() {
        // The unit, checked against something other than the function that
        // computes it. At 120 BPM and 48 kHz a step is 6000 samples, so a
        // quarter of the way into step 3 is 3.25 and nothing else: the same
        // instant reads 0.8125 in beats and 19 500 in samples, and a word
        // carrying either would pass every other test here.
        let transport = at(120.0);
        assert_eq!(position_in_steps(&transport, 0), 0.0);
        assert_eq!(position_in_steps(&transport, 6_000 * 3 + 1_500), 3.25);
        assert_eq!(position_in_steps(&transport, 6_000 * 15 + 3_000), 15.5);
    }

    #[test]
    fn the_word_wraps_with_the_pattern() {
        // The wrap is the whole difference between this word and a count of
        // steps since the transport started, and the two agree for the first
        // bar — which is exactly as far as a test that renders a little way
        // would ever look.
        let transport = at(120.0);
        let bar = 6_000 * STEPS as u64;
        assert_eq!(position_in_steps(&transport, bar), 0.0);
        assert_eq!(position_in_steps(&transport, bar + 6_000), 1.0);
        assert_eq!(position_in_steps(&transport, 4 * bar + 3_000), 0.5);
    }

    #[test]
    fn the_word_never_leaves_the_pattern() {
        // A stride that shares no factor with the grid, so the samples looked
        // at are not the ones a boundary lands on.
        let transport = at(AWKWARD_BPM);
        let span = transport.sample_of_division((STEPS * BARS) as f64, STEPS_PER_BEAT);
        for pos in (0..span).step_by(97) {
            let word = position_in_steps(&transport, pos);
            assert!(
                (0.0..STEPS as f32).contains(&word),
                "{word} is outside the pattern at {pos}"
            );
        }
    }

    #[test]
    fn a_position_a_hair_short_of_the_pattern_wraps_rather_than_landing_past_it() {
        // The second wrap in `position_in_steps`, and the value that makes it
        // more than the first one written twice. The middle assertion is the
        // defect itself: a position genuinely inside the pattern comes out of
        // the narrowing sitting on the modulus, which floors to an index the
        // grid does not have.
        //
        // The rate is absurd on purpose — `engine_new` takes what it is given,
        // and the guard is about the narrowing rather than about the rate. What
        // it needs is a step long enough that a sample lands within half an
        // `f32` ulp of the end of the pattern: just under sixteen that ulp is
        // 9.54e-7, so the fixture sits 2.5e-7 short of the wrap and a fixture
        // twice as far away would round the other way and prove nothing.
        let mut transport = Transport::new(1e12);
        transport.set_bpm(120.0);
        let pos = 1_999_999_968_750;

        let wide = transport
            .division_at(pos, STEPS_PER_BEAT)
            .rem_euclid(STEPS as f64);
        assert!(
            wide < STEPS as f64,
            "the fixture must sit inside the pattern"
        );
        assert_eq!(
            wide as f32, STEPS as f32,
            "the fixture must round up when narrowed"
        );

        assert_eq!(position_in_steps(&transport, pos), 0.0);
    }

    #[test]
    fn the_word_floors_to_the_step_the_grid_is_striking() {
        // What the page does with the word is take its floor, so that is what
        // has to agree with the strike. Inside a step it agrees exactly; on the
        // boundary sample the two are asked of the same instant, and the
        // tolerance below is the one `position_in_steps` argues for — asserting
        // equality there would be asserting that a rounded boundary lands on
        // the high side of its integer, which is true of some tempi and not of
        // others.
        let transport = at(AWKWARD_BPM);
        for (index, boundary) in boundaries(&transport, STEPS * BARS).into_iter().enumerate() {
            let step = index % STEPS;
            let next = next_boundary(&transport, boundary + 1);
            for pos in [boundary + 1, (boundary + next) / 2, next - 1] {
                let lit = position_in_steps(&transport, pos).floor() as usize;
                assert_eq!(lit, step, "sample {pos} lit the wrong cell");
            }

            let lit = position_in_steps(&transport, boundary).floor() as usize;
            assert!(
                lit == step || lit == (step + STEPS - 1) % STEPS,
                "boundary {index} is step {step} and lit {lit}"
            );
        }
    }

    /// A kit of one-frame impulses, one per track: a struck voice then writes
    /// exactly one non-zero frame whose value is its velocity.
    fn impulse_kit() -> Sampler {
        let mut sampler = Sampler::new(SR);
        sampler
            .reserve(TRACKS)
            .expect("the arena must be granted")
            .fill(1.0);
        for slot in 0..TRACKS {
            assert_eq!(sampler.commit(slot, slot, 1, 1), Ok(()), "slot {slot}");
        }
        sampler
    }

    fn one_frame(sampler: &mut Sampler) -> [[f32; 2]; TRACKS] {
        let mut out = [[0.0f32; 2]; TRACKS];
        sampler.next_frame(&mut out);
        out
    }

    #[test]
    fn a_cell_strikes_its_own_track_with_its_own_velocity() {
        // Two rows and two steps, all four velocities distinct: a row read from
        // the wrong track, or a step from the wrong column, changes which value
        // comes back rather than whether anything does.
        let mut pattern = Pattern::new();
        pattern.set_step(1, 3, 0.25);
        pattern.set_step(6, 3, 0.5);
        pattern.set_step(1, 4, 0.75);
        let mut sampler = impulse_kit();

        strike(&pattern, &mut sampler, 3);

        let out = one_frame(&mut sampler);
        assert_eq!(
            out[1][0], 0.25,
            "track 1 did not strike at its own velocity"
        );
        assert_eq!(out[6][0], 0.5, "track 6 did not strike at its own velocity");
        for track in [0, 2, 3, 4, 5, 7] {
            assert_eq!(out[track][0], 0.0, "track {track} struck without a cell");
        }
    }

    #[test]
    fn a_step_with_nothing_on_it_strikes_nothing() {
        // Zero is a step switched off — the grid's rule, asked for by name here
        // rather than restated. That the pool would refuse such a strike anyway
        // is its own guarantee and is checked where the pool can be seen; what
        // this says is that the strike is not made.
        let mut pattern = Pattern::new();
        pattern.set_step(2, 9, 1.0);
        let mut sampler = impulse_kit();

        strike(&pattern, &mut sampler, 5);

        let out = one_frame(&mut sampler);
        assert!(
            out.iter().all(|track| track == &[0.0, 0.0]),
            "an empty step sounded"
        );
    }
}
