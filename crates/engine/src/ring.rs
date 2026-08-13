//! Parsing the block of commands the worklet copied out of the SAB.
//!
//! The ring itself lives in a `SharedArrayBuffer` and is invisible to the
//! engine. At the top of each quantum the worklet drains whatever is
//! available, copies those bytes into WASM linear memory and passes the record
//! count to `engine_process`. This module is what happens to them next:
//! decoding, and placing them on frames within the quantum.
//!
//! The input is untrusted end to end. Another thread writes the bytes, the
//! record count comes from there too, and the only synchronization between
//! writer and reader is a pair of atomic indices — so any value here may turn
//! out to be garbage. No function in this module may panic: under
//! `panic = "abort"` a panic kills the whole worklet, and sound is gone until
//! the page is reloaded.

use crate::commands::{COMMAND_SIZE, Record};

/// How many records the engine accepts per quantum.
///
/// This is the size of the exchange area in WASM linear memory, not the size
/// of the ring in the SAB (1024 records there). Per quantum the worklet
/// copies no more than this; the remainder waits for the next quantum — 128
/// frames later, i.e. under 3 ms. `engine_cmd_capacity` returns this value.
pub const CMD_CAPACITY: usize = 256;

/// A decoded command together with where it applies inside the quantum.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entry {
    pub record: Record,
    /// The frame within the quantum at which the command must be applied.
    ///
    /// `None` means the instant is not in this quantum. It reads like "later"
    /// and means nothing of the sort: nothing downstream keeps a record across
    /// quanta, so the engine drops it. That decision, and what would have to be
    /// settled before it could change, is at that branch in `Engine::process`.
    pub offset: Option<u32>,
}

/// A block of records sitting in the exchange area.
#[derive(Debug, Clone, Copy)]
pub struct CommandBlock<'a> {
    bytes: &'a [u8],
    count: usize,
}

impl<'a> CommandBlock<'a> {
    /// `count` is however many records the worklet claimed. The value is
    /// untrusted, so it is clamped to the actual slice length.
    ///
    /// **The clamp bounds a loop, and only incidentally a read.** [`entry`] is
    /// already total — it answers `None` past the end of the slice — so an
    /// unclamped claim reads nothing it should not. What it does instead is
    /// make `Engine::process` walk to the number claimed regardless, one index
    /// at a time, because that is how the engine learns there is nothing there.
    /// A claim of `u32::MAX` is four billion laps inside one quantum on the one
    /// thread that must return in under three milliseconds. The symptom is not
    /// a wrong sample; it is a render thread that never comes back — measured
    /// by taking this `min` out, at which point the suite stops responding
    /// rather than failing.
    ///
    /// [`entry`]: Self::entry
    pub fn new(bytes: &'a [u8], count: u32) -> Self {
        let available = bytes.len() / COMMAND_SIZE;
        Self { bytes, count: (count as usize).min(available) }
    }

    /// Number of records in the block before decoding. Unrecognized ones
    /// count too.
    pub fn len(&self) -> usize {
        self.count
    }

    /// Here because `clippy::len_without_is_empty` requires it of any public
    /// `len`, not because the engine asks: it reads `len` and indexes. Worth
    /// saying, since the surrounding rule is that a method with only tests
    /// behind it comes out.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// A record by index, with its frame of application computed.
    ///
    /// `None` means either past the end of the block or an unrecognized
    /// record — to the engine these are the same case: it simply moves to the
    /// next index, and knows the bound from [`len`](Self::len).
    ///
    /// **By index and not by iterator, and there is no iterator beside it.**
    /// Rendering proceeds in segments between commands, so the engine mutates
    /// its own state between one record and the next and cannot hold a borrow
    /// of the block across that. An iterator would therefore have no caller but
    /// the tests here — a second way through the same bytes, staying green
    /// while the one that ships broke.
    pub fn entry(&self, index: usize, quantum_start: u64, frames: u32) -> Option<Entry> {
        if index >= self.count {
            return None;
        }
        let start = index * COMMAND_SIZE;
        let bytes: &[u8; COMMAND_SIZE] =
            self.bytes.get(start..start + COMMAND_SIZE)?.try_into().ok()?;
        let record = Record::decode(bytes)?;
        Some(Entry {
            record,
            offset: offset_in_quantum(record.at_sample, quantum_start, frames),
        })
    }

}

