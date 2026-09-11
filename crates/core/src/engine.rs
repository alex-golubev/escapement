use escapement_time::tempo::{self, Curve, Mark, Segment, TempoMap};
use escapement_time::{Position, SamplePosition, SampleRate, Span};

use crate::source::{frame, Samples};
use crate::strip::{Level, Strip};

/// Tempo marks the engine can hold.
///
/// One, which is what slice 1 carries across the boundary — the opening mark of
/// the document's map. The array is here rather than a single field because the
/// map is built into it and read back through [`TempoMap::over`], and that is
/// the same code at any count (§2.5).
const TEMPO_MARKS: usize = 1;

/// Where on the route a strip sits.
///
/// Three, which is the longest route a document can ask for: a channel feeds an
/// insert, an insert is heard through the master, and an insert holds no output
/// of its own (§2.6). When the channel feeds the master directly the middle one
/// is left at unity, which changes nothing — the master carried twice would
/// make a half a quarter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// The source's own strip, which is what puts a mono signal between the
    /// speakers.
    Channel,
    /// The strip it feeds.
    Insert,
    /// What everything is finally heard through.
    Master,
}

/// One clip, in both the count it was written in and the one it is played in.
///
/// Both, because neither survives alone: the musical bounds are what the
/// document said and what a new tempo re-reads, and the sample bounds are what
/// a quantum compares against. Working the second out per sample would put a
/// tempo lookup inside the innermost loop for a value that changes when a
/// command arrives.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Clip {
    start: Position,
    length: Span,
    /// Frames into the source, in the source's own count — the third of the
    /// three, and the one that must never be spelled in ticks (§2.5).
    trim: u64,
    from: SamplePosition,
    to: SamplePosition,
}

/// The audio graph: one clip, played through a channel into an insert into the
/// master.
///
/// Everything it can be asked to do is a method here, and none of them know how
/// the asking arrived. The wire encoding lives in `escapement-protocol` and the
/// translation in the worklet, so this crate stays about sound and can be built
/// and tested without either (ARCHITECTURE.md §3).
pub struct Engine {
    rate: SampleRate,
    /// Written by [`tempo::build`] and read back through [`TempoMap::over`].
    tempo: [Segment; TEMPO_MARKS],
    marks: usize,
    clip: Option<Clip>,
    /// Three fields rather than an array behind an index: the index would be a
    /// bounds check the compiler cannot always discharge, and a panic on this
    /// path is one the module has no allocator to format (`rt-safety.md`).
    channel: Strip,
    insert: Strip,
    master: Strip,
    level: Level,
    playing: bool,
    position: SamplePosition,
    clock: u64,
}

impl Engine {
    /// Stopped, silent, and with no tempo.
    ///
    /// **No tempo rather than a default one.** What a project opens at is in the
    /// document (`Timeline::default`), and a second copy of that number here is
    /// one nothing keeps true — so until the interface has sent one, the map is
    /// empty, every position converts at the origin and there is nothing to
    /// play. A transport that has not been started has not been started, either
    /// (§2.4).
    #[must_use]
    pub fn new(rate: SampleRate) -> Self {
        Self {
            rate,
            tempo: [Segment::default(); TEMPO_MARKS],
            marks: 0,
            clip: None,
            channel: Strip::UNITY,
            insert: Strip::UNITY,
            master: Strip::UNITY,
            level: Level::new(rate),
            playing: false,
            position: SamplePosition::ZERO,
            clock: 0,
        }
    }

    /// The tempo the project opens at, and what it does on the way to the next
    /// one.
    ///
    /// Refused rather than kept if it is not a tempo: [`tempo::build`] is what
    /// says so, and a map that failed to build leaves the one before it
    /// standing — the same shape every other control here has.
    pub fn set_tempo(&mut self, beats_per_minute: f64, curve: Curve) {
        let marks = [Mark {
            at: Position::ZERO,
            beats_per_minute,
            curve,
        }];

        if tempo::build(&marks, &mut self.tempo).is_ok() {
            self.marks = marks.len();
            self.replace_clip();
        }
    }

