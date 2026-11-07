//! What the engine reports after every block.

use std::{array, mem};

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
    /// Whole ticks from the loop's start at the last block's start; 0 while stopped.
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
    /// A record for each node the page gave a meter, in no order: each says whose it is.
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

/// Meters the page can give nodes, numbered from 1, as it numbers its mixer's strips.
pub const METERS: usize = 500;

/// A node's meter on the board: its number, then its level and its count of blocks over full scale per channel, as
/// the master's. The count is kept by the number, so a node made anew for it counts on.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MeterRecord {
    pub meter: u32,
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

/// A node's meter: of what the node passes on, under the number the page gave it.
pub struct NodeMeter {
    /// The number's place in [`MeterOvers`], under [`METERS`].
    index: usize,
    meter: BlockMeter,
}

impl NodeMeter {
    /// None for a number past 1 to [`METERS`].
    pub fn new(number: u32, sample_rate: f32) -> Option<Self> {
        let index = (number as usize)
            .checked_sub(1)
            .filter(|&index| index < METERS)?;
        Some(Self {
            index,
            meter: BlockMeter::new(sample_rate),
        })
    }

    pub fn number(&self) -> u32 {
        self.index as u32 + 1
    }

    pub fn update(&mut self, block: &[[f32; BLOCK_FRAMES]; CHANNELS], frames: usize) {
        self.meter.update(block, frames);
    }
}

/// The count of blocks over full scale for each meter's number, wherever on the board its record lands.
pub struct MeterOvers([[u32; CHANNELS]; METERS]);

impl Default for MeterOvers {
    fn default() -> Self {
        Self([[0; CHANNELS]; METERS])
    }
}

impl MeterOvers {
    /// Writes `node`'s record into the board's next place, if there is one left, and counts it in.
    pub fn report(&mut self, node: &mut NodeMeter, telemetry: &mut Telemetry) {
        let Some(record) = telemetry.meters.get_mut(telemetry.meters_used as usize) else {
            return;
        };
        let overs = &mut self.0[node.index];
        node.meter.count_overs(overs);
        *record = MeterRecord {
            meter: node.number(),
            peaks: node.meter.levels(),
            overs: *overs,
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
    fn report_all(
        overs: &mut MeterOvers,
        meters: &mut [&mut NodeMeter],
        telemetry: &mut Telemetry,
    ) {
        telemetry.meters_used = 0;
        for meter in meters {
            overs.report(meter, telemetry);
        }
    }

    /// A block of `peak` on the left and silence on the right.
    fn left_at(peak: f32) -> [[f32; BLOCK_FRAMES]; CHANNELS] {
        let mut block = [[0.0; BLOCK_FRAMES]; CHANNELS];
        block[0][3] = peak;
        block
    }

    #[test]
    fn a_meter_s_count_goes_on_by_its_number_whatever_node_and_record_it_has() {
        let mut overs = MeterOvers::default();
        let mut telemetry = Telemetry::default();
        let meter = |number| NodeMeter::new(number, SAMPLE_RATE).unwrap();
        let (mut three, mut seven) = (meter(3), meter(7));
        three.update(&left_at(0.5), BLOCK_FRAMES);
        seven.update(&left_at(1.5), BLOCK_FRAMES);
        seven.update(&left_at(1.5), BLOCK_FRAMES);
        report_all(&mut overs, &mut [&mut three, &mut seven], &mut telemetry);
        assert_eq!(telemetry.meters_used, 2);
        assert_eq!(
            telemetry.meters[..2],
            [
                MeterRecord {
                    meter: 3,
                    peaks: [0.5, 0.0],
                    overs: [0, 0]
                },
                MeterRecord {
                    meter: 7,
                    peaks: [1.5, 0.0],
                    overs: [2, 0]
                }
            ]
        );
        // Reported again with no block between, it counts nothing twice.
        report_all(&mut overs, &mut [&mut seven], &mut telemetry);
        assert_eq!(telemetry.meters[0].overs, [2, 0]);
        // A node made anew for 7, its record first now: its count goes on.
        let mut anew = meter(7);
        anew.update(&left_at(1.2), BLOCK_FRAMES);
        report_all(&mut overs, &mut [&mut anew], &mut telemetry);
        assert_eq!(telemetry.meters_used, 1);
        assert_eq!(
            telemetry.meters[0],
            MeterRecord {
                meter: 7,
                peaks: [1.2, 0.0],
                overs: [3, 0]
            }
        );
    }

    #[test]
    fn a_meter_is_numbered_from_1_to_the_last() {
        let numbers = [0, 1, METERS as u32, METERS as u32 + 1, u32::MAX];
        let made =
            numbers.map(|number| NodeMeter::new(number, SAMPLE_RATE).map(|meter| meter.number()));
        assert_eq!(made, [None, Some(1), Some(METERS as u32), None, None]);
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
