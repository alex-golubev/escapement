// SPDX-License-Identifier: Apache-2.0
//
// The Rust side of the golden vectors. The same file is read by the
// TypeScript side, so a disagreement between the two shows up here or there
// rather than as a click in the audio (ADR-0011).

// The workspace's real-time rules are for the audio path (ADR-0002). A test is
// not on it, and panicking is how it reports a failure.
#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

use core::mem::offset_of;
use protocol::*;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../schema/vectors/boundary.json"
    );
    let text = std::fs::read_to_string(path).expect("the vectors file is part of the repository");
    serde_json::from_str(&text).expect("the vectors file is valid JSON")
}

/// `"0x01020304"` -> `0x01020304`. Hex in the file so that a value and its
/// bytes can be checked against each other by eye.
fn hex(text: &str) -> u32 {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    u32::from_str_radix(digits, 16).expect("a hexadecimal word")
}

fn word(vector: &Value, group: &str, name: &str) -> u32 {
    hex(vector[group][name]
        .as_str()
        .unwrap_or_else(|| panic!("{group}.{name} is missing")))
}

fn top(vector: &Value, name: &str) -> u32 {
    hex(vector[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is missing")))
}

/// Offsets, lengths and enum codes are decimal in the vectors: they are numbers
/// to compare rather than bytes to read off.
fn number(vector: &Value, name: &str) -> u32 {
    let found = vector[name]
        .as_u64()
        .unwrap_or_else(|| panic!("{name} is missing"));
    u32::try_from(found).expect("a value that fits the boundary's u32")
}

fn expected_bytes(vector: &Value) -> Vec<u8> {
    let text = vector["bytes"].as_str().expect("bytes is a string");
    let digits: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(
        digits.len().is_multiple_of(2),
        "an even number of hex digits"
    );
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).expect("a hexadecimal byte"))
        .collect()
}

fn find<'a>(vectors: &'a Value, group: &str, key: &str, name: &str) -> &'a Value {
    vectors[group]
        .as_array()
        .expect("a list of vectors")
        .iter()
        .find(|vector| vector[key].as_str() == Some(name))
        .unwrap_or_else(|| panic!("no vector for {name}"))
}

fn as_bytes<T>(value: &T) -> &[u8] {
    // Sound because every record is #[repr(C)] with the size the schema states,
    // which the generated static assertions enforce at compile time.
    unsafe { core::slice::from_raw_parts((value as *const T).cast::<u8>(), size_of::<T>()) }
}

fn from_bytes<T>(bytes: &[u8]) -> T {
    assert_eq!(
        bytes.len(),
        size_of::<T>(),
        "the vector is the size of the record"
    );
    unsafe { core::ptr::read_unaligned(bytes.as_ptr().cast::<T>()) }
}

#[test]
fn command_slot_matches_its_vector() {
    let all = vectors();
    let vector = find(&all, "records", "record", "command_slot");

    let slot = CommandSlot {
        kind: word(vector, "fields", "kind"),
        frame_offset: word(vector, "fields", "frame_offset"),
        payload: [0u8; COMMAND_PAYLOAD_SIZE],
    };

    assert_eq!(as_bytes(&slot), expected_bytes(vector), "encoding");
    assert_eq!(
        from_bytes::<CommandSlot>(&expected_bytes(vector)),
        slot,
        "decoding"
    );
}

/// The engine's own half of the meters: plain memory the glue reads, not the
/// shared copy it publishes.
#[test]
fn engine_report_matches_its_vector() {
    let all = vectors();
    let vector = find(&all, "records", "record", "engine_report");

    let report = EngineReport {
        position_frames: word(vector, "fields", "position_frames") as i32,
        peak_amp_micro: word(vector, "fields", "peak_amp_micro") as i32,
        transport_state: word(vector, "fields", "transport_state") as i32,
        dropped_commands: word(vector, "fields", "dropped_commands"),
    };

    assert_eq!(as_bytes(&report), expected_bytes(vector), "encoding");
    assert_eq!(
        from_bytes::<EngineReport>(&expected_bytes(vector)),
        report,
        "decoding"
    );
    assert_eq!(
        report.peak_amp_micro, 1_000_000,
        "the peak is an amplitude times a million, so this one is 1.0"
    );
}

#[test]
fn meter_block_matches_its_vector() {
    let all = vectors();
    let vector = find(&all, "records", "record", "meter_block");

    let block = MeterBlock {
        block_counter: word(vector, "fields", "block_counter") as i32,
        position_frames: word(vector, "fields", "position_frames") as i32,
        peak_amp_micro: word(vector, "fields", "peak_amp_micro") as i32,
        transport_state: word(vector, "fields", "transport_state") as i32,
    };

    assert_eq!(as_bytes(&block), expected_bytes(vector), "encoding");
    assert_eq!(
        from_bytes::<MeterBlock>(&expected_bytes(vector)),
        block,
        "decoding"
    );
    assert_eq!(
        block.peak_amp_micro, -1,
        "0xffffffff is a negative peak, not a huge one"
    );
}

fn slot_for(
    kind: CommandKind,
    frame_offset: u32,
    payload: [u8; COMMAND_PAYLOAD_SIZE],
) -> CommandSlot {
    CommandSlot {
        kind: kind.code(),
        frame_offset,
        payload,
    }
}

