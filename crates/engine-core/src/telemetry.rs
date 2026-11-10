//! What the engine reports after every block.

use std::{array, mem};

use crate::handle::NodeHandle;
use crate::{BLOCK_FRAMES, CHANNELS};

/// The board's layout word by word, mirrored in `packages/engine/src/telemetry.ts`.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Telemetry {
    /// Wraps around after about four months at 48 kHz.
    pub blocks: u32,
    pub epoch: u32,
    /// Events that found no room on the way to the page.
    pub lost_events: u32,
    /// Notes of the pattern that found no room: in the block's budget, or in their node's block.
    pub lost_notes: u32,
    /// By the thread that runs the blocks, since it started; on the audio thread it must stay 0.
    pub heap_calls: u32,
    /// Peak meter level per channel, 1 is full scale.
    pub peaks: [f32; CHANNELS],
    /// 1 while the transport plays, else 0.
    pub playing: u32,
    /// Whole ticks from the loop's start at the last block's start: where it plays, or where it stands stopped.
    pub position: u32,
    /// The loop's ticks at the last block's start, the length the position goes round in; 0 while stopped.
    pub loop_ticks: u32,
    /// Quarter notes a minute in the last block.
    pub tempo: f32,
    /// 1 once the commands' bounds are lost and the engine takes no more of them; said every block, as the one event
    /// about it may find no room.
    pub stream_lost: u32,
    /// Blocks that went over full scale per channel, wrapping: however briefly it went over, and however seldom the
    /// page looks, the count has moved.
    pub overs: [u32; CHANNELS],
    /// How many of `meters` hold a meter now, from the first: the worklet copies only those.
    pub meters_used: u32,
    /// A record for each node the page gave a meter, as many as there is room for, in no order: each says whose it is.
    pub meters: [MeterRecord; METERS],
}

impl Default for Telemetry {
    fn default() -> Self {
        Self {
            blocks: 0,
            epoch: 0,
            lost_events: 0,
            lost_notes: 0,
            heap_calls: 0,
            peaks: [0.0; CHANNELS],
            playing: 0,
            position: 0,
            loop_ticks: 0,
            tempo: 0.0,
            stream_lost: 0,
            overs: [0; CHANNELS],
            meters_used: 0,
            meters: [MeterRecord::default(); METERS],
        }
    }
}

/// The meters the board has room for: past them, a node's meter isn't reported.
pub const METERS: usize = 500;

/// A node's meter on the board: its handle, its level, and its blocks over full scale per channel since it was made.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MeterRecord {
    pub node: u32,
    pub peaks: [f32; CHANNELS],
    pub overs: [u32; CHANNELS],
}

pub const TELEMETRY_WORDS: usize = size_of::<Telemetry>() / 4;

// The usual fall of digital peak meters: 20 dB in 1.7 s.
const FALL_DB: f32 = 20.0;
const FALL_SECONDS: f32 = 1.7;
/// −120 dB. Without a floor the level would never reach zero.
const SILENCE: f32 = 1e-6;

/// Rises at once, falls slowly: a page that looks only now and then still sees short peaks. Counts the blocks that go
/// over full scale, which the falling level can't tell, until whoever keeps the count takes them.
pub struct PeakMeter {
    level: f32,
    fall_per_sample: f32,
    overs: u32,
}

impl PeakMeter {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            level: 0.0,
            fall_per_sample: 10f32.powf(-FALL_DB / 20.0 / (FALL_SECONDS * sample_rate)),
            overs: 0,
        }
    }

    /// Returns the level after `block`, at most [`BLOCK_FRAMES`] long.
    pub fn update(&mut self, block: &[f32]) -> f32 {
        debug_assert!(block.len() <= BLOCK_FRAMES);
        let peak = block
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        self.overs = self.overs.wrapping_add((peak > 1.0).into());
        let fallen = self.level * self.fall_per_sample.powi(block.len() as i32);
        self.level = match peak.max(fallen) {
            level if level < SILENCE => 0.0,
            level => level,
        };
        self.level
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    /// Blocks over full scale since last taken.
    pub fn take_overs(&mut self) -> u32 {
        mem::take(&mut self.overs)
    }
}

