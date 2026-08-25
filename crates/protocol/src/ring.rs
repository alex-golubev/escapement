//! A queue in shared memory: one producer, one consumer, no locks.
//!
//! Carries control and never data (§3), and [`MAX_SLOT_WORDS`] is that rule
//! made checkable.
//!
//! Traffic is tens of items per second in bursts, not thousands, so the usual
//! tricks for a hot ring — caching the far index, batching the publishing — would
//! buy nothing and cost an invariant to reason about.

use core::fmt;
use core::marker::PhantomData;

use crate::access::Cells;

/// A slot holds control, so it stays small. Raising this is not a tuning knob:
/// it means something is traveling through the ring that should not be.
pub const MAX_SLOT_WORDS: usize = 8;

/// A ring holds about a frame's worth of control, never a backlog. The ceiling
/// is also what keeps a capacity read out of shared memory from overflowing the
/// arithmetic that sizes the region — `usize` is 32 bits on the target.
pub const MAX_CAPACITY: u32 = 1 << 16;

// Head and tail are written by different threads and so are kept a cache line
// apart: sharing one line has each side invalidating the other's cache for
// nothing. Slots start on the line after, which also leaves room for another
// counter without moving them.
const HEAD: usize = 0;
const TAIL: usize = 16;
const SLOTS: usize = 32;

/// Something that fits in a slot.
///
/// Decoding is total on purpose. A value this side does not recognize is a
/// value, not an error: the alternative is a fallible path on the audio thread,
/// where the only honest thing to do with an error is nothing.
pub trait Slot: Sized {
    /// Must not exceed [`MAX_SLOT_WORDS`].
    const WORDS: usize;

    /// `into` is exactly [`Slot::WORDS`] long.
    fn encode(&self, into: &mut [u32]);

    /// `from` is exactly [`Slot::WORDS`] long.
    fn decode(from: &[u32]) -> Self;
}

/// Where one ring sits inside the region, in words from its base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingLayout {
    base: usize,
    capacity: u32,
    slot_words: usize,
}

impl RingLayout {
    /// `capacity` is in slots and must be a power of two — the mask that turns a
    /// counter into an index is what keeps that index provably inside the ring,
    /// which is what keeps a panic off the audio thread.
    ///
    /// # Panics
    ///
    /// If `capacity` is not a power of two or is above [`MAX_CAPACITY`], or the
    /// slot is above [`MAX_SLOT_WORDS`]. Called in a `const` context, as the
    /// owning side does, all three are compile errors; the side that reads these
    /// values out of shared memory must check them first, and does
    /// ([`Layout::read_header`](crate::Layout::read_header)).
    #[must_use]
    pub const fn new(base: usize, capacity: u32, slot_words: usize) -> Self {
        assert!(
            capacity.is_power_of_two(),
            "capacity must be a power of two"
        );
        assert!(slot_words <= MAX_SLOT_WORDS, "slot too large for a ring");
        assert!(capacity <= MAX_CAPACITY, "ring capacity above the ceiling");
        Self {
            base,
            capacity,
            slot_words,
        }
    }

    /// First word of the ring, counters included.
    #[must_use]
    pub const fn base(&self) -> usize {
        self.base
    }

    /// Slots, always a power of two.
    #[must_use]
    pub const fn capacity(&self) -> u32 {
        self.capacity
    }

    /// Words per slot.
    #[must_use]
    pub const fn slot_words(&self) -> usize {
        self.slot_words
    }

    /// First word after the ring.
    #[must_use]
    pub const fn end(&self) -> usize {
        self.base + SLOTS + self.capacity as usize * self.slot_words
    }

    const fn slot(&self, counter: u32) -> usize {
        self.base + SLOTS + (counter & (self.capacity - 1)) as usize * self.slot_words
    }
}

/// The ring was full. Not a protocol state (§3): the answer is always "next
/// frame".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Full;

impl fmt::Display for Full {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ring is full")
    }
}

