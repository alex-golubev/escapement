//! Parcels: what the build thread made of a batch, on their way to the audio thread and back. The audio thread
//! applies a parcel by swapping, so each edit then holds what it displaced, and dropping the returned parcel on the
//! build thread frees all of it. A parcel that started fades waits on the audio thread until they are over. The two
//! threads share nothing but these queues.

use std::collections::VecDeque;

use rtrb::{Consumer, Producer, PushError, RingBuffer};

use crate::graph::{Exit, Nodes, Order, Table};
use crate::handle::{NodeCell, NodeHandle, PatternCell};
use crate::node::Node;
use crate::schema::Rejection;
use crate::sequencer::{Arrangement, Made, Patterns};

/// Each way. A burst beyond waits on the build thread until its next collection.
const IN_FLIGHT: usize = 1024;

/// One of the page's batches, numbered from 1 in the order the page sends them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Batch(u32);

impl Batch {
    pub fn new(number: u32) -> Self {
        Self(number)
    }

    pub fn get(self) -> u32 {
        self.0
    }

    /// The one after, wrapping round.
    fn next(self) -> Self {
        Self(self.0.wrapping_add(1))
    }
}

pub(crate) struct Parcel {
    pub batch: Batch,
    pub edits: Vec<Edit>,
    /// Started fades: it goes back once they are over, and only then is what they faded out gone.
    pub holds: bool,
}

/// Holds what it brings until applied, and what it displaced after.
pub(crate) enum Edit {
    /// Starts a session; the nodes go in removals that follow.
    Reset(u32),
    /// A larger empty table for the nodes to move over to.
    Grow { table: Table, nodes: Nodes },
    CreateNode {
        cell: NodeCell,
        node: Option<Box<Node>>,
    },
    /// The node leaves its cell to play out at `exit`, and comes along when the parcel goes back.
    Remove {
        cell: NodeCell,
        exit: Exit,
        node: Option<Box<Node>>,
    },
    /// The nodes to render, what each hears and what the output hears, once the parcel's other edits are in.
    Order(Order),
    /// A larger empty table for the patterns to move over to.
    GrowPatterns(Patterns),
    /// What the cell holds from now on: a pattern made in it, or none.
    Pattern { cell: PatternCell, pattern: Made },
    /// The clips heard from now on.
    Arrangement(Arrangement),
    /// The notes of these nodes, sorted and each once, are let go of in the block the parcel comes in: one pass over the
    /// held notes, however many nodes.
    LetGo(Box<[NodeHandle]>),
    /// The build thread refused an edit of the batch; the audio thread reports it.
    Refused(Rejection),
}

pub(crate) fn channel() -> (BuildEnd, AudioEnd) {
    let (outgoing, incoming) = RingBuffer::new(IN_FLIGHT);
    let (returning, returned) = RingBuffer::new(IN_FLIGHT);
    let build = BuildEnd {
        outgoing,
        returned,
        waiting: VecDeque::new(),
        out: 0,
    };
    let audio = AudioEnd {
        incoming,
        returning,
        next: Batch(1),
        // Each held parcel has a place kept in the return queue, so there are never more.
        held: VecDeque::with_capacity(IN_FLIGHT),
    };
    (build, audio)
}

pub(crate) struct BuildEnd {
    outgoing: Producer<Box<Parcel>>,
    returned: Consumer<Box<Parcel>>,
    /// In order, while the outgoing queue is full.
    waiting: VecDeque<Box<Parcel>>,
    /// Sent and not back yet.
    out: usize,
}

impl BuildEnd {
    pub fn send(&mut self, parcel: Parcel) {
        self.waiting.push_back(Box::new(parcel));
        self.flush();
    }

    /// Shows `back` each parcel that came back, then frees it, and sends what waited; returns how many parcels
    /// aren't back yet.
    pub fn collect(&mut self, mut back: impl FnMut(&Parcel)) -> usize {
        while let Ok(parcel) = self.returned.pop() {
            back(&parcel);
            drop(parcel);
            self.out -= 1;
        }
        self.flush();
        self.out + self.waiting.len()
    }

