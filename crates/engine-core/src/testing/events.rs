//! The engine's events as the page reads them.

use crate::events::EngineEvent;
use crate::framing::{self, Frame, frame};
use crate::handoff::Batch;
use crate::schema::{CommandRejected, CommandStreamLost, EditRejected, EventKind};

pub fn decode_one(message: &[u8]) -> (u32, EngineEvent) {
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
            let (batch, reason) = (Batch::new(record.batch()), record.reason());
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
