// SPDX-License-Identifier: AGPL-3.0-only
//
// The generator's own tests. They exist because the production schema uses one
// corner of what the schema language allows — scalar u32 fields, packed tight —
// so a break in any other corner is invisible until someone writes the command
// that needs it. Each test here is a bug that reached review once.

use crate::schema::Schema;
use crate::{emit_rust, emit_ts};

/// A schema with one command, `probe`, whose fields the test supplies. Nothing
/// here is load-bearing beyond satisfying `check`: the interest is in what the
/// emitters do with `fields`.
fn probe_schema(payload_size: usize, fields: &str, extra: &str) -> Schema {
    let slot_size = 8 + payload_size;
    let source = format!(
        r#"
# A top-level key has to precede the first table header, or TOML reads it as
# part of that table.
exports = []

[abi]
major = 0

[constants]
command_payload_offset = 8
command_payload_size = {payload_size}

[enums.command_kind]
probe = 1

[records.command_slot]
size = {slot_size}
fields = [
  {{ name = "kind", type = "u32", offset = 0 }},
  {{ name = "frame_offset", type = "u32", offset = 4 }},
  {{ name = "payload", type = "u8", count = {payload_size}, offset = 8 }},
]

[commands.probe]
fields = [{fields}]
{extra}
"#
    );
    let schema: Schema = toml::from_str(&source).expect("the fixture parses");
    if let Err(problems) = schema.check() {
        panic!("the fixture should be consistent, but: {problems:?}");
    }
    schema
}

/// A schema with nothing wrong with it, in one piece, so that a test can break
/// exactly one thing in it and say what it expects to hear back.
const VALID: &str = r#"
exports = []

[abi]
major = 0

[constants]
command_payload_offset = 8
command_payload_size = 24

[enums.command_kind]
probe = 1

[records.command_slot]
size = 32
fields = [
  { name = "kind", type = "u32", offset = 0 },
  { name = "frame_offset", type = "u32", offset = 4 },
  { name = "payload", type = "u8", count = 24, offset = 8 },
]

[commands.probe]
fields = [{ name = "tempo", type = "u32", offset = 0 }]
"#;

/// What the generator says about a schema: the parse error if it does not
/// parse, otherwise everything `check` found, one problem per line.
fn problems(source: &str) -> String {
    match toml::from_str::<Schema>(source) {
        Err(error) => error.to_string(),
        Ok(schema) => match schema.check() {
            Ok(()) => String::new(),
            Err(found) => found.join("\n"),
        },
    }
}

fn rust_of(schema: &Schema) -> String {
    emit_rust::emit(schema, 0, 0)
}

fn ts_of(schema: &Schema) -> String {
    emit_ts::emit(schema, 0, 0)
}

/// A field with a count reserves `count * size` bytes. Emitting it as a scalar
/// compiled on both sides and carried the first element only, which no test and
/// no differential fuzzer would have caught: both halves were wrong together.
#[test]
fn a_command_array_carries_every_byte_it_reserves() {
    let schema = probe_schema(
        24,
        "{ name = \"gains\", type = \"f32\", count = 4, offset = 8 }",
        "",
    );
    let rust = rust_of(&schema);
    let ts = ts_of(&schema);

    assert!(rust.contains("pub gains: [f32; 4],"), "{rust}");
    assert!(!rust.contains("pub gains: f32,"), "{rust}");
    // Four elements, four bytes apart, starting at the field's own offset.
    assert!(rust.contains("let mut out = [0f32; 4];"), "{rust}");
    assert!(rust.contains("let at = 8 + i * 4;"), "{rust}");

    assert!(ts.contains("gains: Float32Array"), "{ts}");
    assert!(ts.contains("for (let i = 0; i < 4; i++)"), "{ts}");
    assert!(
        ts.contains(
            "view.setFloat32(slot + COMMAND_PAYLOAD_OFFSET + 8 + i * 4, gains[i] ?? 0, true)"
        ),
        "{ts}"
    );
}

/// The stride and the offset are both dropped from the expression when they
/// would read `* 1` or `+ 0`; clippy denies the first and CI runs it with
/// `-D warnings`, and the second is noise in a file meant to be read.
#[test]
fn a_byte_array_indexes_without_identity_arithmetic() {
    let schema = probe_schema(
        24,
        "{ name = \"label\", type = \"u8\", count = 8, offset = 0 }",
        "",
    );
    let rust = rust_of(&schema);
    let ts = ts_of(&schema);

    assert!(rust.contains("let at = i;"), "{rust}");
    assert!(!rust.contains("i * 1"), "{rust}");
    assert!(!rust.contains("0 + i"), "{rust}");
    assert!(ts.contains("COMMAND_PAYLOAD_OFFSET + i,"), "{ts}");
    assert!(!ts.contains("i * 1"), "{ts}");
}