impl core::error::Error for Full {}

/// What both halves are.
///
/// They hold the same three fields and see the same two counters, and differ
/// only in which counter is theirs to move. Saying that once is what keeps the
/// ordering rule below in one place instead of in a comment at every call site.
struct Half<C, S> {
    cells: C,
    layout: RingLayout,
    /// `fn(S) -> S` rather than `S`: a half passes slots through and owns none,
    /// so it has no business inheriting `S`'s auto traits or its drop order.
    slot: PhantomData<fn(S) -> S>,
}

impl<C: Cells, S: Slot> Half<C, S> {
    fn new(cells: C, layout: RingLayout) -> Self {
        debug_assert_eq!(layout.slot_words(), S::WORDS);
        Self {
            cells,
            layout,
            slot: PhantomData,
        }
    }

    /// Our own counter. We are the only writer, so there is nothing to acquire.
    fn ours(&self, counter: usize) -> u32 {
        self.cells.load_relaxed(self.layout.base + counter)
    }

    /// The other half's counter, and with it everything it wrote before moving
    /// it — this acquire is what its release published to.
    fn theirs(&self, counter: usize) -> u32 {
        self.cells.load_acquire(self.layout.base + counter)
    }

    /// Move our counter on, publishing the slot we just finished with.
    fn advance(&self, counter: usize, to: u32) {
        self.cells.store_release(self.layout.base + counter, to);
    }

    fn write_slot(&self, at: u32, item: &S) {
        let mut words = [0u32; MAX_SLOT_WORDS];
        item.encode(&mut words[..S::WORDS]);
        self.cells
            .write_words(self.layout.slot(at), &words[..S::WORDS]);
    }

    fn read_slot(&self, at: u32) -> S {
        let mut words = [0u32; MAX_SLOT_WORDS];
        self.cells
            .read_words(self.layout.slot(at), &mut words[..S::WORDS]);
        S::decode(&words[..S::WORDS])
    }
}

/// The writing half. Exactly one may exist per ring; `&mut self` says so as far
/// as the type system can reach, which is not across the module boundary.
pub struct Producer<C, S> {
    half: Half<C, S>,
}

impl<C: Cells, S: Slot> Producer<C, S> {
    /// `layout` must be the one the consumer was built with, and its slot must
    /// be `S`'s — checked in a debug build, and by the handshake in every build.
    #[must_use]
    pub fn new(cells: C, layout: RingLayout) -> Self {
        Self {
            half: Half::new(cells, layout),
        }
    }

    /// Copies `item` into the ring. Never blocks and never allocates.
    ///
    /// # Errors
    ///
    /// [`Full`] if the consumer has not drained enough to make room. `item` is
    /// untouched, so the caller may keep it and offer it again.
    pub fn push(&mut self, item: &S) -> Result<(), Full> {
        let head = self.half.ours(HEAD);
        // Acquiring the tail is also what makes the consumer's reads of the slot
        // we are about to overwrite finished before we start.
        if head.wrapping_sub(self.half.theirs(TAIL)) >= self.half.layout.capacity() {
            return Err(Full);
        }

        self.half.write_slot(head, item);
        self.half.advance(HEAD, head.wrapping_add(1));
        Ok(())
    }
}

/// The reading half. Exactly one per ring, as with [`Producer`].
pub struct Consumer<C, S> {
    half: Half<C, S>,
}

impl<C: Cells, S: Slot> Consumer<C, S> {
    /// See [`Producer::new`].
    #[must_use]
    pub fn new(cells: C, layout: RingLayout) -> Self {
        Self {
            half: Half::new(cells, layout),
        }
    }

    /// The oldest item waiting, or `None` if there is none. Never blocks, never
    /// allocates and cannot fail — a slot this side does not recognise decodes
    /// to a value rather than an error ([`Slot`]).
    pub fn pop(&mut self) -> Option<S> {
        let tail = self.half.ours(TAIL);
        if self.half.theirs(HEAD) == tail {
            return None;
        }

        let item = self.half.read_slot(tail);
        self.half.advance(TAIL, tail.wrapping_add(1));
        Some(item)
    }

