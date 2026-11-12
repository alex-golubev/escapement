use std::thread;
use std::time::{Duration, Instant};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use engine_plugins::catalog::filter;
use engine_plugins::catalog::sampler;
use engine_plugins::catalog::synth;
use engine_plugins::catalog::tone::{self, FREQUENCY, MAX_GAIN};
use engine_plugins::smoothing::ramp_samples;

use super::*;
use crate::builder::Builder;
use crate::commands::PARSE_BUDGET;
use crate::events::EVENT_CAPACITY;
use crate::framing;
use crate::graph;
use crate::node::NOTE_ROOM;
use crate::notes::PAGE_NOTES;
use crate::pool::Hash;
use crate::schema::{self, AfterBatch, CommandKind};
use crate::sequencer::NOTE_BUDGET;
use crate::testing::commands::{
    after_batch, hang_audio, no_kind, note_off, note_on, panic_audio, placed_transport, set_param,
    set_strip_param, set_tempo, set_transport, unknown_kind, wrong_size,
};
use crate::testing::edits::{
    NewNode, Placed, Played, Spec, batch as batch_bytes, connect, create_insert, create_node,
    disconnect,
};
use crate::testing::events::decode;
use crate::testing::pool::store;
use crate::testing::{BAR, FRAMES_PER_TICK, SAMPLE_RATE, handle, note_room, seconds, ticks_in};
use crate::transport::TICKS_PER_QUARTER;
use crate::{CHANNELS, new, strip};

const TONE: u32 = 1;
const FILTER: u32 = 2;
const SAMPLER: u32 = 3;
const SYNTH: u32 = 4;
const KICK: Hash = [11; 32];
const SNARE: Hash = [12; 32];
/// The numbers of parameters and samples as the page writes them.
mod raw {
    use super::{filter, sampler, strip, tone};

    pub(super) const VOLUME: u32 = tone::VOLUME.get();
    pub(super) const CUTOFF: u32 = filter::CUTOFF.get();
    pub(super) const SAMPLE: u32 = sampler::SAMPLE.get();
    pub(super) const VOLUME_NUMBER: u32 = strip::VOLUME_NUMBER.get();
    pub(super) const PAN_NUMBER: u32 = strip::PAN_NUMBER.get();
}

const DEFAULT_VOLUME: f32 = tone::VOLUME
    .entry(tone::DESCRIPTION.params)
    .unwrap()
    .default;
const VOLUME_RAMP_SECONDS: f32 = tone::VOLUME
    .entry(tone::DESCRIPTION.params)
    .unwrap()
    .smoothing_seconds;
/// Blocks a connection takes to rise or fall, and one over.
const FADE_BLOCKS: usize = seconds(graph::FADE_SECONDS) / BLOCK_FRAMES + 1;

/// Both parts of the engine, driven the way the page and the build thread drive them.
struct Rig {
    builder: Builder,
    engine: Engine,
    next_batch: u32,
}

impl Rig {
    fn empty() -> Self {
        let (builder, engine) = new(SAMPLE_RATE);
        Self {
            builder,
            engine,
            next_batch: 1,
        }
    }

    /// The test tone on the output, then `commands`.
    fn with_tone(commands: &[Vec<u8>]) -> Self {
        let mut rig = Self::empty();
        rig.send(
            &[create_node(TONE, &tone::DESCRIPTION), Spec::SetOutput(TONE)],
            commands,
        );
        rig
    }

    /// As the page sends a transaction: the batch to the build thread, its marker and `commands` to the ring.
    fn send(&mut self, edits: &[Spec<'_>], commands: &[Vec<u8>]) {
        let batch = self.next_batch;
        self.next_batch += 1;
        self.write(&[after_batch(batch)]);
        self.write(commands);
        self.builder.build(batch, &batch_bytes(edits));
    }

    fn write(&mut self, commands: &[Vec<u8>]) {
        for command in commands {
            let input = self.engine.input();
            let written = input.write(command);
            assert!(
                written == command.len() || input.is_lost(),
                "no room for a command"
            );
        }
    }
}

/// A sampler on the output, playing nothing until a note, once the output has risen.
fn with_sampler(samples: &[(u32, Hash)]) -> Rig {
    let mut rig = Rig::empty();
    rig.send(
        &[
            NewNode::of(SAMPLER, &sampler::DESCRIPTION)
                .samples(samples)
                .into(),
            Spec::SetOutput(SAMPLER),
        ],
        &[],
    );
    assert!(
        left(&mut rig.engine, FADE_BLOCKS)
            .iter()
            .all(|&heard| heard == 0.0)
    );
    rig
}

/// A sampler with [`KICK`] for its sound.
fn sampler_with_kick(node: u32) -> Spec<'static> {
    NewNode::of(node, &sampler::DESCRIPTION)
        .samples(&[(raw::SAMPLE, KICK)])
        .into()
}

fn kick() -> Vec<f32> {
    (0..500).map(|i| 0.001 * (i + 1) as f32).collect()
}

/// The filter on the output, hearing the tone.
fn filter_on_tone(params: &[(u32, f32)]) -> [Spec<'_>; 3] {
    [
        NewNode::of(FILTER, &filter::DESCRIPTION)
            .params(params)
            .into(),
        connect(TONE, FILTER),
        Spec::SetOutput(FILTER),
    ]
}

/// The left channel of `blocks` blocks.
fn left(engine: &mut Engine, blocks: usize) -> Vec<f32> {
    (0..blocks)
        .flat_map(|_| {
            engine.process(BLOCK_FRAMES);
            *engine.output(0)
        })
        .collect()
}

fn largest_step(samples: &[f32]) -> f32 {
    samples
        .windows(2)
        .fold(0.0, |step, pair| step.max((pair[1] - pair[0]).abs()))
}

/// The mean over each period of the tone: away from zero, the sound has a thump in it.
fn largest_thump(samples: &[f32]) -> f32 {
    let period = seconds(FREQUENCY.recip());
    samples.windows(period).fold(0.0, |thump, window| {
        let mean = window.iter().sum::<f32>() / period as f32;
        thump.max(mean.abs())
    })
}

/// Loudest sample over `blocks` blocks.
fn peak(engine: &mut Engine, blocks: usize) -> f32 {
    loudest(&left(engine, blocks))
}

