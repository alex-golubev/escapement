use std::collections::HashSet;
use std::f32::consts::FRAC_1_SQRT_2;

use super::*;
use crate::envelope::GIVE_WAY_SECONDS;
use crate::smoothing::ramp_samples;
use crate::testing::{
    SAMPLE_RATE, first_block, largest_step, peak, rate, render, rms, seconds, silence,
};

const A4: u8 = 69;

/// The default release's length.
fn release() -> usize {
    let release = ENVELOPE.release.entry(DESCRIPTION.params).unwrap();
    ramp_samples(release.default, SAMPLE_RATE) as usize
}

/// Named by its key.
fn on(time: u32, key: u8) -> Event {
    named(time, key, u32::from(key), 1.0)
}

fn named(time: u32, key: u8, note: u32, velocity: f32) -> Event {
    Event::NoteOn {
        time,
        key,
        velocity,
        note: NoteId::new(note),
    }
}

fn off(time: u32, note: u32) -> Event {
    Event::NoteOff {
        time,
        note: NoteId::new(note),
    }
}

const A: u32 = A4 as u32;

/// [`VOICES`] as keys count.
fn voices() -> u8 {
    u8::try_from(VOICES).unwrap()
}

const SHAPE: ParamNumber = OSCILLATOR_PARAMS[0].shape;

fn choose(shape: Shape) -> Event {
    Event::param_at_start(SHAPE, shape.value())
}

/// A new synth's sound, `parts` one after another: so many samples each, its events in its first block; it starts
/// with its default shape.
fn play_parts(parts: &[(&[Event], usize)]) -> Vec<f32> {
    play_shaped(Shape::of(PARAMS[0].default).unwrap(), parts)
}

fn play_shaped(shape: Shape, parts: &[(&[Event], usize)]) -> Vec<f32> {
    play_set(&[(SHAPE, shape.value())], parts)
}

/// As `play_parts`, starting with `values` over the defaults.
fn play_set(values: &[(ParamNumber, f32)], parts: &[(&[Event], usize)]) -> Vec<f32> {
    let mut synth = create(SAMPLE_RATE);
    let mut sound = Vec::new();
    for (i, &(notes, samples)) in parts.iter().enumerate() {
        let mut events = match i {
            0 => first_block(&DESCRIPTION, values),
            _ => Vec::new(),
        };
        events.extend_from_slice(notes);
        let [left, right] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(samples));
        assert_eq!(left, right);
        sound.extend(left);
    }
    sound
}

fn play(notes: &[Event], samples: usize) -> Vec<f32> {
    play_parts(&[(notes, samples)])
}