    /// What is on the timeline: where it starts, how long it sounds, and how far
    /// into the source it begins.
    pub fn place_clip(&mut self, start: Position, length: Span, trim: u64) {
        self.clip = Some(Clip {
            start,
            length,
            trim,
            from: SamplePosition::ZERO,
            to: SamplePosition::ZERO,
        });
        self.replace_clip();
    }

    /// Nothing on the timeline, which is silence rather than a stopped
    /// transport.
    pub fn clear_clip(&mut self) {
        self.clip = None;
    }

    /// One strip of the route. Changes take effect over the next few
    /// milliseconds rather than at once — see `strip::Level`.
    pub fn strip(&mut self, stage: Stage) -> &mut Strip {
        match stage {
            Stage::Channel => &mut self.channel,
            Stage::Insert => &mut self.insert,
            Stage::Master => &mut self.master,
        }
    }

    /// What a strip is set to, which is what the engine kept rather than what
    /// it was sent: a value it refused leaves the one before it standing.
    #[must_use]
    pub fn strip_at(&self, stage: Stage) -> Strip {
        match stage {
            Stage::Channel => self.channel,
            Stage::Insert => self.insert,
            Stage::Master => self.master,
        }
    }

    /// Called after any change to a strip, so the ramp has somewhere to walk to.
    pub fn strips_changed(&mut self) {
        if self.playing {
            let (left, right) = self.route();
            self.level.towards(left, right);
        }
    }

    /// Run the transport from `at`.
    ///
    /// The position is the whole of what §2.4 asks for on this side — "start at
    /// position P at host time T", of which P is here and T is
    /// `Command.when`, still ignored.
    pub fn start(&mut self, at: Position) {
        self.playing = true;
        self.position = self.sample_at(at);
        let (left, right) = self.route();
        self.level.towards(left, right);
    }

    /// Stop it, over a few milliseconds rather than at once — a step to zero
    /// mid-cycle is a click.
    ///
    /// The position keeps moving while what is left of the sound fades, because
    /// those samples are being played. It comes to rest where the sound did.
    pub fn stop(&mut self) {
        self.playing = false;
        self.level.fade_out();
    }

    /// Renders one block into two channels, and moves the clock by it whether or
    /// not the transport is running.
    ///
    /// Both sides are overwritten, to whichever of the two is shorter. The
    /// length is the caller's, not a constant here — the offline render for
    /// export drives this same engine in blocks of its own choosing.
    pub fn process<S: Samples>(
        &mut self,
        samples: Option<&S>,
        left: &mut [f32],
        right: &mut [f32],
    ) {
        let mut rendered = 0usize;

        for (out_left, out_right) in left.iter_mut().zip(right.iter_mut()) {
            rendered += 1;
            let (gain_left, gain_right) = self.level.next();

            // Stopped and faded out: nothing is read and the position stays
            // where the sound left it. Muted mid-play is not this case — the
            // transport is running, so it goes on running.
            if !self.playing && gain_left == 0.0 && gain_right == 0.0 {
                *out_left = 0.0;
                *out_right = 0.0;
                continue;
            }

            let mono = self.sample(samples);
            *out_left = mono * gain_left;
            *out_right = mono * gain_right;
            self.position = self.position.advanced_by(1);
        }

        // Wrapping, so that nothing on this path can panic in a debug build.
        // At 48 kHz the wrap is twelve million years out.
        self.clock = self.clock.wrapping_add(rendered as u64);
    }

    /// Samples produced since the engine was built. Monotonic, running whether
    /// or not the transport is, and what a scheduled command's moment is
    /// measured against — never a position on a timeline (§2.5).
    #[must_use]
    pub const fn clock(&self) -> u64 {
        self.clock
    }

    /// Where the transport stands, in samples from the timeline's origin.
    #[must_use]
    pub const fn position(&self) -> SamplePosition {
        self.position
    }

    /// What the transport is actually doing, which is what a button should
    /// follow rather than what it was last told.
    #[must_use]
    pub const fn playing(&self) -> bool {
        self.playing
    }