/// `DataView.setUint8` takes two arguments. Passing the byte-order flag anyway
/// is not a harmless extra: `tsc` rejects the call, so the generated file did
/// not compile the moment any field was one byte wide.
#[test]
fn single_byte_accessors_take_no_byte_order_argument() {
    let schema = probe_schema(
        24,
        "{ name = \"flags\", type = \"u8\", offset = 0 }, { name = \"tempo\", type = \"u32\", offset = 4 }",
        r#"
[records.probe_byte]
size = 1
fields = [ { name = "level", type = "u8", offset = 0 } ]
"#,
    );
    let ts = ts_of(&schema);

    assert!(
        ts.contains("view.setUint8(slot + COMMAND_PAYLOAD_OFFSET, flags)"),
        "{ts}"
    );
    assert!(
        !ts.contains("getUint8(slot + COMMAND_PAYLOAD_OFFSET, true)"),
        "{ts}"
    );
    // A record's own single-byte accessor answers the same way.
    assert!(ts.contains("return view.getUint8(base)"), "{ts}");
    assert!(ts.contains("view.setUint8(base, value)"), "{ts}");
    // And everything wider still says which end it is writing from.
    assert!(
        ts.contains("view.setUint32(slot + COMMAND_PAYLOAD_OFFSET + 4, tempo, true)"),
        "{ts}"
    );

    // The Rust side reads a lone byte directly: from_le_bytes on one byte is
    // ceremony around an index.
    let rust = rust_of(&schema);
    assert!(rust.contains("flags: payload[0],"), "{rust}");
    assert!(rust.contains("payload[0] = self.flags;"), "{rust}");
}

/// A command may leave a gap — to reserve payload for a field that does not
/// exist yet, or simply because its author chose the offsets that way. The
/// struct is a value and its Rust layout means nothing, so no offset is
/// asserted for it (ADR-0017). Records are the opposite and keep theirs.
#[test]
fn a_command_may_leave_a_gap_and_asserts_no_layout() {
    let schema = probe_schema(
        24,
        "{ name = \"tempo\", type = \"u32\", offset = 0 }, { name = \"ramp\", type = \"u32\", offset = 8 }",
        "",
    );
    let rust = rust_of(&schema);

    assert!(
        rust.contains("const _: () = assert!(size_of::<Probe>() <= 24);"),
        "{rust}"
    );
    assert!(!rust.contains("offset_of!(Probe"), "{rust}");
    // read and write still use the schema's offsets, gap and all.
    assert!(
        rust.contains("payload[8], payload[9], payload[10], payload[11]"),
        "{rust}"
    );
    // The record next to it is a map of memory and still says so.
    assert!(
        rust.contains("const _: () = assert!(offset_of!(CommandSlot, frame_offset) == 4);"),
        "{rust}"
    );
}

/// `derive(Default)` reaches arrays only up to 32 elements. A longer one has to
/// have the impl written out, or the generated file stops compiling for a
/// reason that has nothing to do with the schema.
#[test]
fn a_long_array_gets_a_written_default() {
    let schema = probe_schema(
        48,
        "{ name = \"name\", type = \"u8\", count = 40, offset = 0 }",
        "",
    );
    let rust = rust_of(&schema);

    assert!(rust.contains("impl Default for Probe"), "{rust}");
    assert!(rust.contains("name: [0u8; 40],"), "{rust}");
    assert!(
        rust.contains("#[derive(Clone, Copy, PartialEq, Debug)]"),
        "{rust}"
    );
}

/// The short arrays that fit keep the derive, so the written impl stays the
/// exception rather than noise on every command.
#[test]
fn a_short_array_keeps_the_derived_default() {
    let schema = probe_schema(
        24,
        "{ name = \"name\", type = \"u8\", count = 8, offset = 0 }",
        "",
    );
    let rust = rust_of(&schema);

    assert!(!rust.contains("impl Default for Probe"), "{rust}");
    assert!(
        rust.contains("#[derive(Clone, Copy, PartialEq, Debug, Default)]"),
        "{rust}"
    );
}

#[test]
fn the_base_schema_of_these_tests_is_sound() {
    assert_eq!(problems(VALID), "", "the schema the tests below break");
}

/// serde ignores an unknown key by default, so a misspelling in the one file
/// that defines the boundary used to read as a line the author never wrote.
#[test]
fn a_key_the_generator_does_not_know_is_refused() {
    let misspelled = VALID.replace("atomic", "atomik").replace(
        r#"{ name = "tempo", type = "u32", offset = 0 }"#,
        r#"{ name = "tempo", type = "u32", offset = 0, atomik = true }"#,
    );
    assert!(problems(&misspelled).contains("atomik"), "{misspelled}");
}

/// The dangerous shape of the same bug: a flag whose absence turns a check off.
/// `sharred = true` left `records.command_slot` unshared and every atomic rule
/// unapplied, and said nothing.
#[test]
fn a_misspelled_flag_is_not_read_as_an_absent_one() {
    let misspelled = VALID.replace("size = 32\n", "size = 32\nsharred = true\n");
    assert!(problems(&misspelled).contains("sharred"), "{misspelled}");
}

/// `major = 256` used to shift straight out of the version word: ABI_MAJOR said
/// 256, ABI_VERSION reported 0, and only a TypeScript assertion noticed, at run
/// time, in a file nobody reads when editing a schema.
#[test]
fn an_abi_major_that_does_not_fit_its_byte_is_refused() {
    let too_big = VALID.replace("major = 0", "major = 256");
    let found = problems(&too_big);
    assert!(found.contains("abi.major is 256"), "{found}");

    let biggest = VALID.replace("major = 0", "major = 255");
    assert_eq!(problems(&biggest), "", "255 still fits");
}
