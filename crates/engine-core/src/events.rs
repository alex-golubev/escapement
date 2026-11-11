//! What the engine reports once, unlike the telemetry.

use crate::framing::{self, Frame, frame};
use crate::schema::{CommandRejected, CommandStreamLost, EditRejected, EventKind, Rejection};

/// Kept between takes; needn't match the event ring, since a take hands out only what fits.
pub const EVENT_CAPACITY: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineEvent {
    CommandRejected(Rejection),
    CommandStreamLost,
    EditRejected { batch: u32, reason: Rejection },
}

/// Events waiting for the worklet to take them; allocated once.
pub struct EventOutput {
    buf: Box<[u8]>,
    len: usize,
    /// An event didn't fit since the last take.
    full: bool,
}

impl Default for EventOutput {
    fn default() -> Self {
        Self {
            buf: vec![0; EVENT_CAPACITY].into_boxed_slice(),
            len: 0,
            full: false,
        }
    }
}

impl EventOutput {
    /// Where [`take`](Self::take) hands out events.
    #[must_use]
    pub fn as_ptr(&self) -> *const u8 {
        self.buf.as_ptr()
    }

    /// False if the event is lost. After one is lost, later ones are too until the next take:
    /// events stay in order, and a flood doesn't cost writing events only to drop them.
    #[must_use]
    pub fn push(&mut self, epoch: u32, event: EngineEvent) -> bool {
        if self.full {
            return false;
        }
        if let Some(size) = write(&mut self.buf[self.len..], epoch, event) {
            self.len += size;
            true
        } else {
            self.full = true;
            false
        }
    }

    /// Hands out the events that fit into `room` bytes, drops the rest and returns how many were lost.
    pub fn take(&mut self, room: usize) -> (&[u8], u32) {
        let (mut handed, mut lost, mut start) = (0, 0, 0);
        while let Frame::Whole(size) = frame(&self.buf[start..self.len]) {
            if start + size <= room {
                handed = start + size;
            } else {
                lost += 1;
            }
            start += size;
        }
        debug_assert_eq!(start, self.len);
        self.len = 0;
        self.full = false;
        (&self.buf[..handed], lost)
    }
}

/// Returns the message's size; `None` if it doesn't fit.
fn write(out: &mut [u8], epoch: u32, event: EngineEvent) -> Option<usize> {
    match event {
        EngineEvent::CommandRejected(reason) => framing::write(
            out,
            EventKind::CommandRejected.0,
            &CommandRejected::new(epoch, reason).0,
        ),
        EngineEvent::CommandStreamLost => framing::write(
            out,
            EventKind::CommandStreamLost.0,
            &CommandStreamLost::new(epoch).0,
        ),
        EngineEvent::EditRejected { batch, reason } => framing::write(
            out,
            EventKind::EditRejected.0,
            &EditRejected::new(epoch, batch, reason).0,
        ),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn decode_one(message: &[u8]) -> (u32, EngineEvent) {
        let (kind, record) = framing::split(message).unwrap();
        match EventKind(kind) {
            EventKind::CommandRejected => {
                let record = CommandRejected(record.try_into().unwrap());
                (
                    record.epoch(),
                    EngineEvent::CommandRejected(record.reason()),
                )
            }
            EventKind::CommandStreamLost => {
                let record = CommandStreamLost(record.try_into().unwrap());
                (record.epoch(), EngineEvent::CommandStreamLost)
            }
            EventKind::EditRejected => {
                let record = EditRejected(record.try_into().unwrap());
                let (batch, reason) = (record.batch(), record.reason());
                (record.epoch(), EngineEvent::EditRejected { batch, reason })
            }
            other => panic!("unexpected event {other:?}"),
        }
    }

    pub fn decode(mut bytes: &[u8]) -> Vec<(u32, EngineEvent)> {
        let mut events = Vec::new();
        while let Frame::Whole(size) = frame(bytes) {
            let (message, rest) = bytes.split_at(size);
            events.push(decode_one(message));
            bytes = rest;
        }
        assert!(bytes.is_empty(), "{} bytes left over", bytes.len());
        events
    }

    fn message_size(event: EngineEvent) -> usize {
        write(&mut [0; 64], 1, event).unwrap()
    }

    const REJECTED: EngineEvent = EngineEvent::CommandRejected(Rejection::UnknownTarget);

    #[test]
    fn every_kind_of_the_schema_is_written() {
        let edit_rejected = EngineEvent::EditRejected {
            batch: 2,
            reason: Rejection::CellTaken,
        };
        let written: Vec<_> = [REJECTED, EngineEvent::CommandStreamLost, edit_rejected]
            .into_iter()
            .map(|event| {
                let mut out = [0; 64];
                let size = write(&mut out, 1, event).unwrap();
                assert_eq!(decode_one(&out[..size]), (1, event));
                EventKind(framing::split(&out[..size]).unwrap().0)
            })
            .collect();
        assert_eq!(written, EventKind::ENUM_VALUES);
    }

    #[test]
    fn hands_out_events_in_order() {
        let mut output = EventOutput::default();
        assert!(output.push(1, REJECTED));
        assert!(output.push(2, EngineEvent::CommandStreamLost));
        let (bytes, lost) = output.take(EVENT_CAPACITY);
        assert_eq!(
            decode(bytes),
            [(1, REJECTED), (2, EngineEvent::CommandStreamLost)]
        );
        assert_eq!(lost, 0);
    }

    #[test]
    fn events_that_do_not_fit_into_the_room_are_lost() {
        let mut output = EventOutput::default();
        for epoch in 1..=3 {
            assert!(output.push(epoch, REJECTED));
        }
        // Room for one and a half.
        let (bytes, lost) = output.take(message_size(REJECTED) * 3 / 2);
        assert_eq!(decode(bytes), [(1, REJECTED)]);
        assert_eq!(lost, 2);
    }

    #[test]
    fn take_empties_the_buffer() {
        let mut output = EventOutput::default();
        assert!(output.push(1, REJECTED));
        output.take(0);
        assert_eq!(output.take(EVENT_CAPACITY), (&[][..], 0));
    }

    #[test]
    fn an_event_beyond_the_buffer_is_lost() {
        let mut output = EventOutput::default();
        let fitting = EVENT_CAPACITY / message_size(REJECTED);
        assert!((0..fitting).all(|_| output.push(1, REJECTED)));
        assert!(!output.push(1, REJECTED));
        let (bytes, _) = output.take(EVENT_CAPACITY);
        assert_eq!(decode(bytes).len(), fitting);
    }

    #[test]
    fn once_an_event_is_lost_later_ones_are_too_until_the_next_take() {
        let (small, large) = (EngineEvent::CommandStreamLost, REJECTED);
        let (small_size, large_size) = (message_size(small), message_size(large));
        // Leaves room for a small event but not a large one.
        let smalls = (0..large_size)
            .find(|n| {
                (small_size..large_size).contains(&((EVENT_CAPACITY - n * small_size) % large_size))
            })
            .unwrap();
        let mut output = EventOutput::default();
        assert!((0..smalls).all(|_| output.push(1, small)));
        while output.push(1, large) {}
        assert!(
            !output.push(1, small),
            "a later event would come out of order"
        );
        output.take(EVENT_CAPACITY);
        assert!(output.push(1, small));
    }
}