/// The largest difference between the two over `range`.
fn difference(a: &[f32], b: &[f32], range: std::ops::Range<usize>) -> f32 {
    a[range.clone()]
        .iter()
        .zip(&b[range])
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

fn rising_crossings(samples: &[f32]) -> usize {
    samples
        .windows(2)
        .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
        .count()
}

#[test]
fn is_silent_until_a_note() {
    assert_eq!(peak(&play(&[], 1000)), 0.0);
}

#[test]
fn plays_the_key_s_pitch_at_its_velocity() {
    let second = play(&[on(0, A4)], seconds(1.0));
    // The sawtooth rises through zero once a period.
    assert!((439..=441).contains(&rising_crossings(&second)));
    let level = peak(&second);
    assert!((level - VOICE_GAIN).abs() < 0.02, "peak {level}");
    let quiet = named(0, A4, 1, 0.5);
    let half = peak(&play(&[quiet], seconds(0.1)));
    assert!((half - VOICE_GAIN / 2.0).abs() < 0.01, "peak {half}");
    assert_eq!(frequency(A4 + 12), 880.0);
}

#[test]
fn rises_without_a_click() {
    // Short of the sawtooth's first jump, at sample 109.
    let start = play(&[on(0, A4)], 100);
    // A step of the attack up, a step of the wave on.
    assert!(start[0].abs() < 0.01 * VOICE_GAIN, "{}", start[0]);
    // Without the attack the first samples would jump by the sawtooth's full depth.
    assert!(largest_step(&start) < 0.05 * VOICE_GAIN);
}

#[test]
fn holds_until_let_go_of_then_falls_silent_over_its_release() {
    let release = release();
    let held = 2000;
    let sound = play_parts(&[(&[on(0, A4)], held), (&[off(0, A)], 3 * release)]);
    assert!(peak(&sound[held - 200..held]) > 0.9 * VOICE_GAIN);
    // Half way through the release, 40 dB down, as it falls evenly in decibels to 80 down; over a period up to it.
    let middle = held + release / 2;
    let half_way = 20.0 * (peak(&sound[middle - 110..middle]) / VOICE_GAIN).log10();
    assert!((-41.0..-37.5).contains(&half_way), "{half_way} dB");
    assert!(peak(&sound[held + release - 100..held + release - 1]) > 0.0);
    assert_eq!(peak(&sound[held + release - 1..]), 0.0);
}

#[test]
fn letting_go_of_a_note_lets_go_of_it_and_no_other_even_of_its_key() {
    let release = release();
    let tail = 2 * release;
    let alone = play(&[on(0, A4), on(0, A4 + 7)], 3 * release);
    let both = play(&[on(0, A4), on(0, A4 + 7), off(0, A)], 3 * release);
    // The fifth goes on as it was.
    let fifth = play(&[on(0, A4 + 7)], 3 * release);
    assert!(peak(&alone[tail..]) > 1.5 * VOICE_GAIN);
    assert!((peak(&both[tail..]) - peak(&fifth[tail..])).abs() < 1e-6);
    // Of a loud and a quiet note of one key, the quiet one let go of leaves the loud one.
    let loud = named(0, A4, 1, 1.0);
    let quiet = named(0, A4, 2, 0.5);
    let left = play(&[loud, quiet, off(0, 2)], 3 * release);
    assert!((peak(&left[tail..]) - VOICE_GAIN).abs() < 0.02);
    let none = play(&[loud, quiet, off(0, 2), off(0, 1)], 3 * release);
    assert_eq!(peak(&none[tail..]), 0.0);
}

#[test]
fn a_note_let_go_of_as_it_is_pressed_is_not_left_held() {
    assert_eq!(peak(&play(&[on(0, A4), off(0, A)], 1000)), 0.0);
}

#[test]
fn a_silent_note_or_a_key_not_held_changes_nothing() {
    let silent = named(0, A4, 1, 0.0);
    assert_eq!(peak(&play(&[silent], 1000)), 0.0);
    let held = play(&[on(0, A4)], 1000);
    assert_eq!(play(&[on(0, A4), off(0, A + 1)], 1000), held);
}

#[test]
fn a_note_past_the_voices_makes_the_oldest_give_way() {
    let chord: Vec<_> = (0..voices()).map(|i| on(0, 40 + i)).collect();
    let extra = [on(0, 90)];
    let over = play_parts(&[(&chord, 1000), (&extra, 4000)]);
    // What is left once the oldest is gone: fifteen of the sixteen and the extra note.
    let rest = play_parts(&[(&chord[1..], 1000), (&extra, 4000)]);
    let give_way = ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize;
    // Up to half way, the oldest is still fading rather than gone at once: its low sawtooth needs that long to
    // show its depth. Past its fade, it is gone.
    assert!(difference(&over, &rest, 1000..1000 + give_way / 2) > 0.25 * VOICE_GAIN);
    assert!(difference(&over, &rest, 1000 + give_way + 1..over.len()) < 1e-5);
}

/// The sound of `parts`, then of the same with `extra` pressed at the start of the last: past the fade of the voice
/// that gave way to it, how much it changed the sound.
fn traded_for(
    values: &[(ParamNumber, f32)],
    parts: &[(&[Event], usize)],
    extra: &[Event],
) -> Vec<f32> {
    let without = play_set(values, parts);
    let (last, before) = parts.split_last().unwrap();
    let pressed: Vec<_> = last.0.iter().chain(extra).copied().collect();
    let with: Vec<_> = before
        .iter()
        .copied()
        .chain([(&pressed[..], last.1)])
        .collect();
    let over = play_set(values, &with);
    let past = without.len() - last.1 + ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize + 1;
    over.iter()
        .zip(&without)
        .skip(past)
        .map(|(a, b)| a - b)
        .collect()
}

/// The sound of a note alone, as `traded_for` takes it, past the same fade: so many samples silent, then the note's
/// own `parts`.
fn alone_past_the_fade(
    values: &[(ParamNumber, f32)],
    parts: &[(&[Event], usize)],
    extra_at: usize,
) -> Vec<f32> {
    let past = extra_at + ramp_samples(GIVE_WAY_SECONDS, SAMPLE_RATE) as usize + 1;
    play_set(values, parts).split_off(past)
}

fn minus(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter().zip(b).map(|(a, b)| a - b).collect()
}

const EXTRA: Event = Event::NoteOn {
    time: 0,
    key: 100,
    velocity: 1.0,
    note: NoteId::new(100),
};

#[test]
fn a_tail_gives_way_before_a_note_held_however_old() {
    // The oldest held, then one let go of with a long release, then fourteen more held: sixteen sounding.
    let long = [(ENVELOPE.release, 10.0)];
    let first = [on(0, 40), on(0, 90)];
    let more: Vec<_> = [off(0, 90)]
        .into_iter()
        .chain((41..55).map(|key| on(0, key)))
        .collect();
    let traded = traded_for(
        &long,
        &[(&first, 1000), (&more, 1000), (&[], 4000)],
        &[EXTRA],
    );
    // The extra note heard in place of the tail.
    let tail = alone_past_the_fade(&long, &[(&[on(0, 90)], 1000), (&[off(0, 90)], 5000)], 2000);
    let extra = alone_past_the_fade(&long, &[(&[], 2000), (&[EXTRA], 4000)], 2000);
    let differs = difference(&traded, &minus(&extra, &tail), 0..traded.len());
    assert!(differs < 1e-5, "{differs}");
}

#[test]
fn of_tails_the_quietest_gives_way_whichever_was_pressed_first() {
    let values = [(ENVELOPE.release, 1.0)];
    // Pressed first and let go of last, the loud one; the other well on its way down.
    let (loud, quiet) = (on(0, 90), on(0, 95));
    let first = [on(0, 40), loud, quiet];
    let more: Vec<_> = [off(0, 90)]
        .into_iter()
        .chain((41..54).map(|key| on(0, key)))
        .collect();
    let parts: [(&[Event], usize); 4] = [
        (&first, 1000),
        (&[off(0, 95)], 2000),
        (&more, 1000),
        (&[], 4000),
    ];
    let traded = traded_for(&values, &parts, &[EXTRA]);
    let quiet_alone = [(&[quiet][..], 1000), (&[off(0, 95)], 7000)];
    let quiet = alone_past_the_fade(&values, &quiet_alone, 4000);
    let extra = alone_past_the_fade(&values, &[(&[], 4000), (&[EXTRA], 4000)], 4000);
    let differs = difference(&traded, &minus(&extra, &quiet), 0..traded.len());
    assert!(differs < 1e-5, "{differs}");
}

#[test]
fn with_every_place_taken_a_note_takes_that_of_the_voice_giving_way_nearest_silence() {
    let mut synth = Synth::new(SAMPLE_RATE);
    // Sixteen held, then sixteen more a few samples apart, all in one block: those giving way to them stand at levels
    // of their own.
    let apart = u32::try_from(BLOCK_FRAMES / (2 * VOICES)).unwrap();
    let notes: Vec<_> = (0..2 * voices())
        .map(|i| on(apart * u32::from(i), 40 + i))
        .collect();
    render(&DESCRIPTION, &mut synth, &notes, &silence(BLOCK_FRAMES));
    let giving_way: Vec<_> = (synth.voices.iter().enumerate())
        .filter(|(_, voice)| voice.contour.is_giving_way())
        .map(|(place, voice)| (voice.contour.level(), place))
        .collect();
    assert_eq!(giving_way.len(), VOICES);
    let (_, quietest) = (giving_way.into_iter())
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .unwrap();
    render(&DESCRIPTION, &mut synth, &[EXTRA], &silence(1));
    assert_eq!(synth.voices[quietest].note, NoteId::new(100));
}

#[test]
fn a_note_held_fallen_silent_gives_way_before_a_tail() {
    let values = [
        (ENVELOPE.sustain, 0.0),
        (ENVELOPE.decay, 0.05),
        (ENVELOPE.release, 10.0),
    ];
    // Sixteen held; one let go of half way down its decay, still heard as the others fall silent.
    let chord: Vec<_> = (40..56).map(|key| on(0, key)).collect();
    let parts: [(&[Event], usize); 3] = [(&chord, 1000), (&[off(0, 40)], 3000), (&[], 4000)];
    let traded = traded_for(&values, &parts, &[EXTRA]);
    // The extra note heard, and nothing gone.
    let extra = alone_past_the_fade(&values, &[(&[], 4000), (&[EXTRA], 4000)], 4000);
    let differs = difference(&traded, &extra, 0..traded.len());
    assert!(differs < 1e-5, "{differs}");
}

#[test]
fn a_held_note_falls_over_the_decay_to_the_sustain_level() {
    let values = [(ENVELOPE.sustain, 0.5), (ENVELOPE.decay, 0.1)];
    let sound = play_set(&values, &[(&[on(0, A4)], seconds(0.5))]);
    assert!(peak(&sound[150..300]) > 0.95 * VOICE_GAIN);
    let held = peak(&sound[seconds(0.25)..]);
    assert!(
        (held - 0.5 * VOICE_GAIN).abs() < 0.01 * VOICE_GAIN,
        "{held}"
    );
}

#[test]
fn each_note_goes_through_the_envelope_from_its_own_press() {
    let values = [
        (ENVELOPE.attack, 0.05),
        (ENVELOPE.sustain, 0.5),
        (ENVELOPE.decay, 0.1),
    ];
    let later = seconds(0.2);
    let both = play_set(&values, &[(&[on(0, A4)], later), (&[on(0, A4 + 7)], later)]);
    let first = play_set(&values, &[(&[on(0, A4)], 2 * later)]);
    let second = play_set(&values, &[(&[], later), (&[on(0, A4 + 7)], later)]);
    let sum: Vec<f32> = first.iter().zip(&second).map(|(a, b)| a + b).collect();
    let differs = difference(&both, &sum, 0..both.len());
    assert!(differs < 1e-6, "{differs}");
}

#[test]
fn a_note_that_gave_way_is_let_go_of_without_touching_the_one_it_gave_way_to() {
    let chord: Vec<_> = (0..voices()).map(|i| on(0, 40 + i)).collect();
    // Key 40 again, as another note: the first 40 gives way to it.
    let again = [named(0, 40, 99, 1.0)];
    let held = play_parts(&[(&chord, 1000), (&again, 1000), (&[], 2000)]);
    let let_go = play_parts(&[(&chord, 1000), (&again, 1000), (&[off(0, 40)], 2000)]);
    assert_eq!(held, let_go);
}

#[test]
fn a_pitched_wave_fades_out_below_half_the_sample_rate_and_is_silent_from_it() {
    let sample_rate = rate(8000);
    let nyquist = sample_rate.hz() / 2.0;
    let level = |shape: Shape, key| {
        let mut synth = create(sample_rate);
        let mut events = first_block(&DESCRIPTION, &[(SHAPE, shape.value())]);
        events.push(on(0, key));
        let [left, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(4000));
        peak(&left)
    };
    // No key runs past full level; from 4 kHz up, only noise sounds, which has no pitch to alias by.
    for shape in Shape::ALL {
        for key in 0..=127 {
            let level = level(shape, key);
            assert!(level <= 1.1 * VOICE_GAIN, "{shape:?} {key}: {level}");
            let silent = shape != Shape::Noise && frequency(key) >= nyquist;
            assert_eq!(level == 0.0, silent, "{shape:?} {key}: {level}");
        }
    }
    // Over the half octave below it, each key quieter than the one before.
    let fading: Vec<_> = (0..=127u8)
        .filter(|&key| (nyquist * FRAC_1_SQRT_2..nyquist).contains(&frequency(key)))
        .map(|key| level(Shape::Sine, key))
        .collect();
    assert!(fading.len() >= 5, "{fading:?}");
    assert!(fading[0] < VOICE_GAIN, "{fading:?}");
    assert!(
        fading.windows(2).all(|pair| pair[1] < pair[0]),
        "{fading:?}"
    );
}

#[test]
fn shapes_are_kept_by_their_place_and_a_new_synth_plays_a_saw() {
    for (place, shape) in Shape::ALL.into_iter().enumerate() {
        assert_eq!(shape as usize, place);
    }
    assert_eq!(Shape::of(PARAMS[0].default).unwrap(), Shape::Saw);
}

#[test]
fn every_shape_but_noise_plays_the_key_s_pitch_at_full_level() {
    for shape in [Shape::Sine, Shape::Triangle, Shape::Square, Shape::Saw] {
        let second = play_shaped(shape, &[(&[on(0, A4)], seconds(1.0))]);
        let crossings = rising_crossings(&second);
        assert!((439..=441).contains(&crossings), "{shape:?}: {crossings}");
        let level = peak(&second);
        assert!(
            (level - VOICE_GAIN).abs() < 0.03 * VOICE_GAIN,
            "{shape:?}: peak {level}"
        );
    }
}

#[test]
fn a_sine_starts_rising() {
    let sound = play_shaped(Shape::Sine, &[(&[on(0, A4)], 16)]);
    assert!(sound[0] > 0.0, "{sound:?}");
    assert!(sound.windows(2).all(|pair| pair[1] > pair[0]), "{sound:?}");
}

#[test]
fn a_square_falls_through_0_half_way_through_its_period() {
    assert_eq!(square(0.5, 0.01), 0.0);
}

#[test]
fn noise_has_no_pitch_and_each_note_its_own() {
    let one = play_shaped(Shape::Noise, &[(&[on(0, A4)], seconds(1.0))]);
    // White: it rises through zero about once in four samples, whatever the key.
    let crossings = rising_crossings(&one);
    assert!((11_000..13_000).contains(&crossings), "{crossings}");
    let level = peak(&one);
    assert!(
        level <= VOICE_GAIN && level > 0.95 * VOICE_GAIN,
        "peak {level}"
    );
    // Two notes of the same noise would be twice as loud; of their own, √2.
    let two = play_shaped(
        Shape::Noise,
        &[(&[on(0, A4), on(0, A4 + 12)], seconds(1.0))],
    );
    let louder = rms(&two) / rms(&one);
    assert!((1.3..1.55).contains(&louder), "{louder}");
}

#[test]
fn every_oscillator_of_every_note_starts_a_noise_of_its_own() {
    // The page's notes, and the engine's own from 2³¹.
    let notes = (0..500).chain(1 << 31..(1 << 31) + 500);
    let starts: HashSet<_> = notes
        .flat_map(|note| {
            (0..OSCILLATORS).map(move |oscillator| Noise::of(NoteId::new(note), oscillator).0)
        })
        .collect();
    assert_eq!(starts.len(), 1000 * OSCILLATORS);
    // Nor any the start a free voice keeps.
    assert!(!starts.contains(&FREE.noises[0].0));
}

#[test]
fn noise_is_xorshift32_whose_period_is_every_number_but_0() {
    let mut noise = Noise(1);
    let states: Vec<_> = (0..3)
        .map(|_| {
            noise.next();
            noise.0
        })
        .collect();
    assert_eq!(states, [270_369, 67_634_689, 2_647_435_461]);
}

#[test]
fn noise_has_no_offset() {
    let mut noise = Noise::of(NoteId::new(1), 0);
    let second: Vec<_> = (0..seconds(1.0)).map(|_| noise.next()).collect();
    let mean = second.iter().sum::<f32>() / second.len() as f32;
    assert!(mean.abs() < 0.02, "{mean}");
}

#[test]
fn two_synths_layered_on_the_same_steps_play_noises_of_their_own() {
    // The engine names each note of a pattern anew, whichever node plays it.
    let noise = |note| play_shaped(Shape::Noise, &[(&[named(0, A4, note, 1.0)], 4800)]);
    assert_eq!(noise(1), noise(1));
    let (one, other) = (noise(1), noise(2));
    let together: Vec<f32> = one.iter().zip(&other).map(|(a, b)| a + b).collect();
    // Twice as loud if they were one noise; √2 as two.
    let louder = rms(&together) / rms(&one);
    assert!((1.3..1.55).contains(&louder), "{louder}");
}

#[test]
fn a_shape_chosen_while_a_note_sounds_takes_over_over_its_smoothing() {
    let ramp = ramp_samples(PARAMS[0].smoothing_seconds, SAMPLE_RATE) as usize;
    let (before, after) = (10 * BLOCK_FRAMES, 3 * ramp);
    let note: &[Event] = &[on(0, A4)];
    let changed = play_shaped(
        Shape::Saw,
        &[(note, before), (&[choose(Shape::Square)], after)],
    );
    let saw = play_shaped(Shape::Saw, &[(note, before + after)]);
    let square = play_shaped(Shape::Square, &[(note, before + after)]);
    assert_eq!(changed[..before], saw[..before]);
    // Half way, half of each; then the square alone, the note going on.
    let middle = before + ramp / 2;
    let half: Vec<f32> = saw
        .iter()
        .zip(&square)
        .map(|(a, b)| (a + b) / 2.0)
        .collect();
    assert!(difference(&changed, &half, middle - 2..middle + 2) < 1e-3);
    assert!(difference(&changed, &square, before + ramp..before + after) < 1e-6);
}

#[test]
fn a_shape_chosen_as_another_takes_over_glides_on_from_where_they_stand() {
    let ramp = ramp_samples(PARAMS[0].smoothing_seconds, SAMPLE_RATE) as usize;
    let note: &[Event] = &[on(0, A4)];
    let length = 10 * BLOCK_FRAMES + 4 * ramp;
    let back = play_shaped(
        Shape::Sine,
        &[
            (note, 10 * BLOCK_FRAMES),
            (&[choose(Shape::Triangle)], ramp / 2),
            (&[choose(Shape::Sine)], 3 * ramp + ramp / 2),
        ],
    );
    let own = |shape| largest_step(&play_shaped(shape, &[(note, length)]));
    // Starting the way back from the sine alone, or from the triangle, would jump by a share of their difference.
    let limit = own(Shape::Sine).max(own(Shape::Triangle)) + 1e-6;
    let step = largest_step(&back);
    assert!(step <= limit, "step {step} > {limit}");
}

/// How loud the sound is at `frequency`, windowed so louder neighbours don't leak in.
fn level_at(sound: &[f32], frequency: f64) -> f64 {
    use std::f64::consts::TAU;
    let length = sound.len() as f64;
    let turn = TAU * frequency / f64::from(SAMPLE_RATE.get());
    let (re, im) = sound
        .iter()
        .enumerate()
        .fold((0.0, 0.0), |(re, im), (i, &sample)| {
            let i = i as f64;
            let hann = 0.5 - 0.5 * (TAU * i / length).cos();
            let x = f64::from(sample) * hann;
            (re + x * (turn * i).cos(), im - x * (turn * i).sin())
        });
    re.hypot(im) / length
}

#[test]
fn a_high_note_aliases_far_less_than_the_bare_wave() {
    type Bare = fn(f32) -> f32;
    let key = 100;
    let increment = frequency(key) / SAMPLE_RATE.hz();
    let note = f64::from(frequency(key));
    let rate = f64::from(SAMPLE_RATE.get());
    // Each with its jumps and corners as they are, and whether it has only odd harmonics.
    let shapes: [(Shape, Bare, bool); 3] = [
        (Shape::Saw, |phase| 2.0 * phase - 1.0, false),
        (
            Shape::Square,
            |phase| if phase < 0.5 { 1.0 } else { -1.0 },
            true,
        ),
        (
            Shape::Triangle,
            |phase| 1.0 - 4.0 * ((phase + 0.25).fract() - 0.5).abs(),
            true,
        ),
    ];
    for (shape, bare, odd_only) in shapes {
        let second = seconds(1.0);
        let played = play_shaped(shape, &[(&[on(0, key)], second)]);
        let bare: Vec<f32> = (0..second)
            .scan(0.0f32, |phase, _| {
                let sample = VOICE_GAIN * bare(*phase);
                *phase = (*phase + increment).fract();
                Some(sample)
            })
            .collect();
        // Harmonics between half the sample rate and the rate fold back under the half, clear of the note's own.
        #[expect(
            clippy::maybe_infinite_iter,
            reason = "the harmonics rise past the rate"
        )]
        let folded: Vec<f64> = (1..)
            .map(|harmonic| f64::from(harmonic) * note)
            .take_while(|&above| above < rate)
            .enumerate()
            .filter(|&(i, above)| above > rate / 2.0 && (!odd_only || i % 2 == 0))
            .map(|(_, above)| rate - above)
            .collect();
        let aliased = |sound: &[f32]| folded.iter().map(|&at| level_at(sound, at)).sum::<f64>();
        let (played, bare) = (aliased(&played), aliased(&bare));
        assert!(played < bare / 4.0, "{shape:?}: {played} against {bare}");
    }
}

