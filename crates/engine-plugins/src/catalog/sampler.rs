//! A one-shot sampler: each note plays its sample's sound once, from start to end, frame for frame. Notes overlap, each
//! in a voice of its own. No volume of its own: its channel's sets how loud.

use crate::envelope::GIVE_WAY_SECONDS;
use crate::smoothing::ramp_samples;
use crate::{
    Event, Plugin, PluginDescription, ProcessContext, SampleDescription, SampleNumber, SampleRate,
    SampleReader, Step, steps,
};

const SAMPLE_SOUND: SampleDescription = SampleDescription {
    id: "sample",
    label: "Sample",
};

pub const DESCRIPTION: PluginDescription = PluginDescription {
    id: 3,
    version: 1,
    label: "Sampler",
    params: &[],
    samples: &[SAMPLE_SOUND],
};

pub const SAMPLE: SampleNumber = SampleNumber::of(DESCRIPTION.samples, SAMPLE_SOUND.id);

/// Notes that sound at once; one more fades the oldest out.
pub const VOICES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Free,
    Playing,
    /// Samples left until it is silent.
    Fading(u32),
}

#[derive(Clone, Copy)]
struct Voice {
    state: State,
    /// The sound's next frame.
    position: usize,
    velocity: f32,
    /// Notes started before it.
    order: u64,
}

const FREE: Voice = Voice {
    state: State::Free,
    position: 0,
    velocity: 0.0,
    order: 0,
};

struct Sampler {
    /// Half of them for voices fading out.
    voices: [Voice; 2 * VOICES],
    /// Samples a voice takes to give way.
    give_way: u32,
    notes: u64,
}

pub(crate) fn create(sample_rate: SampleRate) -> Box<dyn Plugin> {
    Box::new(Sampler::new(sample_rate))
}

impl Plugin for Sampler {
    fn process(&mut self, context: ProcessContext<'_>) {
        let ProcessContext {
            output: [left, right],
            events,
            samples,
            ..
        } = context;
        for step in steps(events, left.len()) {
            match step {
                Step::Event(Event::NoteOn { velocity, .. }) => self.start(samples, velocity),
                Step::Event(_) => {}
                Step::Frames(frames) => {
                    self.render(samples, &mut left[frames.clone()], &mut right[frames]);
                }
            }
        }
    }
}

impl Sampler {
    fn new(sample_rate: SampleRate) -> Self {
        Self {
            voices: [FREE; 2 * VOICES],
            give_way: ramp_samples(GIVE_WAY_SECONDS, sample_rate),
            notes: 0,
        }
    }

    fn start(&mut self, samples: &mut dyn SampleReader, velocity: f32) {
        // A silent note takes no voice: it would only push one that is heard out.
        if velocity == 0.0 {
            return;
        }
        // Without its sound the note is lost: starting later would be out of time, and joining midway would click.
        if samples.frames(SAMPLE, 0..0).is_none() {
            return;
        }
        let playing = |voice: &&mut Voice| voice.state == State::Playing;
        if self.voices.iter_mut().filter(playing).count() == VOICES {
            let oldest = self
                .voices
                .iter_mut()
                .filter(playing)
                .min_by_key(|voice| voice.order);
            if let Some(oldest) = oldest {
                oldest.state = State::Fading(self.give_way);
            }
        }
        // A free place, or else the fading voice nearest silence.
        let place = self
            .voices
            .iter_mut()
            .max_by_key(|voice| match voice.state {
                State::Free => (2, 0),
                State::Fading(left) => (1, u32::MAX - left),
                State::Playing => (0, 0),
            });
        if let Some(place) = place {
            *place = Voice {
                state: State::Playing,
                position: 0,
                velocity,
                order: self.notes,
            };
            self.notes += 1;
        }
    }