/// The payloads start full of 0xaa rather than zero: a slot in the ring is
/// reused, and the vector's zero bytes are a promise that a writer fills the
/// whole payload, not an artefact of starting from a fresh buffer.
#[test]
fn commands_match_their_vectors() {
    let all = vectors();

    let vector = find(&all, "commands", "command", "play");
    let mut payload = [0xaa; COMMAND_PAYLOAD_SIZE];
    let play = Play {
        from_frame: word(vector, "fields", "from_frame"),
    };
    play.write(&mut payload);
    let slot = slot_for(CommandKind::Play, top(vector, "frame_offset"), payload);
    assert_eq!(as_bytes(&slot), expected_bytes(vector), "play encoding");
    assert_eq!(Play::read(&slot.payload), play, "play decoding");

    let vector = find(&all, "commands", "command", "stop");
    let mut payload = [0xaa; COMMAND_PAYLOAD_SIZE];
    Stop {}.write(&mut payload);
    let slot = slot_for(CommandKind::Stop, top(vector, "frame_offset"), payload);
    assert_eq!(as_bytes(&slot), expected_bytes(vector), "stop encoding");

    let vector = find(&all, "commands", "command", "set_tempo");
    let mut payload = [0xaa; COMMAND_PAYLOAD_SIZE];
    let set_tempo = SetTempo {
        micro_bpm: word(vector, "fields", "micro_bpm"),
    };
    set_tempo.write(&mut payload);
    let slot = slot_for(CommandKind::SetTempo, top(vector, "frame_offset"), payload);
    assert_eq!(
        as_bytes(&slot),
        expected_bytes(vector),
        "set_tempo encoding"
    );
    assert_eq!(
        SetTempo::read(&slot.payload),
        set_tempo,
        "set_tempo decoding"
    );
}

/// The generated codes are what a third-party host or plugin SDK implements
/// against, and [ADR-0011] counts them among what the golden vectors fix. Both
/// sides read them from the file rather than from each other.
#[test]
fn enum_codes_match_their_vector() {
    let all = vectors();

    let kinds = &find(&all, "enums", "enum", "command_kind")["codes"];
    assert_eq!(CommandKind::Play.code(), number(kinds, "play"));
    assert_eq!(CommandKind::Stop.code(), number(kinds, "stop"));
    assert_eq!(CommandKind::SetTempo.code(), number(kinds, "set_tempo"));

    let errors = &find(&all, "enums", "enum", "engine_error")["codes"];
    for (code, expected) in [
        (EngineError::Ok, "ok"),
        (EngineError::UnknownCommandKind, "unknown_command_kind"),
        (EngineError::BadFrameCount, "bad_frame_count"),
        (EngineError::BadSampleRate, "bad_sample_rate"),
        (EngineError::NotInitialised, "not_initialised"),
        (EngineError::TooManyCommands, "too_many_commands"),
        (EngineError::BadCommandPayload, "bad_command_payload"),
        (EngineError::BadFrameOffset, "bad_frame_offset"),
        (EngineError::CommandsOutOfOrder, "commands_out_of_order"),
    ] {
        assert_eq!(code.code(), number(errors, expected), "{expected}");
    }

    let transport = &find(&all, "enums", "enum", "transport_state")["codes"];
    assert_eq!(TransportState::Stopped.code(), number(transport, "stopped"));
    assert_eq!(TransportState::Playing.code(), number(transport, "playing"));
}

/// A plane of samples has no byte vector, so what the two sides have to agree
/// on is where it starts and how much of it there is. Here that is a static
/// assertion rustc already checks; in TypeScript it is arithmetic inside a
/// generated function, which is why the number lives in the file.
#[test]
fn array_fields_match_their_vector() {
    let all = vectors();
    let elements = |bytes: usize| u32::try_from(bytes / size_of::<f32>()).expect("a plane");

    let left = find(&all, "arrays", "field", "left");
    assert_eq!(offset_of!(AudioOut, left) as u32, number(left, "offset"));
    assert_eq!(AudioOut::LEFT_OFFSET as u32, number(left, "offset"));
    assert_eq!(
        elements(AudioOut::RIGHT_OFFSET - AudioOut::LEFT_OFFSET),
        number(left, "length"),
        "the left plane runs up to the right one"
    );

    let right = find(&all, "arrays", "field", "right");
    assert_eq!(offset_of!(AudioOut, right) as u32, number(right, "offset"));
    assert_eq!(AudioOut::RIGHT_OFFSET as u32, number(right, "offset"));
    assert_eq!(
        elements(AudioOut::SIZE - AudioOut::RIGHT_OFFSET),
        number(right, "length"),
        "the right plane runs to the end of the record"
    );

    let payload = find(&all, "arrays", "field", "payload");
    assert_eq!(
        offset_of!(CommandSlot, payload) as u32,
        number(payload, "offset")
    );
    assert_eq!(COMMAND_PAYLOAD_OFFSET as u32, number(payload, "offset"));
    assert_eq!(COMMAND_PAYLOAD_SIZE as u32, number(payload, "length"));
}

#[test]
fn unknown_command_codes_are_rejected() {
    assert_eq!(CommandKind::from_code(1), Some(CommandKind::Play));
    assert_eq!(CommandKind::from_code(0), None);
    assert_eq!(CommandKind::from_code(u32::MAX), None);
}