const OSC1: OscillatorParams = OSCILLATOR_PARAMS[0];
const OSC2: OscillatorParams = OSCILLATOR_PARAMS[1];
const OSC3: OscillatorParams = OSCILLATOR_PARAMS[2];

const SINE: f32 = Shape::Sine.value();

/// A second of A4.
fn a_second(values: &[(ParamNumber, f32)]) -> Vec<f32> {
    play_set(values, &[(&[on(0, A4)], seconds(1.0))])
}

/// The values that leave the oscillator heard alone, a sine: its mix whole, and those after it at none, as new.
fn alone(osc: OscillatorParams) -> Vec<(ParamNumber, f32)> {
    let mut values = vec![(osc.shape, SINE)];
    values.extend(osc.mix.map(|mix| (mix, 1.0)));
    values
}

/// Where the sound rises through 0, between samples.
fn rising_at(samples: &[f32]) -> Vec<f64> {
    let rising = samples.windows(2).enumerate();
    rising
        .filter(|(_, pair)| pair[0] < 0.0 && pair[1] >= 0.0)
        .map(|(i, pair)| i as f64 + f64::from(pair[0] / (pair[0] - pair[1])))
        .collect()
}

#[test]
fn every_parameter_is_one_oscillator_s_or_the_envelope_s_and_in_its_group() {
    for (number, param) in ParamNumber::each(DESCRIPTION.params) {
        let oscillators = (OSCILLATOR_PARAMS.iter().zip(["Osc 1", "Osc 2", "Osc 3"]))
            .filter(|(osc, _)| {
                [Some(osc.shape), Some(osc.coarse), Some(osc.fine), osc.mix].contains(&Some(number))
            })
            .map(|(_, group)| group);
        let envelope = ENVELOPE.all().contains(&number).then_some(envelope::GROUP);
        let owners: Vec<_> = oscillators.chain(envelope).collect();
        assert_eq!(owners.len(), 1, "{:?}", param.id);
        assert_eq!(param.group, Some(owners[0]), "{:?}", param.id);
    }
}

