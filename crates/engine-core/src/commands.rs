//! Bytes from the command ring, applied within a per-block budget.

use std::ops::ControlFlow;

use crate::framing::{Frame, MAX_MESSAGE, frame, split};
use crate::schema::{
    AfterBatch, CommandKind, HangAudio, NoteOff, NoteOn, PanicAudio, Rejection, SetParam,
    SetStripParam, SetTempo, SetTransport,
};

/// In bytes, since the worklet has no precise clock; the largest message still fits.
pub const PARSE_BUDGET: usize = MAX_MESSAGE;

/// A partly received largest message and as much again.
pub const INPUT_CAPACITY: usize = 2 * MAX_MESSAGE;

/// One record per kind of the schema.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command {
    SetParam(SetParam),
    AfterBatch(AfterBatch),
    NoteOn(NoteOn),
    SetTempo(SetTempo),
    SetTransport(SetTransport),
    PanicAudio(PanicAudio),
    HangAudio(HangAudio),
    NoteOff(NoteOff),
    SetStripParam(SetStripParam),
}

impl Command {
    /// Any bytes of a record's size are a valid record, so this checks only the kind and the size.
    fn decode(message: &[u8]) -> Result<Self, Rejection> {
        let (kind, record) = split(message).ok_or(Rejection::Malformed)?;
        let command = match CommandKind(kind) {
            CommandKind::SetParam => record
                .try_into()
                .map(|bytes| Self::SetParam(SetParam(bytes))),
            CommandKind::AfterBatch => record
                .try_into()
                .map(|bytes| Self::AfterBatch(AfterBatch(bytes))),
            CommandKind::NoteOn => record.try_into().map(|bytes| Self::NoteOn(NoteOn(bytes))),
            CommandKind::SetTempo => record
                .try_into()
                .map(|bytes| Self::SetTempo(SetTempo(bytes))),
            CommandKind::SetTransport => record
                .try_into()
                .map(|bytes| Self::SetTransport(SetTransport(bytes))),
            CommandKind::PanicAudio => record
                .try_into()
                .map(|bytes| Self::PanicAudio(PanicAudio(bytes))),
            CommandKind::HangAudio => record
                .try_into()
                .map(|bytes| Self::HangAudio(HangAudio(bytes))),
            CommandKind::NoteOff => record.try_into().map(|bytes| Self::NoteOff(NoteOff(bytes))),
            CommandKind::SetStripParam => record
                .try_into()
                .map(|bytes| Self::SetStripParam(SetStripParam(bytes))),
            _ => return Err(Rejection::UnknownCommand),
        };
        command.map_err(|_| Rejection::Malformed)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Drained {
    Ok,
    /// Message boundaries are lost: the waiting bytes are dropped, and the input takes no more.
    Lost,
}

/// Where the worklet copies ring bytes; allocated once.
pub struct CommandInput {
    buf: Box<[u8]>,
    len: usize,
    /// After lost boundaries, bytes could read as commands they never were.
    lost: bool,
}

impl Default for CommandInput {
    fn default() -> Self {
        Self {
            buf: vec![0; INPUT_CAPACITY].into_boxed_slice(),
            len: 0,
            lost: false,
        }
    }
}

impl CommandInput {
    /// The worklet writes new bytes at `as_mut_ptr() + len()`.
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.buf.as_mut_ptr()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// For good: see [`Drained::Lost`].
    pub fn is_lost(&self) -> bool {
        self.lost
    }

    /// Accounts for `bytes` the worklet wrote after the waiting ones.
    pub fn received(&mut self, bytes: usize) {
        if !self.lost {
            self.len = self.len.saturating_add(bytes).min(self.buf.len());
        }
    }

    /// Returns how many of `bytes` fit.
    pub fn write(&mut self, bytes: &[u8]) -> usize {
        if self.lost {
            return 0;
        }
        let written = bytes.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + written].copy_from_slice(&bytes[..written]);
        self.len += written;
        written
    }

    /// Hands whole messages to `apply`, up to [`PARSE_BUDGET`] bytes. On a break, that message and the rest wait for
    /// the next block.
    pub fn drain(
        &mut self,
        mut apply: impl FnMut(Result<Command, Rejection>) -> ControlFlow<()>,
    ) -> Drained {
        let mut start = 0;
        loop {
            match frame(&self.buf[start..self.len]) {
                Frame::Whole(size) if start + size <= PARSE_BUDGET => {
                    if apply(Command::decode(&self.buf[start..start + size])).is_break() {
                        break;
                    }
                    start += size;
                }
                Frame::Whole(_) | Frame::Incomplete => break,
                Frame::TooLarge => {
                    self.len = 0;
                    self.lost = true;
                    return Drained::Lost;
                }
            }
        }
        self.buf.copy_within(start..self.len, 0);
        self.len -= start;
        Drained::Ok
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::framing::SIZE_PREFIX;
    use crate::framing::tests::message;
    use crate::schema::Place;

    pub fn after_batch(batch: u32) -> Vec<u8> {
        message(CommandKind::AfterBatch.0, &AfterBatch::new(batch).0)
    }

    pub fn set_param(node: u32, param: u32, value: f32) -> Vec<u8> {
        message(
            CommandKind::SetParam.0,
            &SetParam::new(node, param, value).0,
        )
    }

    pub fn set_strip_param(node: u32, param: u32, value: f32) -> Vec<u8> {
        message(
            CommandKind::SetStripParam.0,
            &SetStripParam::new(node, param, value).0,
        )
    }

    /// Named by its key, as the page may name it.
    pub fn note_on(node: u32, key: u8, velocity: f32) -> Vec<u8> {
        message(
            CommandKind::NoteOn.0,
            &NoteOn::new(node, key, velocity, key.into()).0,
        )
    }

    pub fn note_off(node: u32, note: u32) -> Vec<u8> {
        message(CommandKind::NoteOff.0, &NoteOff::new(node, note).0)
    }

    pub fn set_tempo(bpm: f32) -> Vec<u8> {
        message(CommandKind::SetTempo.0, &SetTempo::new(bpm).0)
    }

    /// With no place: the position goes on from where it stands.
    pub fn set_transport(playing: bool, loop_ticks: u32) -> Vec<u8> {
        placed_transport(playing, loop_ticks, 0, 0)
    }

    pub fn placed_transport(playing: bool, loop_ticks: u32, press: u32, tick: u32) -> Vec<u8> {
        message(
            CommandKind::SetTransport.0,
            &SetTransport::new(playing, loop_ticks, &Place::new(press, tick)).0,
        )
    }

    pub fn panic_audio(code: u32) -> Vec<u8> {
        message(CommandKind::PanicAudio.0, &PanicAudio::new(code).0)
    }

    pub fn hang_audio(code: u32) -> Vec<u8> {
        message(CommandKind::HangAudio.0, &HangAudio::new(code).0)
    }

    /// A known kind with a record one byte short; the page's encoder can't produce it.
    pub fn wrong_size() -> Vec<u8> {
        message(CommandKind::SetParam.0, &[0; size_of::<SetParam>() - 1])
    }

    /// The page's encoder can't produce it.
    pub fn unknown_kind() -> Vec<u8> {
        message(0, &[0; 4])
    }

    /// The shortest message there is, so the most rejections a block's budget holds.
    pub fn no_kind() -> Vec<u8> {
        0u32.to_le_bytes().to_vec()
    }

    /// The batches of the markers it drains, waiting at `wait`.
    fn drain_until(input: &mut CommandInput, wait: u32) -> (Vec<u32>, Drained) {
        let mut batches = Vec::new();
        let drained = input.drain(|command| match command {
            Ok(Command::AfterBatch(marker)) if marker.batch() == wait => ControlFlow::Break(()),
            Ok(Command::AfterBatch(marker)) => {
                batches.push(marker.batch());
                ControlFlow::Continue(())
            }
            other => panic!("not a marker: {other:?}"),
        });
        (batches, drained)
    }

    fn drain_markers(input: &mut CommandInput) -> (Vec<u32>, Drained) {
        drain_until(input, 0)
    }

    #[test]
    fn every_kind_of_the_schema_has_a_record() {
        for &kind in CommandKind::ENUM_VALUES {
            // No record is this long, so a known kind is malformed rather than unknown.
            let decoded = Command::decode(&message(kind.0, &[0; 64]));
            assert_eq!(decoded, Err(Rejection::Malformed), "{kind:?}");
        }
    }

    #[test]
    fn a_record_of_another_size_than_its_kind_is_malformed() {
        assert_eq!(Command::decode(&wrong_size()), Err(Rejection::Malformed));
        assert_eq!(Command::decode(&no_kind()), Err(Rejection::Malformed));
        assert_eq!(
            Command::decode(&unknown_kind()),
            Err(Rejection::UnknownCommand)
        );
    }

    #[test]
    fn waits_for_the_rest_of_a_message() {
        let mut input = CommandInput::default();
        let bytes = after_batch(1);
        let (head, tail) = bytes.split_at(bytes.len() / 2);
        input.write(head);
        assert_eq!(drain_markers(&mut input), (vec![], Drained::Ok));
        input.write(tail);
        assert_eq!(drain_markers(&mut input), (vec![1], Drained::Ok));
        assert!(input.is_empty());
    }

    #[test]
    fn applies_at_most_the_budget_per_block() {
        let mut input = CommandInput::default();
        let size = after_batch(1).len();
        let count = (PARSE_BUDGET / size + 10) as u32;
        for batch in 1..=count {
            assert_eq!(input.write(&after_batch(batch)), size);
        }
        let (first, _) = drain_markers(&mut input);
        assert_eq!(first.len(), PARSE_BUDGET / size);
        let (second, _) = drain_markers(&mut input);
        assert_eq!(second, (first.len() as u32 + 1..=count).collect::<Vec<_>>());
    }

    #[test]
    fn a_size_too_large_drops_everything_and_takes_nothing_more() {
        let mut input = CommandInput::default();
        input.write(&u32::MAX.to_le_bytes());
        input.write(&after_batch(1));
        assert_eq!(drain_markers(&mut input), (vec![], Drained::Lost));
        assert!(input.is_empty());
        assert_eq!(input.write(&after_batch(2)), 0);
        input.received(8);
        assert_eq!(drain_markers(&mut input), (vec![], Drained::Ok));
        assert!(input.is_empty());
    }

    #[test]
    fn waits_for_a_message_of_the_largest_size() {
        let mut input = CommandInput::default();
        input.write(&((MAX_MESSAGE - SIZE_PREFIX) as u32).to_le_bytes());
        assert_eq!(drain_markers(&mut input), (vec![], Drained::Ok));
        assert_eq!(input.len(), SIZE_PREFIX);
    }

    #[test]
    fn skips_an_invalid_message() {
        let mut input = CommandInput::default();
        input.write(&wrong_size());
        input.write(&after_batch(2));
        let mut results = Vec::new();
        input.drain(|command| {
            results.push(command);
            ControlFlow::Continue(())
        });
        assert_eq!(
            results,
            [
                Err(Rejection::Malformed),
                Ok(Command::AfterBatch(AfterBatch::new(2)))
            ]
        );
    }

    #[test]
    fn a_message_that_waits_keeps_its_place_and_holds_back_the_rest() {
        let mut input = CommandInput::default();
        for batch in 1..=3 {
            input.write(&after_batch(batch));
        }
        assert_eq!(drain_until(&mut input, 2), (vec![1], Drained::Ok));
        assert_eq!(input.len(), 2 * after_batch(2).len());
        assert_eq!(drain_markers(&mut input), (vec![2, 3], Drained::Ok));
        assert!(input.is_empty());
    }
}