    /// The frame under the playhead, or silence where the clip is not.
    fn sample<S: Samples>(&self, samples: Option<&S>) -> f32 {
        let (Some(samples), Some(clip)) = (samples, self.clip) else {
            return 0.0;
        };
        if self.position < clip.from || self.position >= clip.to {
            return 0.0;
        }

        let into = u64::try_from(self.position.since(clip.from)).unwrap_or(0);
        let index = clip.trim.saturating_add(into);
        frame(samples, usize::try_from(index).unwrap_or(usize::MAX))
    }

    /// The pair of gains the three strips come to.
    fn route(&self) -> (f32, f32) {
        let (mut left, mut right) = self.channel.spread();
        for strip in [self.insert, self.master] {
            let (side_left, side_right) = strip.balance();
            left *= side_left;
            right *= side_right;
        }
        (left, right)
    }

    /// Where a musical position falls, in samples from the timeline's origin.
    fn sample_at(&self, position: Position) -> SamplePosition {
        // `get` rather than a range index: the second one panics through
        // `slice_index_fail`, which formats its message — and a formatted panic
        // message pulls a `String`, and with it an allocator, into the module
        // that must not have one (`.claude/rules/rt-safety.md`).
        let map = TempoMap::over(self.tempo.get(..self.marks).unwrap_or(&[]));
        SamplePosition::at(map.seconds_at(position), self.rate)
    }