    fn flush(&mut self) {
        while let Some(parcel) = self.waiting.pop_front() {
            match self.outgoing.push(parcel) {
                Ok(()) => self.out += 1,
                Err(PushError::Full(parcel)) => {
                    self.waiting.push_front(parcel);
                    break;
                }
            }
        }
    }
}

#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(crate) enum Arrival {
    Here(Box<Parcel>),
    /// Not built yet, or no room to send it back yet.
    NotYet,
    /// Not the batch next in line, or another batch's parcel is: waiting would hold the ring for good.
    NotNext,
}

pub(crate) struct AudioEnd {
    incoming: Consumer<Box<Parcel>>,
    returning: Producer<Box<Parcel>>,
    /// Each batch is applied once and in order.
    next: Batch,
    /// Applied parcels waiting for their fades, oldest first, each with the sample it may go back at.
    held: VecDeque<(Box<Parcel>, u64)>,
}

impl AudioEnd {
    /// Takes the batch's parcel only if it can go back: dropping it here would free memory.
    pub fn take(&mut self, batch: Batch) -> Arrival {
        let in_line = self.incoming.peek().ok().map(|parcel| parcel.batch);
        if batch != self.next || in_line.is_some_and(|other| other != batch) {
            return Arrival::NotNext;
        }
        if in_line.is_none() || !self.has_room() {
            return Arrival::NotYet;
        }
        match self.incoming.pop() {
            Ok(parcel) => {
                self.next = batch.next();
                Arrival::Here(parcel)
            }
            Err(_) => Arrival::NotYet,
        }
    }

    /// For when no marker will come any more: every parcel goes back unapplied, as there is room.
    pub fn send_back_unapplied(&mut self) {
        while self.has_room() {
            let Ok(parcel) = self.incoming.pop() else {
                return;
            };
            self.give_back(parcel);
        }
    }

    /// Only the audio thread fills the return queue, and `take` made sure of room.
    pub fn give_back(&mut self, parcel: Box<Parcel>) {
        if self.returning.push(parcel).is_err() {
            unreachable!("a parcel is taken only with room to give it back");
        }
    }

    /// Keeps an applied parcel until the sample `due`.
    pub fn hold(&mut self, parcel: Box<Parcel>, due: u64) {
        debug_assert!(self.held.len() < self.held.capacity(), "held parcels grew");
        self.held.push_back((parcel, due));
    }

    /// Gives back every held parcel due by the sample `now`, after `release` takes back what it left playing.
    pub fn release(&mut self, now: u64, mut release: impl FnMut(&mut Parcel)) {
        while self.held.front().is_some_and(|&(_, due)| due <= now) {
            if let Some((mut parcel, _)) = self.held.pop_front() {
                release(&mut parcel);
                self.give_back(parcel);
            }
        }
    }