#[test]
fn a_new_synth_plays_osc_1_alone_with_osc_2_an_octave_down_and_osc_3_two() {
    let coarse = OSCILLATOR_PARAMS.map(|osc| osc.coarse.entry(DESCRIPTION.params).unwrap().default);
    assert_eq!(coarse, [0.0, -12.0, -24.0]);
    // Their mixes at none, Osc 2's and Osc 3's own settings change nothing.
    let others = [OSC2, OSC3].map(|osc| [(osc.shape, SINE), (osc.coarse, 7.0), (osc.fine, 30.0)]);
    assert_eq!(a_second(others.as_flattened()), a_second(&[]));
}

#[test]
fn each_oscillator_plays_its_shape_at_the_key_s_pitch_moved_by_its_tuning() {
    for (place, osc) in OSCILLATOR_PARAMS.into_iter().enumerate() {
        for (coarse, fine) in [
            (0.0, 0.0),
            (12.0, 0.0),
            (-12.0, 0.0),
            (7.0, -50.0),
            (-1.0, 100.0),
        ] {
            let mut values = alone(osc);
            values.extend([(osc.coarse, coarse), (osc.fine, fine)]);
            let second = a_second(&values);
            let at = format!("osc {} at {coarse} st {fine} ct", place + 1);
            let pitch = 440.0 * ((coarse + fine / 100.0) / 12.0).exp2();
            let crossings = rising_crossings(&second) as f32;
            assert!(
                (crossings - pitch).abs() <= 1.5,
                "{at}: {crossings} for {pitch}"
            );
            let level = peak(&second);
            assert!(
                (level - VOICE_GAIN).abs() < 0.01 * VOICE_GAIN,
                "{at}: peak {level}"
            );
        }
    }
}

