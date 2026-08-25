//! What the stress tests cannot check: that the orderings are right under every
//! interleaving the memory model permits, rather than under the one that
//! happened on this machine today.
//!
//! The models are deliberately tiny — a ring of two slots, a slot of one word,
//! three items — because `loom` runs the program once per permitted execution
//! and the count grows with every shared access. Size here buys nothing: an
//! ordering that is wrong is wrong at two slots.

use std::sync::Arc;

use ::loom::thread;

use crate::access::loom::LoomWords;
use crate::fixtures::sample;
use crate::ring::{Consumer, Producer, RingLayout, Slot};
use crate::state::{BlockLayout, Publisher, Subscriber};

const ITEMS: u32 = 3;
const CAPACITY: u32 = 2;

struct Tick(u32);

impl Slot for Tick {
    const WORDS: usize = 1;

    fn encode(&self, into: &mut [u32]) {
        into[0] = self.0;
    }

    fn decode(from: &[u32]) -> Self {
        Self(from[0])
    }
}

/// More items than slots, so the producer has to wait on the consumer and the
/// consumer on the producer — both handoffs are in the model.
#[test]
fn the_ring_hands_items_over_in_order_under_every_interleaving() {
    ::loom::model(|| {
        let layout = RingLayout::new(0, CAPACITY, Tick::WORDS);
        let cells = Arc::new(LoomWords::new(layout.end()));

        let writing = {
            let cells = Arc::clone(&cells);
            thread::spawn(move || {
                let mut producer: Producer<Arc<LoomWords>, Tick> = Producer::new(cells, layout);
                for item in 0..ITEMS {
                    while producer.push(&Tick(item)).is_err() {
                        thread::yield_now();
                    }
                }
            })
        };

        let mut consumer: Consumer<Arc<LoomWords>, Tick> = Consumer::new(cells, layout);
        let mut expected = 0;
        while expected < ITEMS {
            match consumer.pop() {
                Some(Tick(got)) => {
                    assert_eq!(got, expected, "item arrived out of order");
                    expected += 1;
                }
                None => thread::yield_now(),
            }
        }

        writing.join().unwrap();
    });
}

/// One publish against one read. The reader either retries or returns a state
/// whose fields belong together; nothing but a missing ordering could give it
/// half of one and half of another.
///
/// Bounded, unlike the ring above, and the bound is not a formality: a relaxed
/// load makes `loom` branch on every value it could return, and the payload is
/// eight words. Unbounded, this model was still running after half an hour.
/// Three preemptions is the usual compromise — it is not a proof, but a real
/// ordering bug that needs four context switches to show itself is rare.
#[test]
fn the_state_block_is_never_read_half_written() {
    let mut model = ::loom::model::Builder::new();
    model.preemption_bound = Some(3);
    model.check(|| {
        let layout = BlockLayout::new(0);
        let cells = Arc::new(LoomWords::new(layout.end()));

        let writing = {
            let cells = Arc::clone(&cells);
            thread::spawn(move || {
                Publisher::new(cells, layout).publish(&sample(1));
            })
        };

        if let Some(seen) = Subscriber::new(cells, layout).read() {
            assert_eq!(seen, sample(seen.quanta), "torn read");
        }

        writing.join().unwrap();
    });
}