    fn render(&mut self, samples: &mut dyn SampleReader, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let wanted = left.len();
        let give_way = self.give_way as f32;
        for voice in &mut self.voices {
            if voice.state == State::Free {
                continue;
            }
            let start = voice.position;
            let Some(frames) = samples.frames(SAMPLE, start..start + wanted) else {
                voice.state = State::Free;
                continue;
            };
            let channels = frames.channels();
            // A mono sound on both sides.
            let (first, last) = (channels[0], channels[channels.len() - 1]);
            for (i, (l, r)) in left
                .iter_mut()
                .zip(right.iter_mut())
                .enumerate()
                .take(frames.len())
            {
                let gain = match voice.state {
                    State::Fading(0) => break,
                    // A step down on the first sample, silent on the last, as the engine's fades.
                    State::Fading(remaining) => {
                        voice.state = State::Fading(remaining - 1);
                        voice.velocity * (remaining - 1) as f32 / give_way
                    }
                    _ => voice.velocity,
                };
                *l += first[i] * gain;
                *r += last[i] * gain;
            }
            voice.position += frames.len();
            if frames.len() < wanted || voice.state == State::Fading(0) {
                voice.state = State::Free;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BLOCK_FRAMES;
    use crate::NoteId;
    use crate::testing::{
        NoSound, SAMPLE_RATE, Sound, largest_step, render_with, seconds, silence,
    };

    fn note(time: u32, velocity: f32) -> Event {
        Event::NoteOn {
            time,
            key: 60,
            velocity,
            note: NoteId::new(time),
        }
    }

    /// One at full velocity on each of the first `count` frames.
    fn a_note_a_frame(count: usize) -> Vec<Event> {
        (0..u32::try_from(count).unwrap())
            .map(|time| note(time, 1.0))
            .collect()
    }

    fn ramp(len: usize, from: f32, step: f32) -> Vec<f32> {
        (0..len).map(|i| from + i as f32 * step).collect()
    }

    #[test]
    fn plays_its_sound_frame_for_frame_at_its_velocity() {
        let (left, right) = (ramp(300, 0.001, 0.001), ramp(300, -0.001, -0.001));
        let mut sound = Sound::new(&DESCRIPTION, vec![left.clone(), right.clone()]);
        let events = [note(0, 0.5)];
        let [heard_left, heard_right] = render_with(
            create(SAMPLE_RATE).as_mut(),
            &events,
            &silence(400),
            &mut sound,
        );
        for ((heard, sent), side) in [(heard_left, left), (heard_right, right)]
            .into_iter()
            .zip(["left", "right"])
        {
            let expected: Vec<_> = sent.iter().map(|number| number * 0.5).collect();
            assert_eq!(heard[..300], expected, "{side}");
            assert_eq!(heard[300..], [0.0; 100], "{side}: silent after its end");
        }
    }

    #[test]
    fn a_mono_sound_plays_on_both_sides() {
        let mut sound = Sound::new(&DESCRIPTION, vec![ramp(200, 0.01, 0.001)]);
        let [left, right] = render_with(
            create(SAMPLE_RATE).as_mut(),
            &[note(0, 1.0)],
            &silence(256),
            &mut sound,
        );
        assert_eq!(left, right);
        assert_eq!(left[..200], sound.channels[0]);
    }

    #[test]
    fn a_note_starts_at_its_frame() {
        let mut sound = Sound::new(&DESCRIPTION, vec![ramp(500, 0.01, 0.001)]);
        let [left, _] = render_with(
            create(SAMPLE_RATE).as_mut(),
            &[note(37, 1.0)],
            &silence(512),
            &mut sound,
        );
        assert_eq!(left[..37], [0.0; 37]);
        assert_eq!(left[37..], sound.channels[0][..512 - 37]);
    }

    #[test]
    fn notes_overlap() {
        let sound = ramp(300, 0.01, 0.001);
        let notes = [note(0, 1.0), note(50, 0.5)];
        let [left, _] = render_with(
            create(SAMPLE_RATE).as_mut(),
            &notes,
            &silence(400),
            &mut Sound::new(&DESCRIPTION, vec![sound.clone()]),
        );
        for (i, heard) in left.iter().enumerate() {
            let first = sound.get(i).copied().unwrap_or(0.0);
            let second = i
                .checked_sub(50)
                .and_then(|i| sound.get(i))
                .map_or(0.0, |n| n * 0.5);
            assert!(
                (heard - (first + second)).abs() < 1e-6,
                "frame {i}: {heard}"
            );
        }
    }

    /// A long constant sound, so a voice's level shows as a step in the sum.
    fn level() -> Sound<Vec<f32>> {
        Sound::new(&DESCRIPTION, vec![vec![0.01; seconds(1.0)]])
    }

    #[test]
    fn one_note_more_than_the_voices_fades_the_oldest_out_without_a_click() {
        let mut plugin = create(SAMPLE_RATE);
        let mut sound = level();
        let notes = a_note_a_frame(VOICES);
        render_with(plugin.as_mut(), &notes, &silence(BLOCK_FRAMES), &mut sound);
        let heard = render_with(plugin.as_mut(), &[note(0, 1.0)], &silence(2048), &mut sound);
        let left = &heard[0];
        // The new note comes in at once, as its sound starts; the oldest falls over 20 ms.
        let give_way = ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize;
        let (all, one) = (0.01 * VOICES as f32, 0.01);
        assert!(
            (left[0] - (all + one - one / give_way as f32)).abs() < 1e-6,
            "{}",
            left[0]
        );
        assert!(largest_step(&left[..give_way + 10]) <= one / give_way as f32 + 1e-6);
        assert!(
            (left[give_way + 10] - all).abs() < 1e-6,
            "{}",
            left[give_way + 10]
        );
    }

    #[test]
    fn the_note_that_gives_way_is_the_oldest() {
        let mut plugin = create(SAMPLE_RATE);
        // Rising, so each voice sounds where it has got to in it.
        let at = |position: usize| 0.001 + 0.001 * position as f32;
        let mut sound = Sound::new(&DESCRIPTION, vec![ramp(seconds(1.0), at(0), 0.001)]);
        let notes = a_note_a_frame(VOICES);
        render_with(plugin.as_mut(), &notes, &silence(BLOCK_FRAMES), &mut sound);
        let past = ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize + 1;
        let [left, _] = render_with(
            plugin.as_mut(),
            &[note(0, 1.0)],
            &silence(past + 1),
            &mut sound,
        );
        // Past its fade: the others where they have got to, the first pressed gone, and the new note.
        let others: f32 = (1..VOICES)
            .map(|pressed| at(BLOCK_FRAMES - pressed + past))
            .sum();
        let expected = others + at(past);
        assert!(
            (left[past] - expected).abs() < 1e-4,
            "{} {expected}",
            left[past]
        );
    }

    #[test]
    fn a_silent_note_pushes_no_voice_out() {
        let mut plugin = create(SAMPLE_RATE);
        let mut sound = level();
        let notes = a_note_a_frame(VOICES);
        render_with(plugin.as_mut(), &notes, &silence(BLOCK_FRAMES), &mut sound);
        let [left, _] = render_with(plugin.as_mut(), &[note(0, 0.0)], &silence(2048), &mut sound);
        let all = 0.01 * VOICES as f32;
        assert!(left.iter().all(|&heard| (heard - all).abs() < 1e-6));
    }

    #[test]
    fn a_burst_of_notes_past_every_place_cuts_the_voice_nearest_silence() {
        let mut plugin = create(SAMPLE_RATE);
        let mut sound = level();
        let notes = a_note_a_frame(3 * VOICES);
        let [left, _] = render_with(plugin.as_mut(), &notes, &silence(BLOCK_FRAMES), &mut sound);
        // Every note came in, and never more than the voices sound at full.
        assert!(
            left.iter()
                .all(|&heard| heard.is_finite() && heard <= 0.01 * 2.0 * VOICES as f32)
        );
        let heard = render_with(plugin.as_mut(), &[], &silence(2048), &mut sound);
        assert!(
            (heard[0][2047] - 0.01 * VOICES as f32).abs() < 1e-6,
            "the newest voices play on"
        );
    }

    #[test]
    fn a_voice_is_free_once_its_sound_ends() {
        let mut sampler = Sampler::new(SAMPLE_RATE);
        let notes = a_note_a_frame(VOICES);
        let mut short = Sound::new(&DESCRIPTION, vec![vec![0.5; 200]]);
        render_with(&mut sampler, &notes, &silence(512), &mut short);
        assert!(
            sampler
                .voices
                .iter()
                .all(|voice| voice.state == State::Free)
        );
    }

    #[test]
    fn a_note_played_before_its_sound_comes_is_lost() {
        let mut plugin = create(SAMPLE_RATE);
        let before = render_with(
            plugin.as_mut(),
            &[note(0, 1.0)],
            &silence(256),
            &mut NoSound,
        );
        assert!(before.iter().flatten().all(|&heard| heard == 0.0));
        let mut sound = Sound::new(&DESCRIPTION, vec![ramp(1000, 0.01, 0.001)]);
        let came = render_with(plugin.as_mut(), &[], &silence(256), &mut sound);
        assert!(
            came.iter().flatten().all(|&heard| heard == 0.0),
            "not started late"
        );
        let [left, _] = render_with(plugin.as_mut(), &[note(0, 1.0)], &silence(256), &mut sound);
        assert_eq!(
            left[..256],
            sound.channels[0][..256],
            "the next note plays from the start"
        );
    }
}