#[test]
fn a_mix_takes_its_share_from_the_oscillators_before_as_in_fl() {
    // Sines octaves apart, each heard at its own pitch: Osc 2 at a half and Osc 3 at a third share alike.
    let sines = OSCILLATOR_PARAMS.map(|osc| (osc.shape, SINE));
    let mixes = [(OSC2.mix.unwrap(), 0.5), (OSC3.mix.unwrap(), 1.0 / 3.0)];
    let mixed = a_second(&[sines.as_slice(), &mixes].concat());
    let alone = a_second(&sines);
    let level = |sound: &[f32], pitch| level_at(&sound[4800..], pitch);
    for pitch in [440.0, 220.0, 110.0] {
        let share = level(&mixed, pitch) / level(&alone, 440.0);
        assert!((share - 1.0 / 3.0).abs() < 0.01, "{pitch} Hz: {share}");
    }
}

#[test]
fn three_oscillators_mixed_are_no_louder_than_one() {
    // The same wave in each, so the mix comes back to it.
    let mut values: Vec<_> = OSCILLATOR_PARAMS
        .iter()
        .map(|osc| (osc.coarse, 0.0))
        .collect();
    values.extend([(OSC2.mix.unwrap(), 0.5), (OSC3.mix.unwrap(), 0.3)]);
    let (mixed, plain) = (a_second(&values), a_second(&[]));
    let differs = difference(&mixed, &plain, 0..plain.len());
    assert!(differs < 1e-6, "{differs}");
}