    /// Items waiting. A snapshot: the producer may add more before it is read.
    #[must_use]
    pub fn len(&self) -> u32 {
        self.half.theirs(HEAD).wrapping_sub(self.half.ours(TAIL))
    }

    /// Whether anything is waiting. See [`Consumer::len`].
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Instant;

    use super::*;
    use crate::access::testing::Words;
    use crate::fixtures::STUCK;

    /// Three words, each carrying something, so a slot read one word out of
    /// place fails rather than happens to work.
    ///
    /// This was one word at base zero, which is the degenerate case: there
    /// `* slot_words` and `/ slot_words` agree, and `base + x` and `x` agree, so
    /// several wrong layouts were indistinguishable from the right one.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Tick(u32);

    impl Slot for Tick {
        const WORDS: usize = 3;

        fn encode(&self, into: &mut [u32]) {
            into[0] = self.0;
            into[1] = !self.0;
            into[2] = self.0.wrapping_add(0x5555_5555);
        }

        fn decode(from: &[u32]) -> Self {
            let value = from[0];
            assert_eq!(from[1], !value, "slot read out of place");
            assert_eq!(
                from[2],
                value.wrapping_add(0x5555_5555),
                "slot read out of place"
            );
            Self(value)
        }
    }

    const CAPACITY: u32 = 8;
    const BASE: usize = 5;
    const LAYOUT: RingLayout = RingLayout::new(BASE, CAPACITY, Tick::WORDS);

    /// Miri interprets rather than runs, some hundreds of times slower, so it
    /// gets a shorter version of the loops below rather than none at all.
    const ROUNDS: usize = if cfg!(miri) { 2_000 } else { 100_000 };
    const ITEMS: u32 = if cfg!(miri) { 2_000 } else { 1_000_000 };

    fn words() -> Words {
        Words::new(LAYOUT.end())
    }

    fn ring(words: &Words) -> (Producer<&Words, Tick>, Consumer<&Words, Tick>) {
        (Producer::new(words, LAYOUT), Consumer::new(words, LAYOUT))
    }

    /// The layout is half of a contract with a module that is compiled
    /// separately, so what it promises is written down rather than left to
    /// whatever the arithmetic happens to produce: slots are contiguous, in
    /// order, start after the counters, wrap at capacity, and the last one ends
    /// exactly where the ring does.
    #[test]
    fn the_slots_fill_the_ring_exactly() {
        let first = LAYOUT.base() + SLOTS;
        for counter in 0..CAPACITY {
            assert_eq!(LAYOUT.slot(counter), first + counter as usize * Tick::WORDS);
        }
        assert_eq!(LAYOUT.slot(CAPACITY), first, "a lap wraps");
        assert_eq!(first + CAPACITY as usize * Tick::WORDS, LAYOUT.end());
    }

    #[test]
    fn empty_ring_yields_nothing() {
        let words = words();
        let (_, mut consumer) = ring(&words);
        assert_eq!(consumer.pop(), None);
    }

    #[test]
    fn order_is_preserved() {
        let words = words();
        let (mut producer, mut consumer) = ring(&words);
        for i in 0..CAPACITY {
            producer.push(&Tick(i)).unwrap();
        }
        for i in 0..CAPACITY {
            assert_eq!(consumer.pop(), Some(Tick(i)));
        }
        assert_eq!(consumer.pop(), None);
    }

    #[test]
    fn a_full_ring_refuses_rather_than_overwrites() {
        let words = words();
        let (mut producer, mut consumer) = ring(&words);
        for i in 0..CAPACITY {
            producer.push(&Tick(i)).unwrap();
        }
        assert_eq!(producer.push(&Tick(99)), Err(Full));
        assert_eq!(consumer.pop(), Some(Tick(0)));
    }

