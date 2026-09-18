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

#[test]
fn meter_block_matches_its_vector() {
    let all = vectors();
    let vector = find(&all, "records", "record", "meter_block");

    let block = MeterBlock {
        block_counter: word(vector, "fields", "block_counter") as i32,
        position_frames: word(vector, "fields", "position_frames") as i32,
        peak_micro: word(vector, "fields", "peak_micro") as i32,
        transport_state: word(vector, "fields", "transport_state") as i32,
    };

    assert_eq!(as_bytes(&block), expected_bytes(vector), "encoding");
    assert_eq!(
        from_bytes::<MeterBlock>(&expected_bytes(vector)),
        block,
        "decoding"
    );
    assert_eq!(
        block.peak_micro, -1,
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

#[test]
fn unknown_command_codes_are_rejected() {
    assert_eq!(CommandKind::from_code(1), Some(CommandKind::Play));
    assert_eq!(CommandKind::from_code(0), None);
    assert_eq!(CommandKind::from_code(u32::MAX), None);
}