#[test]
fn an_oscillator_past_half_the_sample_rate_is_silent_and_the_others_sound() {
    let sample_rate = rate(8000);
    // 1047 Hz, and two octaves up past 4 kHz.
    let key = 84;
    let sound = |values: &[(ParamNumber, f32)]| {
        let mut synth = create(sample_rate);
        let mut events = first_block(&DESCRIPTION, values);
        events.push(on(0, key));
        let [left, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(4000));
        left
    };
    let plain = sound(&[]);
    let half_past = sound(&[(OSC2.coarse, 24.0), (OSC2.mix.unwrap(), 0.5)]);
    assert!(peak(&plain) > 0.5 * VOICE_GAIN);
    // Osc 1 at half its level, Osc 2 nothing.
    let halved: Vec<_> = plain.iter().map(|sample| 0.5 * sample).collect();
    let differs = difference(&half_past, &halved, 0..plain.len());
    assert!(differs < 1e-6, "{differs}");
}

#[test]
fn each_oscillator_s_noise_is_its_own() {
    let noise = Shape::Noise.value();
    let one = a_second(&[(OSC1.shape, noise)]);
    let two = a_second(&[
        (OSC1.shape, noise),
        (OSC2.shape, noise),
        (OSC2.mix.unwrap(), 0.5),
    ]);
    // Halves of two noises add up to less than a whole one: by a square root of two.
    let ratio = rms(&two) / rms(&one);
    assert!((ratio - FRAC_1_SQRT_2).abs() < 0.02, "{ratio}");
}