    #[test]
    fn what_is_waiting_can_be_counted() {
        let words = words();
        let (mut producer, mut consumer) = ring(&words);
        assert!(consumer.is_empty());

        producer.push(&Tick(1)).unwrap();
        producer.push(&Tick(2)).unwrap();
        assert_eq!(consumer.len(), 2);
        assert!(!consumer.is_empty());

        consumer.pop().unwrap();
        assert_eq!(consumer.len(), 1);
        consumer.pop().unwrap();
        assert!(consumer.is_empty());
    }

    #[test]
    fn indices_wrap_many_times_over() {
        let words = words();
        let (mut producer, mut consumer) = ring(&words);
        for i in 0..CAPACITY * 100 {
            producer.push(&Tick(i)).unwrap();
            assert_eq!(consumer.pop(), Some(Tick(i)));
        }
    }

    /// The counters are `u32` and grow without bound, so at roughly four billion
    /// items they wrap. Seeded here rather than waited for.
    #[test]
    fn counters_survive_their_own_overflow() {
        let words = words();
        let near_the_end = u32::MAX - 2;
        words.store_relaxed(BASE + HEAD, near_the_end);
        words.store_relaxed(BASE + TAIL, near_the_end);

        let (mut producer, mut consumer) = ring(&words);
        for i in 0..CAPACITY * 4 {
            producer.push(&Tick(i)).unwrap();
            assert_eq!(consumer.pop(), Some(Tick(i)));
        }
        assert!(words.load_relaxed(BASE + HEAD) < CAPACITY * 4);
    }

    #[test]
    fn a_full_ring_says_so() {
        assert_eq!(std::format!("{Full}"), "ring is full");
    }

    /// Against a `VecDeque` doing the obvious thing, on a fixed pseudo-random
    /// sequence of pushes and pops.
    #[test]
    fn behaves_like_a_queue() {
        let words = words();
        let (mut producer, mut consumer) = ring(&words);
        let mut model: VecDeque<Tick> = VecDeque::new();

        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = 0u32;
        for _ in 0..ROUNDS {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            if seed >> 63 == 0 {
                let item = Tick(next);
                match producer.push(&item) {
                    Ok(()) => {
                        model.push_back(item);
                        next += 1;
                    }
                    Err(Full) => assert_eq!(model.len(), CAPACITY as usize),
                }
            } else {
                assert_eq!(consumer.pop(), model.pop_front());
            }
        }
    }

    #[test]
    fn two_threads_lose_nothing_and_reorder_nothing() {
        let words = words();
        let done = AtomicBool::new(false);

        thread::scope(|scope| {
            scope.spawn(|| {
                let mut producer: Producer<&Words, Tick> = Producer::new(&words, LAYOUT);
                let mut moved = Instant::now();
                for i in 0..ITEMS {
                    while producer.push(&Tick(i)).is_err() {
                        assert!(moved.elapsed() < STUCK, "nothing has drained in {STUCK:?}");
                        std::hint::spin_loop();
                    }
                    moved = Instant::now();
                }
                done.store(true, Ordering::Release);
            });

            let mut consumer: Consumer<&Words, Tick> = Consumer::new(&words, LAYOUT);
            let mut expected = 0u32;
            let mut moved = Instant::now();
            while expected < ITEMS {
                match consumer.pop() {
                    Some(Tick(got)) => {
                        assert_eq!(got, expected);
                        expected += 1;
                        moved = Instant::now();
                    }
                    None => {
                        // `done` is stored after the last push, so seeing it set
                        // with nothing waiting means the rest is not coming.
                        assert!(
                            !done.load(Ordering::Acquire) || !consumer.is_empty(),
                            "producer finished with {} items still owed",
                            ITEMS - expected
                        );
                        assert!(
                            moved.elapsed() < STUCK,
                            "nothing has arrived in {STUCK:?}, {} items still owed",
                            ITEMS - expected
                        );
                        std::hint::spin_loop();
                    }
                }
            }
        });
    }
}