/// The frame of the quantum that the instant `at_sample` falls on, or `None`
/// when the instant lies past the end of it.
///
/// **An instant behind the quantum and one ahead of it are not answered alike,
/// and that asymmetry is the whole of what this function decides.** Late is
/// answered with the first frame, so the command still happens. Early is
/// answered with nothing.
///
/// What makes that the right way round is that the two errors are bounded
/// differently. A late command applied at the top of the quantum is wrong by
/// less than a quantum — a fraction of a millisecond, inaudible — while losing
/// it is not bounded at all: a `Stop` that never arrives leaves the transport
/// running forever. Being late is reachable, too, and not by anything exotic:
/// the UI stamps a deadline off a telemetry reading that is already a frame or
/// two old.
///
/// Early has no such ceiling in either direction, which is why it is reported
/// rather than clamped. Pulling an instant stamped an hour ahead back to the
/// end of this quantum would fire it an hour early — worse than not firing it —
/// so the answer is left to the caller. `Engine::process` is where `None`
/// becomes a decision.
pub fn offset_in_quantum(at_sample: u64, quantum_start: u64, frames: u32) -> Option<u32> {
    if at_sample <= quantum_start {
        // Zero is the protocol's "immediately", and lands here by being at or
        // behind every possible quantum start.
        return Some(0);
    }

    let delta = at_sample - quantum_start;
    if delta < u64::from(frames) {
        // delta < frames <= u32::MAX, so the narrowing loses nothing.
        Some(delta as u32)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::Command;

    const FRAMES: u32 = 128;

    fn block_of(records: &[Record]) -> Vec<u8> {
        records.iter().flat_map(|r| r.encode()).collect()
    }

    /// Every entry in the block, walked exactly the way `Engine::process`
    /// walks it — by index, through [`CommandBlock::entry`].
    ///
    /// A helper here rather than a method on the block, for the reason `entry`
    /// gives: nothing that ships wants the whole block at once, so an iterator
    /// on the type would be a second path through the same bytes with only
    /// these tests behind it. Records the engine skips are skipped here, since
    /// what it does with them is to move to the next index.
    fn entries(block: &CommandBlock, quantum_start: u64, frames: u32) -> Vec<Entry> {
        (0..block.len())
            .filter_map(|index| block.entry(index, quantum_start, frames))
            .collect()
    }

    /// The single entry a one-record block decodes to.
    fn only_entry(bytes: &[u8], quantum_start: u64, frames: u32) -> Entry {
        let block = CommandBlock::new(bytes, 1);
        let found = entries(&block, quantum_start, frames);
        assert_eq!(found.len(), 1, "the record went missing");
        found[0]
    }

    fn commands_of(entries: &[Entry]) -> Vec<Command> {
        entries.iter().map(|e| e.record.command).collect()
    }

    #[test]
    fn empty_block_yields_nothing() {
        let bytes = block_of(&[Record::immediate(Command::Play)]);

        let block = CommandBlock::new(&bytes, 0);
        assert!(block.is_empty());
        assert_eq!(entries(&block, 0, FRAMES).len(), 0, "count=0 must hide the bytes");

        let empty = CommandBlock::new(&[], 0);
        assert_eq!(entries(&empty, 0, FRAMES).len(), 0);
    }

    #[test]
    fn count_is_clamped_to_slice() {
        // The record count comes from another thread and can be anything.
        let bytes = block_of(&[
            Record::immediate(Command::Play),
            Record::immediate(Command::Stop),
        ]);
        for claimed in [2, 3, 1_000, u32::MAX] {
            let block = CommandBlock::new(&bytes, claimed);
            assert_eq!(block.len(), 2, "a claim of {claimed} records ran past the slice");
            assert_eq!(entries(&block, 0, FRAMES).len(), 2);
        }
    }

    #[test]
    fn partial_trailing_bytes_are_ignored() {
        let mut bytes = block_of(&[
            Record::immediate(Command::Play),
            Record::immediate(Command::Stop),
        ]);
        bytes.truncate(COMMAND_SIZE + 7); // one and a half records

        let block = CommandBlock::new(&bytes, 2);
        assert_eq!(block.len(), 1, "a partial record is not a record");
        assert_eq!(commands_of(&entries(&block, 0, FRAMES)), vec![Command::Play]);
    }

    #[test]
    fn preserves_submission_order() {
        let sent = [
            Record::immediate(Command::SetBpm { bpm: 90.0 }),
            Record::immediate(Command::Play),
            Record::immediate(Command::SetBpm { bpm: 174.0 }),
            Record::immediate(Command::Stop),
        ];
        let bytes = block_of(&sent);

        assert_eq!(
            commands_of(&entries(&CommandBlock::new(&bytes, 4), 0, FRAMES)),
            sent.iter().map(|r| r.command).collect::<Vec<_>>()
        );
    }

    #[test]
    fn skips_empty_and_unknown_records_without_losing_neighbors() {
        let mut bytes = block_of(&[
            Record::immediate(Command::Play),
            Record::immediate(Command::Stop), // will be zeroed
            Record::immediate(Command::Stop), // will get an unknown opcode
            Record::immediate(Command::SetBpm { bpm: 140.0 }),
        ]);
        bytes[COMMAND_SIZE..2 * COMMAND_SIZE].fill(0);
        bytes[2 * COMMAND_SIZE] = 200;

        assert_eq!(
            commands_of(&entries(&CommandBlock::new(&bytes, 4), 0, FRAMES)),
            vec![Command::Play, Command::SetBpm { bpm: 140.0 }],
            "a corrupt record must not drag its neighbors down with it"
        );
    }

    #[test]
    fn immediate_commands_land_on_the_first_frame() {
        let bytes = block_of(&[Record::immediate(Command::Play)]);
        // A quantum far from zero — "immediately" must not depend on position.
        assert_eq!(only_entry(&bytes, 9_999_999, FRAMES).offset, Some(0));
    }

    #[test]
    fn late_commands_are_applied_not_dropped() {
        for at_sample in [1, 100, 9_999] {
            let record = Record { command: Command::Stop, at_sample };
            let bytes = block_of(&[record]);
            assert_eq!(only_entry(&bytes, 10_000, FRAMES).offset, Some(0), "at_sample={at_sample}");
        }
    }

    #[test]
    fn scheduled_command_lands_on_its_frame() {
        let start = 48_000u64;
        for offset in [0u32, 1, 63, FRAMES - 1] {
            let record = Record {
                command: Command::Play,
                at_sample: start + u64::from(offset),
            };
            let bytes = block_of(&[record]);
            assert_eq!(only_entry(&bytes, start, FRAMES).offset, Some(offset));
        }
    }

    #[test]
    fn command_past_the_quantum_has_no_frame_in_it() {
        // Named for what it observes rather than for what one would like to
        // follow from it. This module reports that the instant is not in this
        // quantum; it does not hold the record for a later one, and neither
        // does anything downstream — `Engine::process` drops it, which is
        // pinned there. "Deferred" was the old name and claimed the opposite.
        let start = 48_000u64;
        // The first frame of the next quantum is already not ours — otherwise
        // the command would fire twice: now, and in the quantum it belongs to.
        for ahead in [0u64, 1, 128, 48_000] {
            let record = Record {
                command: Command::Play,
                at_sample: start + u64::from(FRAMES) + ahead,
            };
            let bytes = block_of(&[record]);
            assert_eq!(only_entry(&bytes, start, FRAMES).offset, None, "ahead={ahead}");
        }
    }

    #[test]
    fn every_sample_of_the_quantum_is_covered_exactly_once() {
        let start = 1_000_000u64;
        for offset in 0..FRAMES {
            let at = start + u64::from(offset);
            assert_eq!(offset_in_quantum(at, start, FRAMES), Some(offset));
            assert_eq!(
                offset_in_quantum(at, start + u64::from(FRAMES), FRAMES),
                Some(0),
                "for the next quantum, position {at} is already in the past"
            );
        }
    }

    #[test]
    fn offset_is_correct_across_the_2_pow_32_boundary() {
        // Position is u64 but travels the wire as two u32 words. A mistake in
        // reassembling them surfaces a day into a session.
        let start = (1u64 << 32) - 64;
        for offset in 0..FRAMES {
            let at = start + u64::from(offset);
            let record = Record { command: Command::Play, at_sample: at };
            let bytes = block_of(&[record]);
            assert_eq!(only_entry(&bytes, start, FRAMES).offset, Some(offset), "at_sample={at}");
        }
    }

    #[test]
    fn extreme_positions_do_not_overflow() {
        assert_eq!(offset_in_quantum(u64::MAX, 0, FRAMES), None);
        assert_eq!(offset_in_quantum(0, u64::MAX, FRAMES), Some(0));
        assert_eq!(offset_in_quantum(u64::MAX, u64::MAX, FRAMES), Some(0));
        assert_eq!(offset_in_quantum(u64::MAX, u64::MAX - 1, FRAMES), Some(1));
    }

    #[test]
    fn offset_never_exceeds_the_quantum() {
        let start = 777u64;
        for at_sample in 0..4_000u64 {
            if let Some(offset) = offset_in_quantum(at_sample, start, FRAMES) {
                assert!(offset < FRAMES, "offset {offset} is outside the quantum");
            }
        }
    }

    #[test]
    fn empty_quantum_still_applies_pending_commands() {
        // The engine never asks for frames = 0, but decoding must stay
        // meaningful: place an immediate command on the first frame, and
        // report a future one as having no frame here.
        assert_eq!(offset_in_quantum(0, 500, 0), Some(0));
        assert_eq!(offset_in_quantum(500, 500, 0), Some(0));
        assert_eq!(offset_in_quantum(501, 500, 0), None);
    }

    #[test]
    fn arbitrary_bytes_never_panic() {
        // The contents of the exchange area are whatever another thread wrote
        // there. Decoding must be total on any input.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut bytes = vec![0u8; CMD_CAPACITY * COMMAND_SIZE];
        for _ in 0..200 {
            for byte in bytes.iter_mut() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *byte = state as u8;
            }
            let block = CommandBlock::new(&bytes, u32::MAX);
            for entry in entries(&block, state, FRAMES) {
                if let Some(offset) = entry.offset {
                    assert!(offset < FRAMES);
                }
            }
        }
    }

    #[test]
    fn capacity_matches_the_exchange_area() {
        // The exchange area in WASM linear memory is sized for this many
        // records; a mismatch means reading past its end.
        assert_eq!(CMD_CAPACITY, 256);
        assert_eq!(CMD_CAPACITY * COMMAND_SIZE, 4096);
    }
}
