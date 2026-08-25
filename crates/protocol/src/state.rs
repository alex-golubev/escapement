//! What the engine tells the interface, at frame rate.
//!
//! Not a queue. The engine writes every quantum, the interface reads every
//! frame, and the values in between were never wanted — a meter shows the level
//! now, not the levels that have been. So this is one cell holding the latest
//! value, guarded by a generation counter (a *seqlock*): the writer never waits,
//! which is the whole requirement on the audio thread, and the reader detects a
//! torn read and takes it again.
//!
//! Double buffering would not do here. It does not save a slow reader — two
//! frames on and the writer is back in the same buffer — so it wants three, for
//! a payload of a dozen words. Slice 2's project snapshot is the other way
//! round, and will get the other mechanism.

use crate::access::Cells;
use crate::{get_u64, put_u64};

/// The generation counter sits in front of the payload.
const SEQ_WORDS: usize = 1;

/// A read loses a race only if the writer runs between its two counter reads. At
/// one write per quantum against a read per frame that is already unlikely, and
/// four in a row is not a thing that happens — but the loop is bounded anyway,
/// because an unbounded spin on the interface thread is a hang.
const ATTEMPTS: usize = 4;

/// Everything the interface polls rather than is told.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EngineState {
    /// Samples the engine has produced since it started.
    ///
    /// Monotonic, and what [`Command::when`](crate::Command::when) is measured
    /// against — so it is the clock the interface schedules by, not a position
    /// on a timeline. A transport position joins this block when there is a
    /// timeline to have one; naming this one `playhead` would put two different
    /// numbers under one word.
    pub clock: u64,
    /// Callbacks the host has made.
    ///
    /// Read against the host's own clock (`AudioContext.currentTime`) it is how
    /// a dropout shows up: a missed callback stops both fields here while the
    /// host's clock carries on. In the worklet it is [`EngineState::clock`]
    /// divided by the render quantum; the offline render for export drives the
    /// same engine in blocks of its own choosing, and there the two part.
    pub quanta: u64,
    /// Peak of the last quantum, full scale.
    pub peak: f32,
    /// Whether the transport is running, as the engine sees it — which is what
    /// a button should follow, rather than what it was last told.
    pub playing: bool,
    /// Commands taken off the ring. The interface knows what it sent, so this
    /// is how far behind the engine is.
    pub commands_applied: u32,
    /// Commands this side did not recognise. Non-zero means the two halves have
    /// parted company — different builds behind one protocol version
    /// (ARCHITECTURE.md §3).
    pub commands_unknown: u32,
}

impl EngineState {
    /// Words on the wire. Eight, and the header carries it so that a half
    /// compiled against a different number is caught at the handshake.
    pub const WORDS: usize = 8;

    fn encode(&self, into: &mut [u32]) {
        put_u64(into, 0, self.clock);
        put_u64(into, 2, self.quanta);
        into[4] = self.peak.to_bits();
        into[5] = u32::from(self.playing);
        into[6] = self.commands_applied;
        into[7] = self.commands_unknown;
    }

    fn decode(from: &[u32]) -> Self {
        Self {
            clock: get_u64(from, 0),
            quanta: get_u64(from, 2),
            peak: f32::from_bits(from[4]),
            playing: from[5] != 0,
            commands_applied: from[6],
            commands_unknown: from[7],
        }
    }
}

/// Where the block sits inside the region, in words from its base.
///
/// Only the base: unlike a ring, which is generic over its slot, there is one
/// state block and it holds one [`EngineState`]. A size here would be a field
/// that could take exactly one value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockLayout {
    base: usize,
}

impl BlockLayout {
    /// `base` is the generation counter; the payload follows it.
    #[must_use]
    pub const fn new(base: usize) -> Self {
        Self { base }
    }

    /// First word of the block — the counter.
    #[must_use]
    pub const fn base(&self) -> usize {
        self.base
    }

    /// First word after the block.
    #[must_use]
    pub const fn end(&self) -> usize {
        self.base + SEQ_WORDS + EngineState::WORDS
    }

    const fn payload(&self) -> usize {
        self.base + SEQ_WORDS
    }
}

/// The writing half — the engine.
pub struct Publisher<C> {
    cells: C,
    layout: BlockLayout,
}

impl<C: Cells> Publisher<C> {
    /// `layout` must be the one the subscriber was built with.
    #[must_use]
    pub const fn new(cells: C, layout: BlockLayout) -> Self {
        Self { cells, layout }
    }