    /// A place in the return queue beyond those the held parcels will take.
    fn has_room(&self) -> bool {
        self.returning.slots() > self.held.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heap;

    fn parcel(number: u32) -> Parcel {
        Parcel {
            batch: Batch(number),
            edits: Vec::new(),
            holds: false,
        }
    }

    /// [`IN_FLIGHT`] as batches count.
    fn in_flight() -> u32 {
        u32::try_from(IN_FLIGHT).unwrap()
    }

    fn take(audio: &mut AudioEnd, number: u32) -> Arrival {
        audio.take(Batch(number))
    }

    fn collect(build: &mut BuildEnd) -> usize {
        build.collect(|_| {})
    }

    impl std::fmt::Debug for Parcel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "parcel of batch {}", self.batch.0)
        }
    }

    impl PartialEq for Parcel {
        fn eq(&self, other: &Self) -> bool {
            self.batch == other.batch
        }
    }

    impl Eq for Parcel {}

    /// Gives the parcel back, as applying it would.
    fn pass(audio: &mut AudioEnd, arrival: Arrival) {
        match arrival {
            Arrival::Here(parcel) => audio.give_back(parcel),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parcels_arrive_in_order_and_come_back_to_be_freed() {
        let (mut build, mut audio) = channel();
        build.send(parcel(1));
        build.send(parcel(2));
        assert_eq!(take(&mut audio, 2), Arrival::NotNext);
        for batch in [1, 2] {
            let arrival = take(&mut audio, batch);
            pass(&mut audio, arrival);
        }
        assert_eq!(take(&mut audio, 3), Arrival::NotYet);
        assert_eq!(collect(&mut build), 0);
    }

    #[test]
    fn a_batch_that_is_not_next_is_refused_without_waiting() {
        let (mut build, mut audio) = channel();
        // Nothing has arrived, so only the next batch may wait.
        assert_eq!(take(&mut audio, 2), Arrival::NotNext);
        assert_eq!(take(&mut audio, 0), Arrival::NotNext);
        assert_eq!(take(&mut audio, 1), Arrival::NotYet);
        build.send(parcel(1));
        let arrival = take(&mut audio, 1);
        pass(&mut audio, arrival);
        assert_eq!(take(&mut audio, 1), Arrival::NotNext, "applied already");
        // Next is 2, but the parcel in line is another batch's.
        build.send(parcel(5));
        assert_eq!(take(&mut audio, 2), Arrival::NotNext);
    }

    #[test]
    fn parcels_go_back_unapplied_once_no_marker_will_come() {
        let (mut build, mut audio) = channel();
        for batch in 1..=3 {
            build.send(parcel(batch));
        }
        audio.send_back_unapplied();
        assert_eq!(collect(&mut build), 0);
    }

    #[test]
    fn a_parcel_without_room_to_come_back_is_not_taken() {
        let (mut build, mut audio) = channel();
        let last = in_flight() + 1;
        for batch in 1..last {
            build.send(parcel(batch));
            let arrival = take(&mut audio, batch);
            pass(&mut audio, arrival);
        }
        build.send(parcel(last));
        assert_eq!(take(&mut audio, last), Arrival::NotYet);
        assert_eq!(collect(&mut build), 1);
        let arrival = take(&mut audio, last);
        pass(&mut audio, arrival);
    }

    #[test]
    fn a_held_parcel_keeps_its_place_in_the_return_queue_and_goes_back_when_due() {
        let (mut build, mut audio) = channel();
        let last = in_flight() + 1;
        for batch in 1..last {
            build.send(parcel(batch));
            let Arrival::Here(parcel) = take(&mut audio, batch) else {
                panic!("no parcel for batch {batch}");
            };
            audio.hold(parcel, 10);
        }
        build.send(parcel(last));
        assert_eq!(
            take(&mut audio, last),
            Arrival::NotYet,
            "every place is kept"
        );
        audio.release(9, |_| panic!("not due yet"));
        let mut released = 0;
        audio.release(10, |_| released += 1);
        assert_eq!(released, IN_FLIGHT);
        assert_eq!(collect(&mut build), 1);
        let arrival = take(&mut audio, last);
        pass(&mut audio, arrival);
    }

    #[test]
    fn parcels_beyond_the_queue_wait_on_the_build_thread_in_order() {
        let (mut build, mut audio) = channel();
        let count = 2 * in_flight() + 3;
        for batch in 1..=count {
            build.send(parcel(batch));
        }
        assert_eq!(collect(&mut build), count as usize);
        for batch in 1..=count {
            let arrival = match take(&mut audio, batch) {
                // Waiting parcels move on as returned ones are collected.
                Arrival::NotYet => {
                    collect(&mut build);
                    take(&mut audio, batch)
                }
                arrival => arrival,
            };
            pass(&mut audio, arrival);
        }
        assert_eq!(collect(&mut build), 0);
    }

    #[test]
    fn the_audio_end_never_touches_the_heap() {
        let (mut build, mut audio) = channel();
        for batch in 1..=3 {
            build.send(parcel(batch));
        }
        let before = heap::calls();
        assert_eq!(take(&mut audio, 2), Arrival::NotNext);
        for batch in [1, 2] {
            let arrival = take(&mut audio, batch);
            pass(&mut audio, arrival);
        }
        let Arrival::Here(held) = take(&mut audio, 3) else {
            panic!("no parcel for batch 3");
        };
        audio.hold(held, 5);
        audio.release(5, |_| {});
        assert_eq!(take(&mut audio, 4), Arrival::NotYet);
        let after_taking = heap::calls();
        build.send(parcel(4));
        let before_sending_back = heap::calls();
        audio.send_back_unapplied();
        let calls = (after_taking - before) + (heap::calls() - before_sending_back);
        assert_eq!(calls, 0);
    }
}
