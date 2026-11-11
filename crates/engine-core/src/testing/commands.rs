//! Messages of the command ring, as the page writes them.

use crate::framing::{KIND, SIZE_PREFIX, write};
use crate::schema::{
    AfterBatch, CommandKind, HangAudio, NoteOff, NoteOn, PanicAudio, Place, SetParam,
    SetStripParam, SetTempo, SetTransport,
};

pub(crate) fn message(kind: u8, record: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; SIZE_PREFIX + KIND + record.len()];
    write(&mut bytes, kind, record).unwrap();
    bytes
}

pub(crate) fn after_batch(batch: u32) -> Vec<u8> {
    message(CommandKind::AfterBatch.0, &AfterBatch::new(batch).0)
}

pub(crate) fn set_param(node: u32, param: u32, value: f32) -> Vec<u8> {
    message(
        CommandKind::SetParam.0,
        &SetParam::new(node, param, value).0,
    )
}

pub(crate) fn set_strip_param(node: u32, param: u32, value: f32) -> Vec<u8> {
    message(
        CommandKind::SetStripParam.0,
        &SetStripParam::new(node, param, value).0,
    )
}

/// Named by its key, as the page may name it.
pub(crate) fn note_on(node: u32, key: u8, velocity: f32) -> Vec<u8> {
    message(
        CommandKind::NoteOn.0,
        &NoteOn::new(node, key, velocity, key.into()).0,
    )
}

pub(crate) fn note_off(node: u32, note: u32) -> Vec<u8> {
    message(CommandKind::NoteOff.0, &NoteOff::new(node, note).0)
}

pub(crate) fn set_tempo(bpm: f32) -> Vec<u8> {
    message(CommandKind::SetTempo.0, &SetTempo::new(bpm).0)
}

/// With no place: the position goes on from where it stands.
pub(crate) fn set_transport(playing: bool, loop_ticks: u32) -> Vec<u8> {
    placed_transport(playing, loop_ticks, 0, 0)
}

pub(crate) fn placed_transport(playing: bool, loop_ticks: u32, press: u32, tick: u32) -> Vec<u8> {
    message(
        CommandKind::SetTransport.0,
        &SetTransport::new(playing, loop_ticks, &Place::new(press, tick)).0,
    )
}

pub(crate) fn panic_audio(code: u32) -> Vec<u8> {
    message(CommandKind::PanicAudio.0, &PanicAudio::new(code).0)
}

pub(crate) fn hang_audio(code: u32) -> Vec<u8> {
    message(CommandKind::HangAudio.0, &HangAudio::new(code).0)
}

/// A known kind with a record one byte short; the page's encoder can't produce it.
pub(crate) fn wrong_size() -> Vec<u8> {
    message(CommandKind::SetParam.0, &[0; size_of::<SetParam>() - 1])
}

/// The page's encoder can't produce it.
pub(crate) fn unknown_kind() -> Vec<u8> {
    message(0, &[0; 4])
}

/// The shortest message there is, so the most rejections a block's budget holds.
pub(crate) fn no_kind() -> Vec<u8> {
    0u32.to_le_bytes().to_vec()
}