    /// Replaces the published state. Never waits, never allocates and cannot
    /// fail — which is the whole requirement on the audio thread. A reader that
    /// arrives mid-write retries; one that arrives between writes never learns
    /// that the values it skipped existed.
    pub fn publish(&mut self, state: &EngineState) {
        let seq = self.cells.load_relaxed(self.layout.base);

        // Odd: a read landing here now will retry rather than trust what it sees.
        self.cells
            .store_relaxed(self.layout.base, seq.wrapping_add(1));
        // Keeps that from being reordered after the payload it is meant to guard.
        self.cells.fence_release();

        let mut words = [0u32; EngineState::WORDS];
        state.encode(&mut words);
        self.cells.write_words(self.layout.payload(), &words);

        // Even again, and release: the payload above is visible behind it.
        self.cells
            .store_release(self.layout.base, seq.wrapping_add(2));
    }
}

/// The reading half — the interface, once a frame.
pub struct Subscriber<C> {
    cells: C,
    layout: BlockLayout,
}

impl<C: Cells> Subscriber<C> {
    /// See [`Publisher::new`]. Takes `&self` to read, so a second subscriber —
    /// another panel, another worker — costs nothing and needs no coordination.
    #[must_use]
    pub const fn new(cells: C, layout: BlockLayout) -> Self {
        Self { cells, layout }
    }

    /// `None` if the writer was in the way every time. Keep the previous frame's
    /// values; the next frame is 16 ms away.
    #[must_use]
    pub fn read(&self) -> Option<EngineState> {
        for _ in 0..ATTEMPTS {
            let before = self.cells.load_acquire(self.layout.base);
            if before & 1 != 0 {
                core::hint::spin_loop();
                continue;
            }

            let mut words = [0u32; EngineState::WORDS];
            self.cells.read_words(self.layout.payload(), &mut words);

            // Keeps the payload reads from being reordered after the check.
            self.cells.fence_acquire();
            if self.cells.load_relaxed(self.layout.base) == before {
                return Some(EngineState::decode(&words));
            }
        }
        None
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::thread;
    use std::time::Instant;

    use super::*;
    use crate::access::testing::Words;
    use crate::fixtures::{sample, STUCK};

    // Non-zero, so that `base + SEQ_WORDS` cannot be mistaken for either of
    // its halves.
    const LAYOUT: BlockLayout = BlockLayout::new(4);

    fn words() -> Words {
        Words::new(LAYOUT.end())
    }

    #[test]
    fn the_payload_sits_behind_the_counter() {
        assert_eq!(LAYOUT.payload(), LAYOUT.base() + SEQ_WORDS);
        assert_eq!(LAYOUT.end(), LAYOUT.payload() + EngineState::WORDS);
    }

    #[test]
    fn an_unwritten_block_reads_as_nothing_happened() {
        let words = words();
        let subscriber = Subscriber::new(&words, LAYOUT);
        assert_eq!(subscriber.read(), Some(EngineState::default()));
    }

    #[test]
    fn the_latest_value_is_what_comes_back() {
        let words = words();
        let mut publisher = Publisher::new(&words, LAYOUT);
        let subscriber = Subscriber::new(&words, LAYOUT);

        for n in 0..10 {
            publisher.publish(&sample(n));
        }
        assert_eq!(subscriber.read(), Some(sample(9)));
    }

    #[test]
    fn a_write_in_progress_is_not_read_as_a_value() {
        let words = words();
        let mut publisher = Publisher::new(&words, LAYOUT);
        publisher.publish(&sample(1));

        // What the block looks like with the writer halfway through it.
        words.store_relaxed(LAYOUT.base(), 1);

        assert_eq!(Subscriber::new(&words, LAYOUT).read(), None);
    }

    /// The fields of one published state are consistent with each other, and
    /// nothing but a torn read could break that.
    #[test]
    fn a_reader_never_sees_half_of_two_states() {
        const WRITES: u64 = if cfg!(miri) { 500 } else { 200_000 };

        let words = words();
        let done = AtomicBool::new(false);

        thread::scope(|scope| {
            scope.spawn(|| {
                let mut publisher = Publisher::new(&words, LAYOUT);
                for n in 1..=WRITES {
                    publisher.publish(&sample(n));
                }
                done.store(true, AtomicOrdering::Release);
            });

            let subscriber = Subscriber::new(&words, LAYOUT);
            let started = Instant::now();
            let mut seen = 0u64;
            while !done.load(AtomicOrdering::Acquire) {
                // A writer that died takes `done` with it, and without this the
                // reader would spin on it until some outer limit gave up.
                assert!(started.elapsed() < STUCK, "the writer never finished");
                if let Some(state) = subscriber.read() {
                    assert_eq!(state, sample(state.quanta), "torn read");
                    assert!(state.quanta >= seen, "went backwards");
                    seen = state.quanta;
                }
            }
            assert!(seen > 0, "the reader never got a look in");
        });
    }
}