#[test]
fn coarse_moves_a_sounding_note_at_once_and_fine_glides_over_its_smoothing() {
    let turn = seconds(0.1);
    let period = f64::from(SAMPLE_RATE.get()) / 440.0;
    // The first period wholly after the turn, and the last one.
    let turned = |param, value| {
        let to = [Event::param_at_start(param, value)];
        let sound = play_set(&[(SHAPE, SINE)], &[(&[on(0, A4)], turn), (&to, turn)]);
        let at = rising_at(&sound);
        let first = at.iter().position(|&at| at > turn as f64).unwrap();
        (
            at[first + 1] - at[first],
            at[at.len() - 1] - at[at.len() - 2],
        )
    };
    let (first, last) = turned(OSC1.coarse, 12.0);
    assert!(
        (first - period / 2.0).abs() < 0.1,
        "an octave up at once: {first}"
    );
    assert!((last - period / 2.0).abs() < 0.1, "{last}");
    let up = period / 2f64.powf(1.0 / 12.0);
    let (first, last) = turned(OSC1.fine, 100.0);
    assert!(
        first > f64::midpoint(period, up),
        "a semitone up from where it stood: {first}"
    );
    assert!((last - up).abs() < 0.1, "{last} for {up}");
}

#[test]
fn a_coarse_turn_on_a_sounding_note_does_not_click() {
    let turn = 90 * BLOCK_FRAMES;
    for shape in [Shape::Sine, Shape::Triangle, Shape::Square, Shape::Saw] {
        for (from, to) in [(-24.0, 24.0), (24.0, -24.0)] {
            let at = |coarse| [(SHAPE, shape.value()), (OSC1.coarse, coarse)];
            let steady = |coarse| largest_step(&a_second(&at(coarse)));
            // No step past the wave's own at either pitch.
            let limit = steady(from).max(steady(to)) + 1e-6;
            let to = [Event::param_at_start(OSC1.coarse, to)];
            let turned = play_set(&at(from), &[(&[on(0, A4)], turn), (&to, turn)]);
            let step = largest_step(&turned);
            assert!(
                step <= limit,
                "{shape:?} {from} → {to:?}: step {step} > {limit}"
            );
        }
    }
}