    /// Works the clip's bounds out again — after a new clip, and after a tempo
    /// that moves every position after it.
    fn replace_clip(&mut self) {
        let Some(clip) = self.clip else {
            return;
        };

        self.clip = Some(Clip {
            from: self.sample_at(clip.start),
            to: self.sample_at(clip.start + clip.length),
            ..clip
        });
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::indexing_slicing,
        reason = "a test reaching into what it built: an index out of range is \
                  how it fails"
    )]

    use super::*;
    use crate::fixtures::{rate, RATE_HZ};
    use crate::{Frames, RENDER_QUANTUM};

    /// Nothing published, spelled once: `None` needs a type even where there is
    /// no value.
    const NOTHING: Option<&Frames<'static>> = None;

    /// A second at 120 beats a minute is two quarters, so a quarter is half a
    /// second and every number below is arithmetic anyone can check.
    const TEMPO: f64 = 120.0;

    fn engine() -> Engine {
        let mut engine = Engine::new(rate());
        engine.set_tempo(TEMPO, Curve::Hold);
        engine
    }

    /// Long enough that a five-millisecond ramp has finished inside it.
    fn quantum(engine: &mut Engine, samples: Option<&Frames<'_>>) -> ([f32; 2048], [f32; 2048]) {
        let mut left = [0.0; 2048];
        let mut right = [0.0; 2048];
        engine.process(samples, &mut left, &mut right);
        (left, right)
    }

    fn peak(block: &[f32]) -> f32 {
        block
            .iter()
            .fold(0.0f32, |top, sample| top.max(sample.abs()))
    }

    /// Every value differs from every other, so a cursor that slips shows up as
    /// a value rather than as a level.
    fn source() -> [f32; 96_000] {
        let mut held = [0.0; 96_000];
        for (index, slot) in held.iter_mut().enumerate() {
            *slot = ((index % 997) as f32) / 997.0 + 0.001;
        }
        held
    }

    #[test]
    fn a_new_engine_is_stopped_and_silent() {
        let mut engine = engine();
        let (left, right) = quantum(&mut engine, NOTHING);

        assert!(!engine.playing());
        assert_eq!(peak(&left), 0.0);
        assert_eq!(peak(&right), 0.0);
    }

    #[test]
    fn the_clock_runs_whether_or_not_the_transport_does() {
        let mut engine = engine();
        let mut left = [0.0; RENDER_QUANTUM];
        let mut right = [0.0; RENDER_QUANTUM];

        engine.process(NOTHING, &mut left, &mut right);
        assert_eq!(engine.clock(), RENDER_QUANTUM as u64);

        engine.start(Position::ZERO);
        engine.process(NOTHING, &mut left, &mut right);
        assert_eq!(engine.clock(), 2 * RENDER_QUANTUM as u64);
    }

    /// The whole of slice 1 in one test: a clip laid at a position sounds from
    /// there and stops where it ends.
    #[test]
    fn a_clip_sounds_between_its_bounds_and_nowhere_else() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();

        // A quarter in, a quarter long: half a second to a second at 120.
        engine.place_clip(Position::quarters(1), Span::QUARTER, 0);
        engine.start(Position::ZERO);

        let mut left = [0.0; 24_000];
        let mut right = [0.0; 24_000];
        engine.process(Some(&samples), &mut left, &mut right);
        assert_eq!(peak(&left), 0.0, "before the clip starts");

        engine.process(Some(&samples), &mut left, &mut right);
        assert!(peak(&left) > 0.0, "inside the clip");

        engine.process(Some(&samples), &mut left, &mut right);
        assert_eq!(peak(&left), 0.0, "after the clip ends");
    }

    /// The bounds are half-open, the way a sample's own interval is (§2.5): the
    /// first sample of the clip sounds and the one its end names does not.
    /// Closed at both ends, two clips that touch overlap by a sample.
    #[test]
    fn a_clip_sounds_at_its_first_sample_and_not_at_its_last() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        // A quarter is 24 000 samples at 120, so this clip is [0, 24 000).
        engine.place_clip(Position::ZERO, Span::QUARTER, 0);

        engine.start(Position::ZERO);

        // The first sample of the clip, on its own: the bound is closed at this
        // end, and a guard that excluded it would drop exactly this one.
        let mut first = [0.0; 1];
        let mut first_right = [0.0; 1];
        engine.process(Some(&samples), &mut first, &mut first_right);
        assert_ne!(first[0], 0.0, "the clip's first sample was silent");

        // On to one sample before the end. The ramp is long over by then.
        let mut warm = [0.0; 23_998];
        let mut warm_right = [0.0; 23_998];
        engine.process(Some(&samples), &mut warm, &mut warm_right);

        let mut last = [0.0; 1];
        let mut last_right = [0.0; 1];
        engine.process(Some(&samples), &mut last, &mut last_right);
        assert_ne!(last[0], 0.0, "the sample before the end was silent");

        let mut past = [0.0; 1];
        let mut past_right = [0.0; 1];
        engine.process(Some(&samples), &mut past, &mut past_right);
        assert_eq!(past[0], 0.0, "the sample at the end sounded");
    }

    /// Nothing on the timeline is silence, and it is not the same thing as a
    /// stopped transport — the clock and the position go on.
    #[test]
    fn a_cleared_clip_is_silence_under_a_running_transport() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.start(Position::ZERO);
        let (loud, _) = quantum(&mut engine, Some(&samples));
        assert!(peak(&loud) > 0.0);

        engine.clear_clip();
        let (quiet, _) = quantum(&mut engine, Some(&samples));

        assert_eq!(peak(&quiet), 0.0, "the clip was cleared and still sounded");
        assert!(engine.playing(), "clearing a clip stopped the transport");
    }

    /// A control moved while the transport runs has to reach the ramp, which is
    /// what `strips_changed` is for: `start` is the only other place the route
    /// is worked out, and it has already happened.
    #[test]
    fn a_strip_moved_mid_play_reaches_the_sound() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.start(Position::ZERO);
        let (loud, _) = quantum(&mut engine, Some(&samples));

        engine.strip(Stage::Master).set_gain(0.1);
        engine.strips_changed();
        let (quiet, _) = quantum(&mut engine, Some(&samples));

        assert!(
            peak(&quiet) < peak(&loud) * 0.5,
            "a gain moved mid-play did not reach the sound: {} against {}",
            peak(&quiet),
            peak(&loud)
        );
    }

    /// The transport starts where it is told, which is what §2.4 asks for.
    #[test]
    fn starting_at_a_position_starts_there() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::quarters(1), Span::QUARTER, 0);

        engine.start(Position::quarters(1));
        assert_eq!(engine.position().samples(), 24_000, "half a second in");

        let (left, _) = quantum(&mut engine, Some(&samples));
        assert!(peak(&left) > 0.0, "inside the clip from the first sample");
    }

    /// The third count, doing its job: the clip begins that many frames into
    /// the file, and the file's own frames are not ticks.
    #[test]
    fn a_trim_moves_the_reading_into_the_source_and_not_the_clip() {
        let held = source();
        let samples = Frames::new(&held, 1);

        let mut plain = engine();
        plain.place_clip(Position::ZERO, Span::QUARTER, 0);
        plain.start(Position::ZERO);

        let mut trimmed = engine();
        trimmed.place_clip(Position::ZERO, Span::QUARTER, 1_000);
        trimmed.start(Position::ZERO);

        let (first, _) = quantum(&mut plain, Some(&samples));
        let (second, _) = quantum(&mut trimmed, Some(&samples));

        assert_ne!(first, second, "the same clip read from the same place");
        // The two are the same signal a thousand frames apart, which is what
        // says the trim moved the reading and not the clip: both are past the
        // ramp here, and both carry the same pan law.
        for at in [500, 900, 1_000] {
            assert!(
                (second[at] - first[at + 1_000]).abs() < 1e-6,
                "sample {at} is not a thousand frames ahead"
            );
        }
    }

    /// A tempo that arrives after the clip moves it, because the clip is held
    /// in musical time and the bounds are worked out from it.
    #[test]
    fn a_new_tempo_moves_a_clip_already_placed() {
        let mut engine = engine();
        engine.place_clip(Position::quarters(1), Span::QUARTER, 0);
        engine.start(Position::ZERO);

        engine.set_tempo(60.0, Curve::Hold);
        engine.start(Position::quarters(1));
        assert_eq!(
            engine.position().samples(),
            48_000,
            "a quarter at 60 is a whole second"
        );
    }

    /// Until a tempo arrives there is no map, and a position converts at the
    /// origin rather than at a number invented here.
    #[test]
    fn an_engine_with_no_tempo_has_nothing_to_play() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = Engine::new(rate());
        engine.place_clip(Position::quarters(4), Span::QUARTER, 0);
        engine.start(Position::quarters(4));

        let (left, right) = quantum(&mut engine, Some(&samples));
        assert_eq!(peak(&left), 0.0);
        assert_eq!(peak(&right), 0.0);
    }

    /// Equal power at the channel, balance above it: a route left entirely
    /// alone is −3 dB on each side rather than unity, and that is the pan law
    /// rather than a gain applied by accident.
    #[test]
    fn a_centred_route_puts_the_source_evenly_between_the_speakers() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.start(Position::ZERO);

        let (left, right) = quantum(&mut engine, Some(&samples));
        assert_eq!(left, right, "the centre is even");
        assert!((peak(&left) - peak(&right)).abs() < 1e-6);
    }

    #[test]
    fn a_channel_panned_hard_over_leaves_one_side_silent() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.strip(Stage::Channel).set_pan(-1.0);
        engine.start(Position::ZERO);

        let (left, right) = quantum(&mut engine, Some(&samples));
        assert!(peak(&left) > 0.0);
        assert_eq!(peak(&right), 0.0);
    }

    /// Each stage on its own, because one multiplication standing in for three
    /// passes a test where only one of them is moved.
    #[test]
    fn every_stage_on_the_route_is_heard() {
        let held = source();
        let samples = Frames::new(&held, 1);

        let mut full = engine();
        full.place_clip(Position::ZERO, Span::quarters(4), 0);
        full.start(Position::ZERO);
        let (loud, _) = quantum(&mut full, Some(&samples));

        for stage in [Stage::Channel, Stage::Insert, Stage::Master] {
            let mut engine = engine();
            engine.place_clip(Position::ZERO, Span::quarters(4), 0);
            engine.strip(stage).set_gain(0.5);
            engine.strips_changed();
            engine.start(Position::ZERO);

            let (quiet, _) = quantum(&mut engine, Some(&samples));
            assert!(
                peak(&quiet) < peak(&loud),
                "a gain at {stage:?} changed nothing"
            );
        }
    }

    #[test]
    fn a_muted_stage_anywhere_on_the_route_is_silence() {
        let held = source();
        let samples = Frames::new(&held, 1);

        for stage in [Stage::Channel, Stage::Insert, Stage::Master] {
            let mut engine = engine();
            engine.place_clip(Position::ZERO, Span::quarters(4), 0);
            engine.strip(stage).set_mute(true);
            engine.strips_changed();
            engine.start(Position::ZERO);

            let (left, right) = quantum(&mut engine, Some(&samples));
            assert_eq!(peak(&left), 0.0, "muted at {stage:?}");
            assert_eq!(peak(&right), 0.0, "muted at {stage:?}");
        }
    }

    /// The transport keeps running under a mute: what stops is the sound, and
    /// unmuting lands where the music got to rather than where it was silenced.
    #[test]
    fn a_mute_stops_the_sound_and_not_the_transport() {
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.strip(Stage::Master).set_mute(true);
        engine.strips_changed();
        engine.start(Position::ZERO);

        let mut left = [0.0; 4_800];
        let mut right = [0.0; 4_800];
        engine.process(NOTHING, &mut left, &mut right);

        assert_eq!(engine.position().samples(), 4_800);
    }

    /// A step to zero is a click, so a stop is a fade — and the fade is
    /// measured in samples, which is what makes the file match what was heard
    /// (`.claude/rules/rt-safety.md`).
    #[test]
    fn a_stop_fades_rather_than_stepping_to_zero() {
        let held = source();
        let samples = Frames::new(&held, 1);
        let mut engine = engine();
        engine.place_clip(Position::ZERO, Span::quarters(4), 0);
        engine.start(Position::ZERO);
        quantum(&mut engine, Some(&samples));

        engine.stop();
        let mut left = [0.0; RENDER_QUANTUM];
        let mut right = [0.0; RENDER_QUANTUM];
        engine.process(Some(&samples), &mut left, &mut right);

        assert!(
            peak(&left) > 0.0,
            "the first quantum after a stop is a tail"
        );

        // Well past the fade: silent, and the position has come to rest.
        let mut long = [0.0; 4_800];
        let mut long_right = [0.0; 4_800];
        engine.process(Some(&samples), &mut long, &mut long_right);
        let resting = engine.position();
        engine.process(Some(&samples), &mut long, &mut long_right);

        assert_eq!(peak(&long), 0.0, "faded out");
        assert_eq!(engine.position(), resting, "and stopped moving");
    }

    #[test]
    fn a_strip_reports_what_the_engine_kept_rather_than_what_it_was_sent() {
        let mut engine = engine();
        engine.strip(Stage::Channel).set_gain(0.5);
        engine.strip(Stage::Channel).set_gain(f32::NAN);

        assert_eq!(engine.strip_at(Stage::Channel).gain(), 0.5);
    }

    /// A tempo that is not one is refused by `tempo::build`, and what was
    /// already there goes on playing.
    #[test]
    fn a_tempo_that_is_not_one_leaves_the_map_standing() {
        let mut engine = engine();
        engine.place_clip(Position::quarters(1), Span::QUARTER, 0);

        engine.set_tempo(f64::NAN, Curve::Hold);
        engine.start(Position::quarters(1));

        assert_eq!(
            engine.position().samples(),
            24_000,
            "still the map built at {TEMPO}"
        );
    }

    /// The rate is the conversion's, and an offline render at another one is
    /// the case this has to hold for (§2.5).
    #[test]
    fn a_position_converts_at_the_rate_the_engine_was_built_with() {
        let half = SampleRate::new(RATE_HZ / 2.0).expect("half of a rate is a rate");
        let mut engine = Engine::new(half);
        engine.set_tempo(TEMPO, Curve::Hold);
        engine.start(Position::quarters(1));

        assert_eq!(engine.position().samples(), 12_000);
    }
}