fn loudest(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

/// Once a volume change has finished.
fn settled_peak(engine: &mut Engine) -> f32 {
    let ramp_blocks = seconds(VOLUME_RAMP_SECONDS) / BLOCK_FRAMES + 1;
    peak(engine, ramp_blocks);
    peak(engine, 4)
}

fn at_volume(volume: f32) -> f32 {
    MAX_GAIN * volume
}

/// The tone's own largest step between samples, at its default volume.
fn tone_step() -> f32 {
    let mut rig = Rig::with_tone(&[]);
    peak(&mut rig.engine, FADE_BLOCKS);
    largest_step(&left(&mut rig.engine, 4))
}

/// No step between samples beyond the tone's own, and no thump.
fn assert_smooth(heard: &[f32], at: &str) {
    let alone = tone_step();
    let (step, thump) = (largest_step(heard), largest_thump(heard));
    assert!(
        step <= alone * 1.05,
        "{at}: step {step}, the tone's {alone}"
    );
    assert!(
        thump < at_volume(DEFAULT_VOLUME) / 20.0,
        "{at}: thump {thump}"
    );
}

/// What is heard from `blocks` blocks before `edits` until both fades are over, once `rig` has settled.
fn heard_across(rig: &mut Rig, blocks: usize, edits: &[Spec<'_>]) -> Vec<f32> {
    peak(&mut rig.engine, FADE_BLOCKS);
    let mut heard = left(&mut rig.engine, blocks);
    rig.send(edits, &[]);
    heard.extend(left(&mut rig.engine, 2 * FADE_BLOCKS));
    heard
}

/// The loudest sample of each period of the tone: a window a sample longer than one holds a whole period.
fn period_peaks(samples: &[f32]) -> Vec<f32> {
    let period = seconds(FREQUENCY.recip()) + 1;
    samples
        .windows(period)
        .map(|window| window.iter().fold(0.0, |peak, s| f32::max(peak, s.abs())))
        .collect()
}

fn events(engine: &mut Engine) -> Vec<(u32, EngineEvent)> {
    decode(engine.take_events(usize::MAX))
}

fn rejected(epoch: u32, reason: Rejection) -> (u32, EngineEvent) {
    (epoch, EngineEvent::CommandRejected(reason))
}

fn edit_rejected(epoch: u32, batch: u32, reason: Rejection) -> (u32, EngineEvent) {
    (
        epoch,
        EngineEvent::EditRejected {
            batch: Batch::new(batch),
            reason,
        },
    )
}

#[test]
fn a_new_engine_is_silent() {
    let mut rig = Rig::empty();
    assert_eq!(peak(&mut rig.engine, 4), 0.0);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn set_param_changes_the_volume() {
    let mut rig = Rig::with_tone(&[]);
    rig.write(&[set_param(TONE, raw::VOLUME, 0.25)]);
    assert!((settled_peak(&mut rig.engine) - at_volume(0.25)).abs() < 1e-3);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn initial_values_apply_from_the_first_sample() {
    // Against the tone at its default volume: a new node fades in, but alike at any volume.
    let first_block = |volume: &[(u32, f32)], commands: &[Vec<u8>]| {
        let mut rig = Rig::empty();
        rig.send(
            &[
                NewNode::of(TONE, &tone::DESCRIPTION).params(volume).into(),
                Spec::SetOutput(TONE),
            ],
            commands,
        );
        peak(&mut rig.engine, 1)
    };
    let default = first_block(&[], &[]);
    assert!(default > 0.0);
    let ratio = 0.25 / DEFAULT_VOLUME;
    let in_batch = first_block(&[(raw::VOLUME, 0.25)], &[]);
    assert!((in_batch / default - ratio).abs() < 1e-3);
    // Live edits right behind the marker come before the node's first block too.
    let behind_marker = first_block(&[], &[set_param(TONE, raw::VOLUME, 0.25)]);
    assert!((behind_marker / default - ratio).abs() < 1e-3);
}

/// Loudest sample of each side once a change has finished.
fn settled_sides(engine: &mut Engine) -> [f32; CHANNELS] {
    settled_peak(engine);
    let mut sides = [0.0; CHANNELS];
    for _ in 0..4 {
        engine.process(BLOCK_FRAMES);
        for (side, peak) in sides.iter_mut().enumerate() {
            *peak = loudest(engine.output(side)).max(*peak);
        }
    }
    sides
}

#[test]
fn a_node_s_strip_turns_its_volume_and_pans_it() {
    let mut rig = Rig::with_tone(&[]);
    let alone = at_volume(DEFAULT_VOLUME);
    let [left, right] = settled_sides(&mut rig.engine);
    assert_eq!(left, right);
    assert!((left - alone).abs() < 1e-3);
    rig.write(&[set_strip_param(TONE, raw::VOLUME_NUMBER, 0.5)]);
    let [left, right] = settled_sides(&mut rig.engine);
    assert!((left - alone / 2.0).abs() < 1e-3 && (right - left).abs() < 1e-6);
    rig.write(&[set_strip_param(TONE, raw::PAN_NUMBER, 1.0)]);
    let [left, right] = settled_sides(&mut rig.engine);
    assert_eq!(left, 0.0);
    assert!((right - alone / 2.0 * std::f32::consts::SQRT_2).abs() < 1e-3);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn an_insert_has_a_strip_too() {
    const INSERT: u32 = 3;
    let mut rig = Rig::empty();
    rig.send(
        &[
            create_insert(INSERT, &[(raw::PAN_NUMBER, -1.0)]),
            create_node(TONE, &tone::DESCRIPTION),
            connect(TONE, INSERT),
            Spec::SetOutput(INSERT),
        ],
        &[],
    );
    let [left, right] = settled_sides(&mut rig.engine);
    assert!((left - at_volume(DEFAULT_VOLUME) * std::f32::consts::SQRT_2).abs() < 1e-3);
    assert_eq!(right, 0.0);
}

#[test]
fn an_insert_s_meter_measures_what_it_passes_on_under_its_node_s_handle() {
    const LEFT: u32 = handle(1, 3);
    const HALF: u32 = 4;
    const UNMETERED: u32 = 5;
    let mut rig = Rig::empty();
    rig.send(
        &[
            Spec::CreateInsert {
                node: LEFT,
                strip: &[(raw::PAN_NUMBER, -1.0)],
                metered: true,
            },
            Spec::CreateInsert {
                node: HALF,
                strip: &[(raw::VOLUME_NUMBER, 0.5)],
                metered: true,
            },
            create_insert(UNMETERED, &[]),
            create_node(TONE, &tone::DESCRIPTION),
            connect(TONE, LEFT),
            connect(TONE, HALF),
            connect(TONE, UNMETERED),
            Spec::SetOutput(UNMETERED),
        ],
        &[],
    );
    settled_peak(&mut rig.engine);
    let alone = at_volume(DEFAULT_VOLUME);
    let telemetry = rig.engine.telemetry();
    let mut records = telemetry.meters[..telemetry.meters_used as usize].to_vec();
    records.sort_by_key(|record| record.node);
    let [half, left] = records[..] else {
        panic!("records {records:?}")
    };
    assert_eq!((half.node, left.node), (HALF, LEFT));
    // After the strip: half as loud, or all on the left, louder there as the pan keeps the power.
    assert!(
        half.peaks
            .iter()
            .all(|peak| (peak - alone / 2.0).abs() < 1e-3)
    );
    assert!((left.peaks[0] - alone * std::f32::consts::SQRT_2).abs() < 1e-3);
    assert_eq!(left.peaks[1], 0.0);
    assert_eq!((half.overs, left.overs), ([0, 0], [0, 0]));
    // A node gone takes its record with it.
    rig.send(&[Spec::DestroyNode(LEFT)], &[]);
    rig.engine.process(BLOCK_FRAMES);
    let telemetry = rig.engine.telemetry();
    assert_eq!(telemetry.meters_used, 1);
    assert_eq!(telemetry.meters[0].node, HALF);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn initial_strip_values_apply_from_the_first_sample() {
    let first_block = |strip: &[(u32, f32)], commands: &[Vec<u8>]| {
        let mut rig = Rig::empty();
        let tone = NewNode::of(TONE, &tone::DESCRIPTION).strip(strip).into();
        rig.send(&[tone, Spec::SetOutput(TONE)], commands);
        peak(&mut rig.engine, 1)
    };
    let default = first_block(&[], &[]);
    assert!(default > 0.0);
    let in_batch = first_block(&[(raw::VOLUME_NUMBER, 0.25)], &[]);
    assert!((in_batch / default - 0.25).abs() < 1e-3);
    let behind_marker = first_block(&[], &[set_strip_param(TONE, raw::VOLUME_NUMBER, 0.25)]);
    assert!((behind_marker / default - 0.25).abs() < 1e-3);
}

#[test]
fn an_initial_strip_value_refused_is_left_at_its_default_and_the_others_apply() {
    let mut rig = Rig::empty();
    let tone = NewNode::of(TONE, &tone::DESCRIPTION)
        .strip(&[(raw::VOLUME_NUMBER, f32::NAN), (raw::PAN_NUMBER, 1.0)])
        .into();
    rig.send(&[tone, Spec::SetOutput(TONE)], &[]);
    let [left, right] = settled_sides(&mut rig.engine);
    assert_eq!(left, 0.0);
    assert!((right - at_volume(DEFAULT_VOLUME) * std::f32::consts::SQRT_2).abs() < 1e-3);
}

#[test]
fn strip_values_that_are_not_numbers_and_unknown_addresses_are_refused() {
    let mut rig = Rig::with_tone(&[
        set_strip_param(TONE, raw::VOLUME_NUMBER, f32::NAN),
        set_strip_param(TONE, raw::PAN_NUMBER, f32::INFINITY),
        set_strip_param(TONE + 1, raw::VOLUME_NUMBER, 0.0),
        set_strip_param(0, raw::VOLUME_NUMBER, 0.0),
        set_strip_param(TONE, 0, 0.0),
        set_strip_param(TONE, raw::PAN_NUMBER + 1, 0.0),
    ]);
    let [left, right] = settled_sides(&mut rig.engine);
    assert!((left - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    assert_eq!(left, right);
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::InvalidValue),
            rejected(0, Rejection::InvalidValue),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
        ]
    );
}

#[test]
fn the_tone_through_the_filter_gets_quieter_as_the_cutoff_goes_down() {
    let mut rig = Rig::with_tone(&[]);
    rig.send(&filter_on_tone(&[]), &[]);
    // Open, the filter leaves the tone as it is.
    assert!((settled_peak(&mut rig.engine) - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    rig.write(&[set_param(FILTER, raw::CUTOFF, 200.0)]);
    // 440 Hz is more than an octave above: over 12 dB down.
    assert!(settled_peak(&mut rig.engine) < at_volume(DEFAULT_VOLUME) / 4.0);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn a_filter_goes_into_a_playing_tone_without_a_click() {
    // Open, and closed well below the tone, at a few points of its wave.
    for params in [&[][..], &[(raw::CUTOFF, 200.0)], &[(raw::CUTOFF, 40.0)]] {
        for blocks in 2..5 {
            let mut rig = Rig::with_tone(&[]);
            // Past the tone's own fade-in.
            peak(&mut rig.engine, 8);
            let mut heard = left(&mut rig.engine, blocks);
            let alone = largest_step(&heard);
            rig.send(&filter_on_tone(params), &[]);
            heard.extend(left(&mut rig.engine, 16));
            let (step, thump) = (largest_step(&heard), largest_thump(&heard));
            let at = format!("{params:?} after {blocks} blocks");
            assert!(
                step <= alone * 1.05,
                "{at}: step {step}, the tone's {alone}"
            );
            assert!(
                thump < at_volume(DEFAULT_VOLUME) / 20.0,
                "{at}: thump {thump}"
            );
        }
    }
}

#[test]
fn live_edits_behind_a_marker_wait_for_its_parcel() {
    let mut rig = Rig::empty();
    rig.write(&[after_batch(1), set_param(TONE, raw::VOLUME, 0.25)]);
    assert_eq!(peak(&mut rig.engine, 3), 0.0);
    assert_eq!(
        events(&mut rig.engine),
        [],
        "the volume waited for its node"
    );
    let edits = [create_node(TONE, &tone::DESCRIPTION), Spec::SetOutput(TONE)];
    rig.builder.build(1, &batch_bytes(&edits));
    assert!((settled_peak(&mut rig.engine) - at_volume(0.25)).abs() < 1e-3);
}

#[test]
fn a_batch_does_not_overtake_live_edits_sent_before_it() {
    let mut rig = Rig::with_tone(&[]);
    // Meant for the node being replaced.
    rig.write(&[set_param(TONE, raw::VOLUME, 0.1)]);
    let edits = [
        Spec::Reset(1),
        create_node(TONE, &tone::DESCRIPTION),
        Spec::SetOutput(TONE),
    ];
    rig.send(&edits, &[]);
    let expected = at_volume(DEFAULT_VOLUME);
    assert!((settled_peak(&mut rig.engine) - expected).abs() < 1e-3);
}

#[test]
fn a_marker_for_another_batch_than_the_next_is_rejected_at_once() {
    let mut rig = Rig::empty();
    rig.write(&[after_batch(2)]);
    rig.send(
        &[create_node(TONE, &tone::DESCRIPTION), Spec::SetOutput(TONE)],
        &[],
    );
    assert!(peak(&mut rig.engine, 1) > 0.0);
    // Batch 1 again and one far ahead, with nothing in line: neither may hold the live edit behind them.
    rig.write(&[
        after_batch(1),
        after_batch(5),
        set_param(TONE, raw::VOLUME, 0.25),
    ]);
    assert!((settled_peak(&mut rig.engine) - at_volume(0.25)).abs() < 1e-3);
    assert_eq!(
        events(&mut rig.engine),
        [rejected(0, Rejection::UnknownTarget); 3]
    );
}

#[test]
fn after_a_lost_stream_parcels_go_back_unapplied() {
    let mut rig = Rig::with_tone(&[]);
    rig.write(&[u32::MAX.to_le_bytes().to_vec()]);
    let mut calls = audio_block(&mut rig.engine, EVENT_CAPACITY);
    rig.send(&[Spec::Reset(1)], &[]);
    calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
    assert_eq!(calls, 0);
    assert_eq!(
        rig.builder.collect(),
        0,
        "nothing piles up on the build thread"
    );
    assert!((settled_peak(&mut rig.engine) - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    assert_eq!(rig.engine.telemetry().epoch, 0);
}

#[test]
fn a_volume_change_starts_in_the_block_it_arrives_in() {
    // Two engines in step; only one gets the command.
    let (mut rig, mut unchanged) = (Rig::with_tone(&[]), Rig::with_tone(&[]));
    peak(&mut rig.engine, 1);
    peak(&mut unchanged.engine, 1);
    rig.write(&[set_param(TONE, raw::VOLUME, 0.0)]);
    let (first, reference) = (peak(&mut rig.engine, 1), peak(&mut unchanged.engine, 1));
    assert!(
        0.0 < first && first < reference,
        "first block peak {first}, unchanged {reference}"
    );
    assert_eq!(settled_peak(&mut rig.engine), 0.0);
}

#[test]
fn clamps_the_volume() {
    let mut rig = Rig::with_tone(&[set_param(TONE, raw::VOLUME, 3.0)]);
    assert!((settled_peak(&mut rig.engine) - MAX_GAIN).abs() < 1e-3);
}

#[test]
fn rejects_values_that_are_not_numbers_and_unknown_addresses() {
    let mut rig = Rig::with_tone(&[
        set_param(TONE, raw::VOLUME, f32::NAN),
        set_param(TONE, raw::VOLUME, f32::INFINITY),
        set_param(TONE + 1, raw::VOLUME, 0.0),
        set_param(0, raw::VOLUME, 0.0),
        set_param(TONE, 0, 0.0),
        set_param(TONE, raw::VOLUME + 1, 0.0),
    ]);
    assert!((settled_peak(&mut rig.engine) - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::InvalidValue),
            rejected(0, Rejection::InvalidValue),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
            rejected(0, Rejection::UnknownTarget),
        ]
    );
}

#[test]
fn an_insert_passes_on_the_sum_of_what_it_hears_and_takes_no_parameter() {
    const INSERT: u32 = 3;
    let mut rig = Rig::empty();
    rig.send(
        &[
            create_insert(INSERT, &[]),
            create_node(TONE, &tone::DESCRIPTION),
            create_node(TONE + 10, &tone::DESCRIPTION),
            connect(TONE, INSERT),
            connect(TONE + 10, INSERT),
            Spec::SetOutput(INSERT),
        ],
        &[set_param(INSERT, raw::VOLUME, 0.25)],
    );
    // Two tones in phase: twice one.
    assert!((settled_peak(&mut rig.engine) - 2.0 * at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    assert_eq!(
        events(&mut rig.engine),
        [rejected(0, Rejection::UnknownTarget)]
    );
}

#[test]
#[should_panic(expected = "PanicAudio 7")]
fn panic_audio_panics_with_its_code() {
    let mut rig = Rig::empty();
    rig.write(&[panic_audio(7)]);
    rig.engine.process(BLOCK_FRAMES);
}

#[test]
#[should_panic(expected = "hangs")]
fn hang_audio_hangs() {
    let mut rig = Rig::empty();
    rig.write(&[hang_audio(7)]);
    rig.engine.process(BLOCK_FRAMES);
}

#[test]
fn a_block_hands_out_its_events_where_the_worklet_reads_them() {
    let mut rig = Rig::empty();
    rig.write(&[unknown_kind()]);
    let len = rig.engine.audio_block(BLOCK_FRAMES, usize::MAX);
    // Safety: a block hands out `len` bytes from there, as the worklet reads them.
    let handed = unsafe { std::slice::from_raw_parts(rig.engine.events().as_ptr(), len) };
    assert_eq!(decode(handed), [rejected(0, Rejection::UnknownCommand)]);
}

#[test]
fn rejects_records_of_the_wrong_size_and_unknown_kinds() {
    let mut rig = Rig::empty();
    rig.write(&[wrong_size(), unknown_kind()]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::Malformed),
            rejected(0, Rejection::UnknownCommand),
        ]
    );
}

#[test]
fn edits_the_build_thread_refused_come_back_with_their_batch_and_session() {
    let mut rig = Rig::with_tone(&[]);
    let unknown_plugin = NewNode::of(2, &tone::DESCRIPTION).plugin(0).into();
    // The tone's number is taken; after the reset there is no node to hear.
    let edits = [
        unknown_plugin,
        create_node(TONE, &tone::DESCRIPTION),
        Spec::Reset(5),
        Spec::SetOutput(TONE),
    ];
    rig.send(&edits, &[]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(
        events(&mut rig.engine),
        [
            edit_rejected(0, 2, Rejection::UnknownPlugin),
            edit_rejected(0, 2, Rejection::CellTaken),
            edit_rejected(5, 2, Rejection::UnknownTarget),
        ]
    );
    rig.builder.build(3, &[1, 2, 3]);
    rig.write(&[after_batch(3)]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(
        events(&mut rig.engine),
        [edit_rejected(5, 3, Rejection::Malformed)]
    );
}

#[test]
fn events_carry_the_session_they_happened_in() {
    let bad = set_param(TONE + 1, raw::VOLUME, 0.0);
    let mut rig = Rig::empty();
    rig.write(std::slice::from_ref(&bad));
    rig.send(&[Spec::Reset(3)], &[bad]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::UnknownTarget),
            rejected(3, Rejection::UnknownTarget),
        ]
    );
}

#[test]
fn reset_removes_every_node_and_starts_a_session() {
    let mut rig = Rig::with_tone(&[]);
    rig.send(&[create_node(40, &tone::DESCRIPTION)], &[]);
    assert!(peak(&mut rig.engine, 1) > 0.0);
    rig.send(&[Spec::Reset(3)], &[set_param(TONE, raw::VOLUME, 0.5)]);
    assert_eq!(
        rig.engine.telemetry().epoch,
        0,
        "applied at its marker, in the next block"
    );
    peak(&mut rig.engine, FADE_BLOCKS);
    assert_eq!(peak(&mut rig.engine, 4), 0.0);
    assert_eq!(rig.engine.telemetry().epoch, 3);
    assert_eq!(
        events(&mut rig.engine),
        [rejected(3, Rejection::UnknownTarget)]
    );
    // Every parcel is back, with the nodes it took out, and each cell is free again.
    assert_eq!(rig.builder.collect(), 0);
    rig.send(
        &[create_node(TONE, &tone::DESCRIPTION), Spec::SetOutput(TONE)],
        &[],
    );
    assert!(peak(&mut rig.engine, 1) > 0.0);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn a_removed_node_plays_out_for_the_whole_fade_and_then_goes_back() {
    let mut rig = Rig::with_tone(&[]);
    peak(&mut rig.engine, FADE_BLOCKS);
    assert_eq!(rig.builder.collect(), 0);
    rig.send(
        &[Spec::DestroyNode(TONE)],
        &[set_param(TONE, raw::VOLUME, 0.5)],
    );
    let fading = peak(&mut rig.engine, FADE_BLOCKS - 2);
    assert!(fading > 0.0);
    assert_eq!(rig.builder.collect(), 1, "still playing out");
    peak(&mut rig.engine, 2);
    assert_eq!(peak(&mut rig.engine, 2), 0.0);
    assert_eq!(rig.builder.collect(), 0);
    assert_eq!(
        events(&mut rig.engine),
        [rejected(0, Rejection::UnknownTarget)]
    );
}

#[test]
fn removing_a_tone_fades_it_out_without_a_click() {
    // On the output, and through a filter closed well below it, from a few points of its wave.
    for through in [None, Some(200.0), Some(40.0)] {
        for blocks in 2..5 {
            let mut rig = Rig::with_tone(&[]);
            if let Some(cutoff) = through {
                rig.send(&filter_on_tone(&[(raw::CUTOFF, cutoff)]), &[]);
            }
            let heard = heard_across(&mut rig, blocks, &[Spec::DestroyNode(TONE)]);
            assert_smooth(
                &heard,
                &format!("through {through:?} after {blocks} blocks"),
            );
            // A filter rings out on its own; the tone alone just stops.
            let end = &heard[heard.len() - BLOCK_FRAMES..];
            let quiet = if through.is_some() { 1e-4 } else { 0.0 };
            assert!(end.iter().all(|&sample| sample.abs() <= quiet));
        }
    }
}

#[test]
fn removing_a_filter_and_hearing_the_tone_again_goes_over_without_a_click() {
    for cutoff in [20_000.0, 200.0, 40.0] {
        for blocks in 2..5 {
            let mut rig = Rig::with_tone(&[]);
            rig.send(&filter_on_tone(&[(raw::CUTOFF, cutoff)]), &[]);
            let edits = [Spec::DestroyNode(FILTER), Spec::SetOutput(TONE)];
            let heard = heard_across(&mut rig, blocks, &edits);
            assert_smooth(&heard, &format!("{cutoff} Hz after {blocks} blocks"));
            assert!((settled_peak(&mut rig.engine) - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
        }
    }
}

#[test]
fn a_tone_connected_to_a_playing_filter_rises_without_a_click() {
    for cutoff in [20_000.0, 200.0] {
        for blocks in 2..5 {
            let mut rig = Rig::empty();
            // The filter on the output, hearing nothing yet.
            let params = [(raw::CUTOFF, cutoff)];
            rig.send(
                &[
                    NewNode::of(FILTER, &filter::DESCRIPTION)
                        .params(&params)
                        .into(),
                    Spec::SetOutput(FILTER),
                ],
                &[],
            );
            let edits = [create_node(TONE, &tone::DESCRIPTION), connect(TONE, FILTER)];
            let heard = heard_across(&mut rig, blocks, &edits);
            assert_smooth(&heard, &format!("{cutoff} Hz after {blocks} blocks"));
        }
    }
}

#[test]
fn the_output_goes_over_between_two_playing_nodes_without_a_click() {
    for blocks in 2..5 {
        let mut rig = Rig::with_tone(&[]);
        // A tone of its own phase, playing unheard.
        peak(&mut rig.engine, blocks);
        rig.send(&[create_node(2, &tone::DESCRIPTION)], &[]);
        let heard = heard_across(&mut rig, blocks, &[Spec::SetOutput(2)]);
        assert_smooth(&heard, &format!("after {blocks} blocks"));
    }
}

#[test]
fn a_reset_while_playing_fades_out_and_a_rebuild_in_the_same_batch_fades_in() {
    let [filter, connect, output] = filter_on_tone(&[(raw::CUTOFF, 300.0)]);
    let rebuild = [
        Spec::Reset(1),
        create_node(TONE, &tone::DESCRIPTION),
        filter,
        connect,
        output,
    ];
    for edits in [&[Spec::Reset(1)][..], &rebuild] {
        for blocks in 2..5 {
            let mut rig = Rig::with_tone(&[]);
            rig.send(&filter_on_tone(&[(raw::CUTOFF, 300.0)]), &[]);
            let heard = heard_across(&mut rig, blocks, edits);
            assert_smooth(
                &heard,
                &format!("{} edits after {blocks} blocks", edits.len()),
            );
        }
    }
}

#[test]
fn quick_changes_inside_the_fade_never_click() {
    let refilter = [
        NewNode::of(handle(1, FILTER), &filter::DESCRIPTION)
            .params(&[(raw::CUTOFF, 200.0)])
            .into(),
        connect(TONE, handle(1, FILTER)),
        Spec::SetOutput(handle(1, FILTER)),
    ];
    let cases: [(&[Spec<'_>], &[Spec<'_>], &[Spec<'_>]); 3] = [
        // A tone added, then removed while it rises.
        (
            &[],
            &[create_node(TONE, &tone::DESCRIPTION), Spec::SetOutput(TONE)],
            &[Spec::DestroyNode(TONE)],
        ),
        // A filter taken out, then put back while the tone comes back.
        (
            &filter_on_tone(&[(raw::CUTOFF, 200.0)]),
            &[Spec::DestroyNode(FILTER), Spec::SetOutput(TONE)],
            &refilter,
        ),
        // A filter put in, then taken out while it comes in.
        (
            &[],
            &filter_on_tone(&[(raw::CUTOFF, 200.0)]),
            &[Spec::DestroyNode(FILTER), Spec::SetOutput(TONE)],
        ),
    ];
    for (case, (setup, first, second)) in cases.iter().enumerate() {
        for blocks in 1..4 {
            let mut rig = if case == 0 {
                Rig::empty()
            } else {
                Rig::with_tone(&[])
            };
            rig.send(setup, &[]);
            peak(&mut rig.engine, FADE_BLOCKS);
            let mut heard = left(&mut rig.engine, 2);
            rig.send(first, &[]);
            heard.extend(left(&mut rig.engine, blocks));
            rig.send(second, &[]);
            heard.extend(left(&mut rig.engine, 2 * FADE_BLOCKS));
            assert_smooth(&heard, &format!("case {case}, {blocks} blocks apart"));
        }
    }
}

#[test]
fn a_connection_that_closes_a_loop_only_through_a_node_playing_out_is_made() {
    let mut rig = Rig::with_tone(&[]);
    let chain = [
        create_node(2, &filter::DESCRIPTION),
        create_node(3, &filter::DESCRIPTION),
        create_node(4, &filter::DESCRIPTION),
        connect(TONE, 2),
        connect(2, 3),
        connect(3, 4),
        Spec::SetOutput(4),
    ];
    rig.send(&chain, &[]);
    peak(&mut rig.engine, FADE_BLOCKS);
    rig.send(&[Spec::DestroyNode(3)], &[]);
    rig.engine.process(BLOCK_FRAMES);
    // 3 still plays out between 2 and 4, but the page sees no loop.
    rig.send(&[connect(4, 2)], &[]);
    peak(&mut rig.engine, 2 * FADE_BLOCKS);
    assert_eq!(events(&mut rig.engine), []);
    assert_eq!(rig.builder.collect(), 0);
}

#[test]
fn an_effect_made_earlier_and_heard_later_goes_in_without_a_dip() {
    let mut rig = Rig::with_tone(&[]);
    rig.send(&[create_node(FILTER, &filter::DESCRIPTION)], &[]);
    peak(&mut rig.engine, FADE_BLOCKS);
    let edits = [connect(TONE, FILTER), Spec::SetOutput(FILTER)];
    let heard = heard_across(&mut rig, 2, &edits);
    // Open, the filter leaves the tone as it is, so the sound stays as loud all through.
    let lowest = period_peaks(&heard).into_iter().fold(f32::MAX, f32::min);
    assert!(
        lowest > at_volume(DEFAULT_VOLUME) * 0.98,
        "dipped to {lowest}"
    );
}

#[test]
fn a_cell_freed_in_a_batch_takes_a_new_node_and_the_old_handle_reaches_nothing() {
    let mut rig = Rig::with_tone(&[]);
    let new = handle(1, TONE);
    let edits = [
        Spec::DestroyNode(TONE),
        create_node(new, &tone::DESCRIPTION),
        Spec::SetOutput(new),
    ];
    let heard = heard_across(&mut rig, 3, &edits);
    assert_smooth(&heard, "the tone replaced in its cell");
    rig.write(&[
        set_param(TONE, raw::VOLUME, 0.0),
        set_param(new, raw::VOLUME, 0.25),
    ]);
    assert!((settled_peak(&mut rig.engine) - at_volume(0.25)).abs() < 1e-3);
    rig.send(&[connect(TONE, new), Spec::DestroyNode(TONE)], &[]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::UnknownTarget),
            edit_rejected(0, 3, Rejection::UnknownTarget),
            edit_rejected(0, 3, Rejection::UnknownTarget),
        ]
    );
}

#[test]
fn removals_faster_than_they_fade_out_wait_and_never_touch_the_audio_thread_heap() {
    const NODES: u32 = 3000;
    let mut rig = Rig::empty();
    let mut calls = 0;
    for cell in 1..=NODES {
        let node = cell % 2000 + 1;
        rig.send(
            &[
                create_node(node, &tone::DESCRIPTION),
                Spec::SetOutput(node),
                Spec::DestroyNode(node),
            ],
            &[],
        );
        rig.builder.collect();
        if cell % 64 == 0 {
            calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
        }
    }
    let mut blocks = 0;
    while rig.builder.collect() > 0 {
        calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
        blocks += 1;
        assert!(blocks < 10_000, "parcels stopped coming back");
    }
    assert_eq!(calls, 0);
    assert_eq!(events(&mut rig.engine), []);
    assert_eq!(peak(&mut rig.engine, 2), 0.0);
}

/// Runs a block as the audio thread does and returns the heap calls it made; the test thread allocates too,
/// so the count is taken around the block.
fn audio_block(engine: &mut Engine, room: usize) -> u32 {
    let before = heap::calls();
    engine.audio_block(BLOCK_FRAMES, room);
    heap::calls().wrapping_sub(before)
}

/// Each kind of edit the schema has that `edits` leave out.
fn edits_left_out(edits: &[Spec<'_>]) -> Vec<schema::DeviceEdit> {
    let bytes = batch_bytes(edits);
    let sent: Vec<_> = schema::root_as_device_batch(&bytes)
        .unwrap()
        .edits()
        .into_iter()
        .flatten()
        .map(|edit| edit.edit_type())
        .collect();
    schema::DeviceEdit::ENUM_VALUES
        .iter()
        .copied()
        .filter(|kind| *kind != schema::DeviceEdit::NONE && !sent.contains(kind))
        .collect()
}

/// Each kind of command the schema has that `commands` leave out.
fn commands_left_out<'a>(commands: impl IntoIterator<Item = &'a Vec<u8>>) -> Vec<CommandKind> {
    let sent: Vec<_> = commands
        .into_iter()
        .filter_map(|command| command.get(framing::SIZE_PREFIX).copied())
        .collect();
    CommandKind::ENUM_VALUES
        .iter()
        .copied()
        .filter(|kind| !sent.contains(&kind.0))
        .collect()
}

#[test]
#[expect(clippy::too_many_lines, reason = "every command and edit there is")]
fn the_audio_thread_never_touches_the_heap() {
    // Every command and edit there is, refused ones, both overflows and a lost stream.
    const INSERT: u32 = 3;
    let bad = set_param(TONE + 1, raw::VOLUME, 0.0);
    let mut rig = Rig::empty();
    let [filter, tone_to_filter, output] = filter_on_tone(&[(raw::CUTOFF, 300.0)]);
    // More notes than a node and a block have room for, one no note can have, and one of a node that isn't there.
    let mut notes: Vec<Played> = (0..=NOTE_BUDGET).map(|_| (0, TONE, 60, 1.0, 240)).collect();
    notes.extend([
        (1, TONE, 128, 1.0, 240),
        (2, 40, 60, 1.0, 240),
        (3, 99, 60, 1.0, 240),
    ]);
    let past = u32::try_from(FIRST_PATTERN_CELLS).unwrap();
    let edits = [
        NewNode::of(TONE, &tone::DESCRIPTION)
            .params(&[(raw::VOLUME, 0.3), (raw::VOLUME, f32::NAN)])
            .into(),
        create_node(TONE, &tone::DESCRIPTION),
        create_node(40, &tone::DESCRIPTION),
        Spec::SetPattern(PATTERN, &notes),
        Spec::SetClips(&WHOLE),
        Spec::SetOutput(40),
        Spec::DestroyNode(40),
        Spec::Reset(2),
        create_node(TONE, &tone::DESCRIPTION),
        Spec::SetOutput(TONE),
        Spec::SetPattern(PATTERN, &notes),
        Spec::SetPattern(PATTERN, &notes),
        // Past the pattern table, of a taken cell, of none, and gone.
        Spec::SetPattern(past, &notes),
        Spec::SetPattern(handle(1, PATTERN), &[]),
        Spec::SetPattern(0, &[]),
        Spec::DestroyPattern(past),
        Spec::DestroyPattern(past),
        // Clips that overlap, of no length, of a pattern that isn't there, and after a clip of every tick.
        Spec::SetClips(&[
            (0, BAR, BAR, 0, PATTERN),
            (1, BAR, BAR, 0, PATTERN),
            (0, 0, BAR, 0, PATTERN),
            (2, BAR, BAR, 0, 99),
            (0, u32::MAX, u32::MAX, 0, PATTERN),
        ]),
        filter,
        tone_to_filter,
        output,
        tone_to_filter,
        Spec::Connect {
            from: FILTER,
            to: TONE,
        },
        create_insert(
            INSERT,
            &[(raw::VOLUME_NUMBER, 0.5), (raw::PAN_NUMBER, f32::NAN)],
        ),
        connect(TONE, INSERT),
        disconnect(TONE, INSERT),
        disconnect(TONE, INSERT),
        Spec::LetGoOfNotes(TONE),
        Spec::LetGoOfNotes(40),
        Spec::Bare(schema::DeviceEdit(schema::DeviceEdit::ENUM_MAX + 1)),
    ];
    // An insert has no parameters, and lets notes pass.
    let live = [
        set_param(TONE, raw::VOLUME, 0.3),
        set_param(FILTER, raw::CUTOFF, 5000.0),
        set_param(INSERT, raw::VOLUME, 0.3),
        set_strip_param(TONE, raw::PAN_NUMBER, 0.5),
        set_strip_param(INSERT, raw::VOLUME_NUMBER, 0.5),
        set_strip_param(TONE, raw::PAN_NUMBER + 1, 0.5),
        bad.clone(),
        note_on(TONE, 60, 1.0),
        note_on(INSERT, 60, 1.0),
        note_off(TONE, 60),
        note_off(TONE, PAGE_NOTES),
        note_off(INSERT, 60),
        set_tempo(140.0),
        set_transport(true, 4),
    ];
    let written = [
        set_param(TONE, raw::VOLUME, f32::NAN),
        wrong_size(),
        unknown_kind(),
        no_kind(),
        after_batch(9),
    ];
    // A panic or a hang ends the engine.
    assert_eq!(
        edits_left_out(&edits),
        [
            schema::DeviceEdit::PanicBuild,
            schema::DeviceEdit::HangBuild
        ]
    );
    assert_eq!(
        commands_left_out(live.iter().chain(&written)),
        [CommandKind::PanicAudio, CommandKind::HangAudio]
    );
    rig.send(&edits, &live);
    rig.write(&written);
    rig.builder.build(2, &[1, 2, 3]);
    rig.write(&[after_batch(2)]);
    let mut calls = audio_block(&mut rig.engine, EVENT_CAPACITY);
    assert_eq!(rig.engine.telemetry().lost_events, 0);
    assert_ne!(rig.engine.telemetry().lost_notes, 0);
    // The reset's parcel goes back once the fade is over.
    for _ in 0..FADE_BLOCKS {
        calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
    }
    assert_eq!(rig.builder.collect(), 0);

    // A block's budget of the shortest rejected messages overflows the engine's buffer; the ring has room.
    let flood = PARSE_BUDGET / no_kind().len();
    let write_flood = |rig: &mut Rig| rig.write(&vec![no_kind(); flood]);
    write_flood(&mut rig);
    calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
    let lost_in_engine = rig.engine.telemetry().lost_events;
    assert!(0 < lost_in_engine && (lost_in_engine as usize) < flood);

    // Again, with no room in the ring.
    write_flood(&mut rig);
    calls += audio_block(&mut rig.engine, 0);
    assert_eq!(
        rig.engine.telemetry().lost_events - lost_in_engine,
        u32::try_from(flood).unwrap()
    );

    rig.write(&[u32::MAX.to_le_bytes().to_vec()]);
    calls += audio_block(&mut rig.engine, EVENT_CAPACITY);
    assert_eq!(calls, 0);
}

#[test]
fn parcels_cross_between_two_threads_in_order_and_the_audio_thread_never_touches_the_heap() {
    const BATCHES: u32 = 2000;
    let (mut builder, mut engine) = new(SAMPLE_RATE);
    // The page's ring: markers only.
    let (mut markers, mut ring) = rtrb::RingBuffer::<u32>::new(BATCHES as usize);
    // A short loop, so most blocks pass a note.
    let play = set_transport(true, 8);
    let audio = thread::spawn(move || {
        let before = heap::calls();
        assert_eq!(engine.input().write(&play), play.len());
        let mut message = [0; 9];
        // Every batch starts a session numbered after it, so the last one ends the run once its fade is over.
        while engine.telemetry().epoch != BATCHES {
            while let Ok(batch) = ring.pop() {
                let record = AfterBatch::new(batch).0;
                framing::write(&mut message, CommandKind::AfterBatch.0, &record);
                assert_eq!(engine.input().write(&message), message.len());
            }
            engine.audio_block(BLOCK_FRAMES, EVENT_CAPACITY);
        }
        for _ in 0..FADE_BLOCKS {
            engine.audio_block(BLOCK_FRAMES, EVENT_CAPACITY);
        }
        let calls = heap::calls().wrapping_sub(before);
        (engine, calls)
    });
    for batch in 1..=BATCHES {
        // A reset sends every node back; varying numbers grow the table.
        let node = batch % 300 + 1;
        let volume = [(raw::VOLUME, 0.3)];
        let notes = [(0, node, 60, 1.0, 240), (4, node, 62, 1.0, 240)];
        let edits = [
            Spec::Reset(batch),
            NewNode::of(node, &tone::DESCRIPTION).params(&volume).into(),
            Spec::SetOutput(node),
            Spec::SetPattern(PATTERN, &notes),
            Spec::SetClips(&WHOLE),
        ];
        builder.build(batch, &batch_bytes(&edits));
        markers.push(batch).unwrap();
        builder.collect();
    }
    // Parcels the queue had no room for go out as returned ones are freed.
    let deadline = Instant::now() + Duration::from_secs(10);
    while builder.collect() > 0 {
        assert!(Instant::now() < deadline, "parcels stopped coming back");
        thread::yield_now();
    }
    let (mut engine, calls) = audio.join().unwrap();
    assert_eq!(calls, 0);
    // A marker out of order would have been rejected.
    assert_eq!(events(&mut engine), []);
    assert!((settled_peak(&mut engine) - at_volume(0.3)).abs() < 1e-3);
}

#[test]
fn a_reset_leaves_the_sounds_stored() {
    let mut rig = Rig::with_tone(&[]);
    let hash = [7; 32];
    store(rig.builder.samples(), hash, &[&[0.5; 100]], 30).unwrap();
    rig.send(&[Spec::Reset(1)], &[]);
    rig.engine.process(BLOCK_FRAMES);
    let stored = rig
        .builder
        .samples()
        .get(&hash)
        .and_then(|sample| sample.pcm());
    assert_eq!(stored.map(|pcm| pcm.view(0, 0..100)), Some(&[0.5; 100][..]));
}

#[test]
fn a_note_from_the_ring_plays_the_sampler_s_sound() {
    let mut rig = kick_sampler();
    rig.write(&[note_on(SAMPLER, 60, 0.5)]);
    let heard = left(&mut rig.engine, 5);
    let expected: Vec<_> = kick().iter().map(|number| number * 0.5).collect();
    assert_eq!(heard[..500], expected);
    assert!(heard[500..].iter().all(|&heard| heard == 0.0));
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn a_sampler_made_before_its_sound_is_silent_until_the_sound_is_stored() {
    let mut rig = with_sampler(&[(raw::SAMPLE, KICK)]);
    let waiting = rig.builder.samples().get(&KICK);
    assert!(
        waiting.is_some_and(|sample| sample.pcm().is_none()),
        "an empty place"
    );
    rig.write(&[note_on(SAMPLER, 60, 1.0)]);
    assert!(left(&mut rig.engine, 5).iter().all(|&heard| heard == 0.0));
    store(rig.builder.samples(), KICK, &[&kick()], 128).unwrap();
    assert!(
        left(&mut rig.engine, 5).iter().all(|&heard| heard == 0.0),
        "the lost note doesn't start late"
    );
    rig.write(&[note_on(SAMPLER, 60, 1.0)]);
    assert_eq!(left(&mut rig.engine, 5)[..500], kick());
}

#[test]
fn a_sample_the_plugin_does_not_have_is_refused_and_the_node_is_made() {
    let mut rig = with_sampler(&[(2, KICK), (0, SNARE)]);
    let refused = edit_rejected(0, 1, Rejection::UnknownTarget);
    assert_eq!(events(&mut rig.engine), [refused, refused]);
    assert!(rig.builder.samples().get(&KICK).is_none(), "no place made");
    assert!(rig.builder.samples().get(&SNARE).is_none());
    rig.write(&[set_strip_param(SAMPLER, raw::VOLUME_NUMBER, 0.5)]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn an_empty_place_goes_with_the_last_node_that_waited_for_its_sound() {
    let mut rig = with_sampler(&[(raw::SAMPLE, KICK)]);
    rig.send(&[sampler_with_kick(4)], &[]);
    rig.send(&[Spec::DestroyNode(SAMPLER)], &[]);
    left(&mut rig.engine, FADE_BLOCKS + 1);
    rig.builder.collect();
    assert!(
        rig.builder.samples().get(&KICK).is_some(),
        "the other node waits"
    );
    rig.send(&[Spec::DestroyNode(4)], &[]);
    left(&mut rig.engine, FADE_BLOCKS + 1);
    assert_eq!(rig.builder.collect(), 0);
    assert!(rig.builder.samples().get(&KICK).is_none());
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn an_evicted_sound_plays_on_in_the_nodes_that_hold_it_and_the_build_thread_frees_it_after_the_last()
 {
    let mut rig = kick_sampler();
    rig.write(&[note_on(SAMPLER, 60, 1.0)]);
    let mut heard = left(&mut rig.engine, 2);
    let freed = Arc::downgrade(rig.builder.samples().get(&KICK).unwrap());
    rig.builder.samples().evict(&KICK);
    heard.extend(left(&mut rig.engine, 3));
    assert_eq!(heard[..500], kick(), "the voice plays to the end");
    // A node made after the eviction gets the same sound.
    rig.send(
        &[
            sampler_with_kick(4),
            Spec::DestroyNode(SAMPLER),
            Spec::SetOutput(4),
        ],
        &[],
    );
    left(&mut rig.engine, FADE_BLOCKS + 1);
    rig.write(&[note_on(4, 60, 1.0)]);
    assert_eq!(left(&mut rig.engine, 5)[..500], kick());
    rig.send(&[Spec::DestroyNode(4)], &[]);
    left(&mut rig.engine, FADE_BLOCKS + 1);
    assert!(
        freed.upgrade().is_some(),
        "the audio thread hands the node back"
    );
    assert_eq!(rig.builder.collect(), 0);
    assert!(rig.builder.samples().get(&KICK).is_none());
    assert!(freed.upgrade().is_none());
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn rejects_notes_a_node_can_not_take() {
    let mut rig = with_sampler(&[(raw::SAMPLE, KICK)]);
    rig.write(&[
        note_on(SAMPLER + 1, 60, 1.0),
        note_on(SAMPLER, 128, 1.0),
        note_on(SAMPLER, 60, f32::NAN),
    ]);
    rig.write(&vec![note_on(SAMPLER, 60, 1.0); NOTE_ROOM + 1]);
    rig.engine.process(BLOCK_FRAMES);
    let reasons = [
        Rejection::UnknownTarget,
        Rejection::InvalidValue,
        Rejection::InvalidValue,
        Rejection::TooManyNotes,
    ];
    let expected: Vec<_> = reasons
        .into_iter()
        .map(|reason| rejected(0, reason))
        .collect();
    assert_eq!(events(&mut rig.engine), expected);
}

#[test]
fn a_sampler_plays_while_another_sound_is_stored_and_the_audio_thread_never_touches_the_heap() {
    let mut rig = Rig::empty();
    store(rig.builder.samples(), KICK, &[&[0.25; 4000]], 1000).unwrap();
    rig.send(&[sampler_with_kick(SAMPLER), Spec::SetOutput(SAMPLER)], &[]);
    let Rig {
        mut builder,
        mut engine,
        ..
    } = rig;
    let (stop, blocks) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU32::new(0)),
    );
    let (stopped, counted) = (Arc::clone(&stop), Arc::clone(&blocks));
    let note = note_on(SAMPLER, 60, 1.0);
    let audio = thread::spawn(move || {
        let before = heap::calls();
        let mut loudest = 0.0f32;
        while !stopped.load(Ordering::Acquire) {
            assert_eq!(engine.input().write(&note), note.len());
            engine.audio_block(BLOCK_FRAMES, EVENT_CAPACITY);
            loudest = engine
                .output(0)
                .iter()
                .fold(loudest, |loudest, &n| loudest.max(n));
            counted.fetch_add(1, Ordering::Release);
        }
        (heap::calls().wrapping_sub(before), loudest)
    });
    let wait_for = |count: u32| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while blocks.load(Ordering::Acquire) < count {
            assert!(Instant::now() < deadline, "the audio thread stopped");
            thread::yield_now();
        }
    };
    wait_for(20);
    // 16 MB in parts of 64 KB, as the build thread copies a sound.
    store(builder.samples(), SNARE, &[&vec![0.5; 4 << 20]], 1 << 14).unwrap();
    let after = blocks.load(Ordering::Acquire);
    wait_for(after + 20);
    stop.store(true, Ordering::Release);
    let (calls, loudest) = audio.join().unwrap();
    assert_eq!(calls, 0);
    assert!(loudest >= 0.25, "the sampler played: {loudest}");
}

#[test]
fn the_telemetry_holds_the_heap_calls_of_the_thread_that_runs_the_blocks() {
    // The test thread has allocated by now, so the count isn't 0.
    let mut rig = Rig::empty();
    rig.engine.audio_block(BLOCK_FRAMES, EVENT_CAPACITY);
    assert_eq!(rig.engine.telemetry().heap_calls, heap::calls());
    assert_ne!(heap::calls(), 0);
}

#[test]
fn every_rejection_reaches_the_page_or_is_counted() {
    // A block's budget of the shortest rejected messages overflows the engine's buffer.
    let count = PARSE_BUDGET / no_kind().len();
    let mut rig = Rig::empty();
    rig.write(&vec![no_kind(); count]);
    rig.engine.process(BLOCK_FRAMES);
    assert!(
        rig.engine.telemetry().lost_events > 0,
        "the event buffer overflowed"
    );
    // And the ring has room for half of the rest.
    let delivered = decode(rig.engine.take_events(EVENT_CAPACITY / 2)).len();
    assert_eq!(
        delivered + rig.engine.telemetry().lost_events as usize,
        count
    );
}

#[test]
fn events_without_room_in_the_ring_are_lost_and_counted() {
    let bad = set_param(TONE + 1, raw::VOLUME, 0.0);
    let mut rig = Rig::empty();
    rig.write(&[bad.clone(), bad.clone(), bad]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(rig.engine.take_events(0), []);
    assert_eq!(rig.engine.telemetry().lost_events, 3);
    // Lost for good.
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn reports_blocks_session_and_levels() {
    let mut rig = Rig::with_tone(&[]);
    rig.send(
        &[
            Spec::Reset(5),
            create_node(TONE, &tone::DESCRIPTION),
            Spec::SetOutput(TONE),
        ],
        &[],
    );
    let peak = settled_peak(&mut rig.engine);
    let before = rig.engine.telemetry().blocks;
    rig.engine.process(BLOCK_FRAMES);
    rig.engine.process(BLOCK_FRAMES);
    let telemetry = *rig.engine.telemetry();
    assert_eq!(telemetry.blocks, before + 2);
    assert_eq!(telemetry.epoch, 5);
    assert!(
        telemetry
            .peaks
            .iter()
            .all(|&level| (level - peak).abs() < 1e-3),
        "{telemetry:?}"
    );
}

#[test]
fn after_a_lost_stream_no_command_is_applied_and_it_is_reported_once() {
    let mut rig = Rig::with_tone(&[]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(rig.engine.telemetry().stream_lost, 0);
    rig.write(&[u32::MAX.to_le_bytes().to_vec()]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(rig.engine.telemetry().stream_lost, 1);
    rig.write(&[set_param(TONE, raw::VOLUME, 0.0)]);
    assert!((settled_peak(&mut rig.engine) - at_volume(DEFAULT_VOLUME)).abs() < 1e-3);
    assert_eq!(
        events(&mut rig.engine),
        [(0, EngineEvent::CommandStreamLost)]
    );
    assert_eq!(rig.engine.telemetry().stream_lost, 1);
}

/// What the board shows after each of `blocks` blocks.
fn playheads(engine: &mut Engine, blocks: usize) -> Vec<(u32, u32)> {
    (0..blocks)
        .map(|_| {
            engine.process(BLOCK_FRAMES);
            let telemetry = engine.telemetry();
            (telemetry.playing, telemetry.position)
        })
        .collect()
}

/// At 120 and 48 kHz a tick is 25 frames: whole ticks at the start of each block.
fn ticks_at(blocks: std::ops::Range<usize>) -> Vec<(u32, u32)> {
    blocks.map(|block| (1, ticks_in(block) % BAR)).collect()
}

#[test]
fn the_board_shows_where_the_transport_plays() {
    let mut rig = Rig::empty();
    assert_eq!(playheads(&mut rig.engine, 2), [(0, 0), (0, 0)]);
    assert_eq!(rig.engine.telemetry().tempo, 120.0);
    rig.write(&[set_transport(true, BAR)]);
    assert_eq!(playheads(&mut rig.engine, 800), ticks_at(0..800));
    // Stopped, where it stands: where it stopped, or where a place puts it.
    rig.write(&[set_transport(false, BAR)]);
    let stood = ticks_at(800..801)[0].1;
    assert_eq!(playheads(&mut rig.engine, 2), [(0, stood), (0, stood)]);
    rig.write(&[placed_transport(false, BAR, 1, 960)]);
    assert_eq!(playheads(&mut rig.engine, 1), [(0, 960)]);
}

#[test]
fn the_board_shows_the_loop_the_position_goes_round_in() {
    let mut rig = Rig::empty();
    let looped = |engine: &mut Engine| {
        engine.process(BLOCK_FRAMES);
        let telemetry = engine.telemetry();
        (telemetry.position, telemetry.loop_ticks)
    };
    assert_eq!(looped(&mut rig.engine), (0, 0));
    rig.write(&[set_transport(true, 2 * BAR)]);
    let played: Vec<_> = (0..800).map(|_| looped(&mut rig.engine)).collect();
    let expected: Vec<_> = (0..800).map(|block| (ticks_in(block), 2 * BAR)).collect();
    assert_eq!(played, expected);
    assert!(ticks_in(800) > BAR);
    // Shorter than where it plays: round in the new one.
    rig.write(&[set_transport(true, BAR)]);
    assert_eq!(looped(&mut rig.engine), (ticks_in(800) % BAR, BAR));
    // Stopped, it goes round in none.
    rig.write(&[set_transport(false, BAR)]);
    assert_eq!(looped(&mut rig.engine), (ticks_in(801) % BAR, 0));
}

#[test]
fn a_tempo_from_the_ring_changes_the_speed_from_its_block() {
    let mut rig = Rig::empty();
    rig.write(&[set_tempo(60.0), set_transport(true, BAR)]);
    // At 60 a tick is 50 frames.
    let expected: Vec<_> = (0..30)
        .map(|block| (1, u32::try_from(block * BLOCK_FRAMES / 50).unwrap()))
        .collect();
    assert_eq!(playheads(&mut rig.engine, 30), expected);
    assert_eq!(rig.engine.telemetry().tempo, 60.0);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn rejects_a_tempo_not_a_number_and_a_loop_of_no_ticks() {
    let mut rig = Rig::empty();
    rig.write(&[
        set_tempo(f32::NAN),
        set_transport(true, 0),
        set_transport(true, BAR),
    ]);
    assert_eq!(playheads(&mut rig.engine, 3), ticks_at(0..3));
    assert_eq!(
        events(&mut rig.engine),
        [
            rejected(0, Rejection::InvalidValue),
            rejected(0, Rejection::InvalidValue),
        ]
    );
}

#[test]
fn a_reset_leaves_the_transport_playing_on() {
    let mut rig = Rig::empty();
    rig.write(&[set_tempo(140.0), set_transport(true, BAR)]);
    playheads(&mut rig.engine, 10);
    rig.send(
        &[
            Spec::Reset(1),
            create_node(TONE, &tone::DESCRIPTION),
            Spec::SetOutput(TONE),
        ],
        &[set_transport(true, BAR)],
    );
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(rig.engine.telemetry().epoch, 1);
    // 140 quarter notes a minute: 20 4/7 frames a tick.
    let ticks = |blocks: usize| {
        u32::try_from(blocks * BLOCK_FRAMES * 140 * 960 / (60 * SAMPLE_RATE.get() as usize))
            .unwrap()
    };
    assert_eq!(rig.engine.telemetry().position, ticks(10));
    assert_eq!(playheads(&mut rig.engine, 1), [(1, ticks(11))]);
}

const STEP: u32 = TICKS_PER_QUARTER / 4;
const BAR_FRAMES: usize = BAR as usize * FRAMES_PER_TICK;

/// The handle of the pattern the tests play.
const PATTERN: u32 = 1;

/// A clip of the pattern from the loop's start that never ends: it plays the pattern as the loop goes round.
const WHOLE: [Placed; 1] = [(0, u32::MAX, u32::MAX, 0, PATTERN)];

/// The notes as the pattern, played by `WHOLE`.
fn heard(notes: &[Played]) -> [Spec<'_>; 2] {
    [Spec::SetPattern(PATTERN, notes), Spec::SetClips(&WHOLE)]
}

/// The sampler's kick at each tick, for a pattern.
fn kicks(ticks: &[u32]) -> Vec<Played> {
    ticks
        .iter()
        .map(|&tick| (tick, SAMPLER, 60, 1.0, 240))
        .collect()
}

/// A sampler playing the kick, heard on the output.
fn kick_sampler() -> Rig {
    let mut rig = Rig::empty();
    store(rig.builder.samples(), KICK, &[&kick()], 128).unwrap();
    rig.send(&[sampler_with_kick(SAMPLER), Spec::SetOutput(SAMPLER)], &[]);
    left(&mut rig.engine, FADE_BLOCKS);
    rig
}

/// Where a kick starts in `heard`, as frames from its start: each sounds for 500 frames.
fn onsets(heard: &[f32]) -> Vec<usize> {
    (0..heard.len())
        .filter(|&i| heard[i] != 0.0 && (i == 0 || heard[i - 1] == 0.0))
        .collect()
}

fn blocks_of(frames: usize) -> usize {
    frames.div_ceil(BLOCK_FRAMES)
}

#[test]
fn a_pattern_sent_with_play_sounds_from_its_block_each_note_at_its_frame_and_round_the_loop() {
    let mut rig = kick_sampler();
    let notes = kicks(&[5 * STEP, 0, 1000]);
    rig.send(&heard(&notes), &[set_transport(true, BAR)]);
    let heard = left(&mut rig.engine, blocks_of(2 * BAR_FRAMES));
    let pass = [
        0,
        1000 * FRAMES_PER_TICK,
        5 * STEP as usize * FRAMES_PER_TICK,
    ];
    let twice: Vec<_> = pass
        .iter()
        .chain(&pass.map(|frame| frame + BAR_FRAMES))
        .copied()
        .collect();
    assert_eq!(onsets(&heard), twice);
    assert_eq!(heard[..500], kick());
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn an_arrangement_plays_each_clip_s_pattern_from_its_tick_and_goes_round_at_its_end() {
    let mut rig = kick_sampler();
    let (first, second) = (kicks(&[0, 8 * STEP]), kicks(&[STEP]));
    let edits = [
        Spec::SetPattern(PATTERN, &first),
        Spec::SetPattern(2, &second),
        // The second pattern over the first one's second half, and on its own after it.
        Spec::SetClips(&[
            (0, BAR, BAR, 0, PATTERN),
            (BAR / 2, BAR, BAR, 0, 2),
            (BAR, BAR, BAR, 0, 2),
        ]),
    ];
    rig.send(&edits, &[set_transport(true, 2 * BAR)]);
    let heard = left(&mut rig.engine, blocks_of(3 * BAR_FRAMES));
    let frame = |tick: u32| tick as usize * FRAMES_PER_TICK;
    let pass = [
        frame(0),
        frame(8 * STEP),
        frame(BAR / 2 + STEP),
        frame(BAR + STEP),
    ];
    let round: Vec<_> = pass
        .iter()
        .chain(&pass.map(|at| at + 2 * BAR_FRAMES))
        .copied()
        .filter(|&at| at < heard.len())
        .collect();
    assert_eq!(onsets(&heard), round);
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn a_pattern_plays_nothing_while_the_transport_stands() {
    let mut rig = kick_sampler();
    rig.send(&heard(&kicks(&[0, STEP])), &[]);
    assert!(left(&mut rig.engine, 100).iter().all(|&heard| heard == 0.0));
    rig.write(&[set_transport(true, BAR)]);
    assert_eq!(onsets(&left(&mut rig.engine, 100)), [0, 6000]);
}

#[test]
fn a_note_switched_on_ahead_of_the_playhead_sounds_in_this_pass_and_one_behind_in_the_next() {
    let mut rig = kick_sampler();
    rig.send(&heard(&kicks(&[0])), &[set_transport(true, BAR)]);
    // Into tick 1024.
    let played = 200 * BLOCK_FRAMES;
    left(&mut rig.engine, 200);
    rig.send(
        &[Spec::SetPattern(PATTERN, &kicks(&[0, 2 * STEP, 10 * STEP]))],
        &[],
    );
    let heard = left(&mut rig.engine, blocks_of(2 * BAR_FRAMES - played));
    let frame = |tick: u32| tick as usize * FRAMES_PER_TICK - played;
    assert_eq!(
        onsets(&heard),
        [
            frame(10 * STEP),
            frame(BAR),
            frame(BAR + 2 * STEP),
            frame(BAR + 10 * STEP)
        ]
    );
}

#[test]
fn a_rebuild_while_playing_keeps_the_pattern_on_its_beat() {
    let mut rig = kick_sampler();
    let notes = kicks(&[0, 4 * STEP, 8 * STEP]);
    rig.send(&heard(&notes), &[set_transport(true, BAR)]);
    let played = 300 * BLOCK_FRAMES;
    left(&mut rig.engine, 300);
    // The cell's next generation, as the page's table hands it out after a reset.
    let again = handle(1, SAMPLER);
    let rebuilt: Vec<_> = notes
        .iter()
        .map(|&(tick, _, key, v, length)| (tick, again, key, v, length))
        .collect();
    rig.send(
        &[
            Spec::Reset(1),
            sampler_with_kick(again),
            Spec::SetOutput(again),
            Spec::SetPattern(handle(1, PATTERN), &rebuilt),
            Spec::SetClips(&[(0, u32::MAX, u32::MAX, 0, handle(1, PATTERN))]),
        ],
        &[set_transport(true, BAR)],
    );
    let heard = left(&mut rig.engine, blocks_of(BAR_FRAMES));
    let frame = |tick: u32| tick as usize * FRAMES_PER_TICK - played;
    assert_eq!(
        onsets(&heard),
        [frame(8 * STEP), frame(BAR), frame(BAR + 4 * STEP)]
    );
    assert_eq!(heard[frame(8 * STEP)..][..500], kick());
    assert_eq!(events(&mut rig.engine), []);
}

#[test]
fn notes_of_a_removed_node_reach_no_node_that_takes_its_cell_and_the_batch_is_told() {
    let mut rig = kick_sampler();
    rig.send(&heard(&kicks(&[STEP])), &[set_transport(true, BAR)]);
    let again = handle(1, SAMPLER);
    rig.send(
        &[
            Spec::DestroyNode(SAMPLER),
            sampler_with_kick(again),
            Spec::SetOutput(again),
        ],
        &[],
    );
    assert!(left(&mut rig.engine, 100).iter().all(|&heard| heard == 0.0));
    assert_eq!(
        events(&mut rig.engine),
        [edit_rejected(0, 3, Rejection::UnknownTarget)]
    );
}

#[test]
fn notes_past_a_node_s_room_are_counted_on_the_board_each_pass() {
    let mut rig = kick_sampler();
    let chord: Vec<_> = (0..=note_room())
        .map(|key| (0, SAMPLER, key, 1.0, 240))
        .collect();
    rig.send(&heard(&chord), &[set_transport(true, STEP)]);
    rig.engine.process(BLOCK_FRAMES);
    assert_eq!(rig.engine.telemetry().lost_notes, 1);
    left(&mut rig.engine, blocks_of(STEP as usize * FRAMES_PER_TICK));
    assert_eq!(rig.engine.telemetry().lost_notes, 2);
    assert_eq!(events(&mut rig.engine), []);
}

/// A synth heard on the output, once the output has risen.
fn synth_heard() -> Rig {
    let mut rig = Rig::empty();
    rig.send(
        &[
            create_node(SYNTH, &synth::DESCRIPTION),
            Spec::SetOutput(SYNTH),
        ],
        &[],
    );
    left(&mut rig.engine, FADE_BLOCKS);
    rig
}

/// The synth's default release, as long as the synth takes it.
fn release_frames() -> usize {
    let release = synth::ENVELOPE.release.entry(synth::DESCRIPTION.params);
    ramp_samples(release.expect("a synth lets go").default, SAMPLE_RATE) as usize
}

#[test]
fn a_note_outlives_its_pattern_and_falls_silent_after_its_end() {
    let mut rig = synth_heard();
    let a = [(0, SYNTH, 69, 1.0, STEP)];
    rig.send(&heard(&a), &[set_transport(true, BAR)]);
    assert!(peak(&mut rig.engine, 10) > 0.0);
    rig.send(&[Spec::SetPattern(PATTERN, &[])], &[]);
    let step = STEP as usize * FRAMES_PER_TICK;
    let rest = left(&mut rig.engine, blocks_of(step + release_frames()) - 10 + 1);
    // Held to its end, then falling silent.
    let end = step - 10 * BLOCK_FRAMES;
    assert!(loudest(&rest[end - 100..end]) > 0.15);
    assert_eq!(loudest(&rest[end + release_frames()..]), 0.0);
}

#[test]
fn stopping_lets_go_of_every_note_and_so_does_play_started_anew_at_once() {
    for restart in [
        &[set_transport(false, BAR)][..],
        &[set_transport(false, BAR), set_transport(true, BAR)],
    ] {
        let mut rig = synth_heard();
        let long = [
            (0, SYNTH, 69, 1.0, 100 * BAR),
            (0, SYNTH, 76, 1.0, 100 * BAR),
        ];
        rig.send(&heard(&long), &[set_transport(true, BAR)]);
        left(&mut rig.engine, 10);
        rig.send(&[Spec::SetPattern(PATTERN, &[])], restart);
        let rest = left(&mut rig.engine, blocks_of(release_frames()) + 1);
        assert!(loudest(&rest[..BLOCK_FRAMES]) > 0.0);
        assert_eq!(loudest(&rest[release_frames()..]), 0.0, "{}", restart.len());
    }
}

#[test]
fn of_two_notes_of_one_key_the_shorter_one_inside_the_longer_ends_alone() {
    let mut rig = synth_heard();
    // A loud note a beat long, and a quiet one of the same key inside it.
    let nested = [(0, SYNTH, 69, 1.0, 4 * STEP), (STEP, SYNTH, 69, 0.25, STEP)];
    rig.send(&heard(&nested), &[set_transport(true, BAR)]);
    let step = STEP as usize * FRAMES_PER_TICK;
    let beat = left(&mut rig.engine, blocks_of(4 * step));
    // Once the quiet one has ended and faded, the loud one sounds on alone, at its own level.
    let alone = 2 * step + release_frames();
    assert!(loudest(&beat[alone..4 * step - BLOCK_FRAMES]) > 0.15);
}

#[test]
fn a_node_s_notes_let_go_of_fall_silent_long_before_their_end() {
    let mut rig = synth_heard();
    let bar_long = [(0, SYNTH, 69, 1.0, BAR)];
    rig.send(&heard(&bar_long), &[set_transport(true, BAR)]);
    assert!(peak(&mut rig.engine, 10) > 0.15);
    // As a mute sends it, with its notes out of the pattern.
    rig.send(
        &[Spec::SetPattern(PATTERN, &[]), Spec::LetGoOfNotes(SYNTH)],
        &[],
    );
    let rest = left(&mut rig.engine, blocks_of(2 * release_frames()));
    assert!(loudest(&rest[..BLOCK_FRAMES]) > 0.0);
    assert_eq!(loudest(&rest[release_frames() + BLOCK_FRAMES..]), 0.0);
}
