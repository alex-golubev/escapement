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

/// The command writers reach the slot header by name and by width. Renaming
/// `kind` generated TypeScript that referred to an offset table entry which no
/// longer existed — a `tsc` error in a file nobody edits.
#[test]
fn the_slot_header_the_command_writers_address_is_required() {
    let renamed = VALID.replace(r#"name = "kind""#, r#"name = "opcode""#);
    let found = problems(&renamed);
    assert!(found.contains("has no field kind"), "{found}");

    let narrowed = VALID.replace(
        r#"{ name = "frame_offset", type = "u32", offset = 4 }"#,
        r#"{ name = "frame_offset", type = "u16", offset = 4 }"#,
    );
    let found = problems(&narrowed);
    assert!(
        found.contains("records.command_slot.frame_offset is u16"),
        "{found}"
    );
}

/// Records and commands were checked against each other; enums were not, and
/// nothing looked at the name the generator actually emits. `pub enum Probe`
/// beside `pub struct Probe` is a Rust error in generated code.
#[test]
fn two_names_that_would_generate_one_type_are_refused() {
    let clashing = format!("{VALID}\n[enums.probe]\nrunning = 1\n");
    let found = problems(&clashing);
    assert!(found.contains("both generate the type Probe"), "{found}");

    // The case that was already caught still is, through the same rule.
    let both = format!(
        "{VALID}\n[records.probe]\nsize = 4\nfields = [ {{ name = \"a\", type = \"u32\", offset = 0 }} ]\n"
    );
    let found = problems(&both);
    assert!(found.contains("both generate the type Probe"), "{found}");
}

/// A repeated export is a repeated member of the generated interface, which
/// TypeScript refuses, and a repeated entry in the list the host test uses.
#[test]
fn an_export_declared_twice_is_refused() {
    let twice = VALID.replace(
        "exports = []",
        r#"exports = [{ name = "init", returns = "u32" }, { name = "init", returns = "u32" }]"#,
    );
    let found = problems(&twice);
    assert!(found.contains("init is declared twice"), "{found}");
}

/// `check` promised every problem at once and then returned at the first
/// missing constant, so a schema with a typo in `[constants]` reported that and
/// nothing else, run after run.
#[test]
fn a_missing_constant_does_not_hide_the_rest_of_the_file() {
    let broken = VALID
        .replace("command_payload_size = 24", "")
        .replace("probe = 1", "probe = 1\nstop = 1");
    let found = problems(&broken);
    assert!(
        found.contains("constants.command_payload_size is missing"),
        "{found}"
    );
    assert!(found.contains("share the code 1"), "{found}");
}

/// The same for the record the whole boundary is built around.
#[test]
fn a_missing_command_slot_does_not_hide_the_rest_of_the_file() {
    let broken = VALID
        .replace("[records.command_slot]", "[records.other_block]")
        .replace("probe = 1", "probe = 1\nstop = 1");
    let found = problems(&broken);
    assert!(found.contains("records.command_slot is missing"), "{found}");
    assert!(found.contains("share the code 1"), "{found}");
}

/// Everything `check` refuses, and the sentence it refuses it with. These are
/// the rules the generator had from the start and never had a test for: the
/// schema is written by hand, so the message is the whole user interface.
#[test]
fn check_names_what_is_wrong() {
    let broken = |from: &str, to: &str| VALID.replace(from, to);
    let cases: Vec<(&str, String, &str)> = vec![
        (
            "the constants and the slot size disagree",
            broken("command_payload_size = 24", "command_payload_size = 16"),
            "but records.command_slot.size is 32",
        ),
        (
            "a slot that would misalign the next one",
            broken("size = 32", "size = 36"),
            "records.command_slot.size 36 is not a multiple of 8",
        ),
        (
            "a payload that does not start on eight",
            broken("command_payload_offset = 8", "command_payload_offset = 4"),
            "command_payload_offset 4 is not a multiple of 8",
        ),
        (
            "one name used twice in a record",
            broken(r#"name = "frame_offset""#, r#"name = "kind""#),
            "duplicate field name",
        ),
        (
            "an array of nothing",
            broken("count = 24", "count = 0"),
            "count is zero",
        ),
        (
            "a field that starts mid-word",
            broken(
                r#"{ name = "frame_offset", type = "u32", offset = 4 }"#,
                r#"{ name = "frame_offset", type = "u32", offset = 5 }"#,
            ),
            "is not aligned to 4 bytes",
        ),
        (
            "a command field past the end of the payload",
            broken(
                r#"{ name = "tempo", type = "u32", offset = 0 }"#,
                r#"{ name = "tempo", type = "u32", offset = 24 }"#,
            ),
            "but only 24 bytes are available",
        ),
        (
            "an atomic field Atomics cannot read",
            broken(
                r#"{ name = "kind", type = "u32", offset = 0 }"#,
                r#"{ name = "kind", type = "u32", offset = 0, atomic = true }"#,
            ),
            "an atomic field must be i32",
        ),
        (
            "an atomic field off a four-byte boundary",
            format!(
                "{VALID}\n[records.meters]\nsize = 6\nfields = [ {{ name = \"a\", type = \"u16\", offset = 0 }}, {{ name = \"b\", type = \"i32\", offset = 2, atomic = true }} ]\n"
            ),
            "an atomic field must be 4-byte aligned",
        ),
        (
            "an atomic array",
            broken(
                r#"{ name = "payload", type = "u8", count = 24, offset = 8 }"#,
                r#"{ name = "payload", type = "u8", count = 24, offset = 8, atomic = true }"#,
            ),
            "an atomic field cannot be an array",
        ),
        (
            "two fields over the same bytes",
            broken(
                r#"{ name = "frame_offset", type = "u32", offset = 4 }"#,
                r#"{ name = "frame_offset", type = "u32", offset = 0 }"#,
            ),
            "overlap kind at 0..4",
        ),
        (
            "a hole in a record",
            broken(
                "  { name = \"frame_offset\", type = \"u32\", offset = 4 },\n",
                "",
            ),
            "bytes 4..8 belong to no field",
        ),
        (
            "a record that does not fill its size",
            broken("count = 24, offset = 8", "count = 16, offset = 8"),
            "the fields cover 24 of 32 bytes",
        ),
        (
            "a shared record reached without Atomics",
            broken("size = 32", "size = 32\nshared = true"),
            "every field must be atomic",
        ),
        (
            "a payload no single field covers",
            broken(
                r#"{ name = "payload", type = "u8", count = 24, offset = 8 },"#,
                r#"{ name = "a", type = "u8", count = 12, offset = 8 }, { name = "b", type = "u8", count = 12, offset = 20 },"#,
            ),
            "has no field covering the payload at 8..32",
        ),
        (
            "a command the ring cannot name",
            broken("[commands.probe]", "[commands.halt]"),
            "commands.halt has no code in enums.command_kind",
        ),
        (
            "an atomic command field",
            broken(
                r#"{ name = "tempo", type = "u32", offset = 0 }"#,
                r#"{ name = "tempo", type = "i32", offset = 0, atomic = true }"#,
            ),
            "commands live in unshared memory and cannot be atomic",
        ),
        (
            "two enum variants on one code",
            broken("probe = 1", "probe = 1\nhalt = 1"),
            "share the code 1",
        ),
    ];

    // Report every case that does not hold, not the first: the point of the
    // function under test is the same point.
    let mut failures = Vec::new();
    for (what, source, expected) in &cases {
        let found = problems(source);
        if !found.contains(expected) {
            failures.push(format!("{what}: expected {expected:?}, got:\n{found}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