/// A meter per channel of a block, as the master's output has and a node's meter.
pub struct BlockMeter([PeakMeter; CHANNELS]);

impl BlockMeter {
    pub fn new(sample_rate: f32) -> Self {
        Self(array::from_fn(|_| PeakMeter::new(sample_rate)))
    }

    pub fn update(&mut self, block: &[[f32; BLOCK_FRAMES]; CHANNELS], frames: usize) {
        for (side, channel) in self.0.iter_mut().zip(block) {
            side.update(&channel[..frames]);
        }
    }

    pub fn levels(&self) -> [f32; CHANNELS] {
        self.0.each_ref().map(PeakMeter::level)
    }

    /// Adds the blocks over full scale since the last time to `overs`, wrapping.
    pub fn count_overs(&mut self, overs: &mut [u32; CHANNELS]) {
        for (count, side) in overs.iter_mut().zip(&mut self.0) {
            *count = count.wrapping_add(side.take_overs());
        }
    }
}

/// A node's meter: of what the node passes on, named by the node's handle.
pub struct NodeMeter {
    node: NodeHandle,
    meter: BlockMeter,
    overs: [u32; CHANNELS],
}

impl NodeMeter {
    pub(crate) fn new(node: NodeHandle, sample_rate: f32) -> Self {
        Self {
            node,
            meter: BlockMeter::new(sample_rate),
            overs: [0; CHANNELS],
        }
    }

    pub fn update(&mut self, block: &[[f32; BLOCK_FRAMES]; CHANNELS], frames: usize) {
        self.meter.update(block, frames);
    }