#[test]
fn an_oscillator_mixed_in_during_a_note_is_where_the_note_s_time_has_taken_it() {
    // Osc 2 as Osc 1, so mixed in it changes nothing, unless it starts from where it was left.
    let alike = [(OSC2.coarse, 0.0), (OSC2.shape, PARAMS[0].default)];
    let mixed_in = [Event::param_at_start(OSC2.mix.unwrap(), 0.5)];
    let late = seconds(0.1) + 37;
    let mixed = play_set(&alike, &[(&[on(0, A4)], late), (&mixed_in, late)]);
    let alone = play_set(&alike, &[(&[on(0, A4)], late), (&[], late)]);
    let differs = difference(&mixed, &alone, 0..alone.len());
    assert!(differs < 1e-6, "{differs}");
}

#[test]
fn a_note_too_high_to_sound_still_takes_a_voice_its_oscillator_may_be_tuned_down_to() {
    let sample_rate = rate(8000);
    // 4186 Hz, past 4 kHz.
    let key = 108;
    let mut synth = create(sample_rate);
    let mut events = first_block(&DESCRIPTION, &[(SHAPE, SINE)]);
    events.push(on(0, key));
    let [high, _] = render(&DESCRIPTION, synth.as_mut(), &events, &silence(1000));
    assert_eq!(peak(&high), 0.0);
    let down = [Event::param_at_start(OSC1.coarse, -12.0)];
    let [tuned, _] = render(&DESCRIPTION, synth.as_mut(), &down, &silence(1000));
    assert!(peak(&tuned) > 0.9 * VOICE_GAIN, "{}", peak(&tuned));
}