    /// Writes its record into the board's next place, if there is one left, and counts it in.
    pub fn report(&mut self, telemetry: &mut Telemetry) {
        let Some(record) = telemetry.meters.get_mut(telemetry.meters_used as usize) else {
            return;
        };
        self.meter.count_overs(&mut self.overs);
        *record = MeterRecord {
            node: self.node.raw(),
            peaks: self.meter.levels(),
            overs: self.overs,
        };
        telemetry.meters_used += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::SAMPLE_RATE;

    #[test]
    fn is_a_whole_number_of_words() {
        assert_eq!(size_of::<Telemetry>() % 4, 0);
        assert_eq!(size_of::<MeterRecord>(), 4 * (1 + 2 * CHANNELS));
        assert_eq!(
            TELEMETRY_WORDS,
            11 + 2 * CHANNELS + METERS * (1 + 2 * CHANNELS)
        );
    }

    #[test]
    fn rises_at_once() {
        let mut meter = PeakMeter::new(SAMPLE_RATE);
        let mut block = [0.0; BLOCK_FRAMES];
        block[100] = -0.5;
        assert_eq!(meter.update(&block), 0.5);
    }

    #[test]
    fn falls_20_db_in_1_7_seconds() {
        let mut meter = PeakMeter::new(SAMPLE_RATE);
        let mut block = [0.0; BLOCK_FRAMES];
        block[BLOCK_FRAMES - 1] = 1.0;
        meter.update(&block);
        let silence = [0.0; BLOCK_FRAMES];
        let blocks = (FALL_SECONDS * SAMPLE_RATE / BLOCK_FRAMES as f32).round() as usize;
        let level = (0..blocks).fold(1.0, |_, _| meter.update(&silence));
        let db = 20.0 * level.log10();
        assert!((db + FALL_DB).abs() < 0.1, "{db} dB after {FALL_SECONDS} s");
    }

    #[test]
    fn falls_to_exactly_zero() {
        let mut meter = PeakMeter::new(SAMPLE_RATE);
        meter.update(&[1.0; BLOCK_FRAMES]);
        // 120 dB at 20 dB per 1.7 s takes about 10 s.
        let blocks = (11.0 * SAMPLE_RATE / BLOCK_FRAMES as f32) as usize;
        let level = (0..blocks).fold(1.0, |_, _| meter.update(&[0.0; BLOCK_FRAMES]));
        assert_eq!(level, 0.0);
    }

    #[test]
    fn counts_the_blocks_over_full_scale() {
        let mut meter = PeakMeter::new(SAMPLE_RATE);
        let mut block = [0.0; BLOCK_FRAMES];
        block[7] = -1.0;
        meter.update(&block);
        assert_eq!(meter.take_overs(), 0);
        block[7] = -1.02;
        meter.update(&block);
        meter.update(&block);
        meter.update(&[0.0; BLOCK_FRAMES]);
        assert_eq!(meter.take_overs(), 2);
        assert_eq!(meter.take_overs(), 0);
    }

    /// A block's records: `meters`, in their order.
    fn report_all(meters: &mut [&mut NodeMeter], telemetry: &mut Telemetry) {
        telemetry.meters_used = 0;
        for meter in meters {
            meter.report(telemetry);
        }
    }

    /// A block of `peak` on the left and silence on the right.
    fn left_at(peak: f32) -> [[f32; BLOCK_FRAMES]; CHANNELS] {
        let mut block = [[0.0; BLOCK_FRAMES]; CHANNELS];
        block[0][3] = peak;
        block
    }

    #[test]
    fn a_record_names_its_node_and_counts_from_the_node_s_making() {
        let mut telemetry = Telemetry::default();
        let meter = |raw| NodeMeter::new(NodeHandle::new(raw), SAMPLE_RATE);
        let (mut three, mut seven) = (meter(3), meter(1 << 16 | 7));
        three.update(&left_at(0.5), BLOCK_FRAMES);
        seven.update(&left_at(1.5), BLOCK_FRAMES);
        seven.update(&left_at(1.5), BLOCK_FRAMES);
        report_all(&mut [&mut three, &mut seven], &mut telemetry);
        assert_eq!(telemetry.meters_used, 2);
        assert_eq!(
            telemetry.meters[..2],
            [
                MeterRecord {
                    node: 3,
                    peaks: [0.5, 0.0],
                    overs: [0, 0]
                },
                MeterRecord {
                    node: 1 << 16 | 7,
                    peaks: [1.5, 0.0],
                    overs: [2, 0]
                }
            ]
        );
        // Reported again with no block between, it counts nothing twice.
        report_all(&mut [&mut seven], &mut telemetry);
        assert_eq!(telemetry.meters[0].overs, [2, 0]);
        // A node made anew in the cell is another node: its count starts again.
        let mut anew = meter(2 << 16 | 7);
        anew.update(&left_at(1.2), BLOCK_FRAMES);
        report_all(&mut [&mut anew], &mut telemetry);
        assert_eq!(telemetry.meters_used, 1);
        assert_eq!(
            telemetry.meters[0],
            MeterRecord {
                node: 2 << 16 | 7,
                peaks: [1.2, 0.0],
                overs: [1, 0]
            }
        );
    }

    #[test]
    fn meters_past_the_board_s_room_are_not_reported() {
        let mut telemetry = Telemetry::default();
        let mut meters: Vec<_> = (1..=METERS as u32 + 1)
            .map(|cell| NodeMeter::new(NodeHandle::new(cell), SAMPLE_RATE))
            .collect();
        report_all(&mut meters.iter_mut().collect::<Vec<_>>(), &mut telemetry);
        assert_eq!(telemetry.meters_used, METERS as u32);
        assert_eq!(telemetry.meters[METERS - 1].node, METERS as u32);
    }

    #[test]
    fn a_short_peak_is_still_visible_several_blocks_later() {
        let mut meter = PeakMeter::new(SAMPLE_RATE);
        let mut hit = [0.0; BLOCK_FRAMES];
        hit[0] = 0.8;
        meter.update(&hit);
        // A 60 Hz page looks about every six blocks.
        let level = (0..6).fold(0.0, |_, _| meter.update(&[0.0; BLOCK_FRAMES]));
        let fallen_db = 20.0 * (0.8 / level).log10();
        assert!(fallen_db < 0.25, "fell {fallen_db} dB");
    }
}
