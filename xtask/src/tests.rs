// SPDX-License-Identifier: AGPL-3.0-only
//
// The generator's own tests. The production schema uses one corner of what the
// schema language allows, so each test here is a bug that lived in another
// corner until review found it.

use crate::schema::Schema;
use crate::{emit_rust, emit_ts};
use std::collections::BTreeSet;

/// A schema with one command, `probe`, whose fields the test supplies.
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

/// A sound schema, for the tests that break exactly one thing in it.
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

/// The parse error, or everything `check` found, one problem per line.
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

/// Emitted as a scalar, this carried one element of the several it reserved —
/// on both sides, so even differential fuzzing would have passed it.
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
    // Four elements, four bytes apart, from the field's own offset.
    assert!(
        rust.contains("f32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]])"),
        "{rust}"
    );
    assert!(
        rust.contains("f32::from_le_bytes([payload[20], payload[21], payload[22], payload[23]])"),
        "{rust}"
    );

    assert!(ts.contains("gains: Float32Array"), "{ts}");
    assert!(ts.contains("for (let i = 0; i < 4; i++)"), "{ts}");
    assert!(
        ts.contains(
            "view.setFloat32(slot + COMMAND_PAYLOAD_OFFSET + 8 + i * 4, gains[i] ?? 0, true)"
        ),
        "{ts}"
    );
}

/// TypeScript still loops, and `* 1` there is noise in a file committed to be
/// read.
#[test]
fn a_byte_array_loops_without_identity_arithmetic() {
    let schema = probe_schema(
        24,
        "{ name = \"label\", type = \"u8\", count = 8, offset = 0 }",
        "",
    );
    let ts = ts_of(&schema);

    assert!(ts.contains("COMMAND_PAYLOAD_OFFSET + i,"), "{ts}");
    assert!(!ts.contains("i * 1"), "{ts}");
    assert!(!ts.contains("+ 0 + i"), "{ts}");
}

/// Indexing by a runtime value is a bounds check, and a bounds check on the
/// audio path is a panic that can reach the engine (ADR-0002). `protocol` is
/// under the workspace's real-time lints, so every index the generator emits is
/// a constant into an array of known length.
#[test]
fn the_generated_rust_indexes_only_by_constant() {
    let schema = probe_schema(
        24,
        "{ name = \"gains\", type = \"f32\", count = 4, offset = 0 }, { name = \"tag\", type = \"u8\", count = 8, offset = 16 }",
        "",
    );
    let rust = rust_of(&schema);

    for (at, _) in rust.match_indices("payload[") {
        let rest = &rust[at + "payload[".len()..];
        assert!(
            matches!(rest.chars().next(), Some(c) if c.is_ascii_digit()),
            "payload[{}… is not a constant index:\n{rust}",
            rest.chars().take(12).collect::<String>()
        );
    }
    assert!(rust.contains("tag: [payload[16], payload[17],"), "{rust}");
    assert!(rust.contains("payload[16] = self.tag[0];"), "{rust}");
}

/// `tsc` rejects `setUint8(offset, value, true)`, so the generated file failed
/// to compile the moment any field was one byte wide.
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
    assert!(ts.contains("return view.getUint8(base)"), "{ts}");
    assert!(ts.contains("view.setUint8(base, value)"), "{ts}");
    assert!(
        ts.contains("view.setUint32(slot + COMMAND_PAYLOAD_OFFSET + 4, tempo, true)"),
        "{ts}"
    );

    let rust = rust_of(&schema);
    assert!(rust.contains("flags: payload[0],"), "{rust}");
    assert!(rust.contains("payload[0] = self.flags;"), "{rust}");
}

/// A command may leave a gap: it is a value, so no offset is asserted for it
/// (ADR-0017). A record is a map of memory and keeps its assertions.
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
    assert!(
        rust.contains("payload[8], payload[9], payload[10], payload[11]"),
        "{rust}"
    );
    assert!(
        rust.contains("const _: () = assert!(offset_of!(CommandSlot, frame_offset) == 4);"),
        "{rust}"
    );
}

/// `derive(Default)` reaches arrays only up to 32 elements.
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

/// The arrays that fit keep the derive, so the written impl stays the exception.
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

/// serde ignores an unknown key by default, so a misspelling used to read as a
/// line the author never wrote.
#[test]
fn a_key_the_generator_does_not_know_is_refused() {
    let misspelled = VALID.replace("atomic", "atomik").replace(
        r#"{ name = "tempo", type = "u32", offset = 0 }"#,
        r#"{ name = "tempo", type = "u32", offset = 0, atomik = true }"#,
    );
    assert!(problems(&misspelled).contains("atomik"), "{misspelled}");
}

/// The dangerous shape of it: `sharred = true` left the record unshared and
/// every atomic rule unapplied, without a word.
#[test]
fn a_misspelled_flag_is_not_read_as_an_absent_one() {
    let misspelled = VALID.replace("size = 32\n", "size = 32\nsharred = true\n");
    assert!(problems(&misspelled).contains("sharred"), "{misspelled}");
}

/// `major = 256` used to shift straight out of the version word, and only a
/// TypeScript assertion noticed, at run time.
#[test]
fn an_abi_major_that_does_not_fit_its_byte_is_refused() {
    let too_big = VALID.replace("major = 0", "major = 256");
    let found = problems(&too_big);
    assert!(found.contains("abi.major is 256"), "{found}");

    let biggest = VALID.replace("major = 0", "major = 255");
    assert_eq!(problems(&biggest), "", "255 still fits");
}

/// Renaming `kind` used to generate TypeScript referring to an offset table
/// entry that no longer existed.
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

/// Enums were not checked against anything, and nothing looked at the name the
/// generator actually emits.
#[test]
fn two_names_that_would_generate_one_type_are_refused() {
    let clashing = format!("{VALID}\n[enums.probe]\nrunning = 1\n");
    let found = problems(&clashing);
    assert!(
        found.contains("both generate the Rust name Probe"),
        "{found}"
    );

    let both = format!(
        "{VALID}\n[records.probe]\nsize = 4\nfields = [ {{ name = \"a\", type = \"u32\", offset = 0 }} ]\n"
    );
    let found = problems(&both);
    assert!(
        found.contains("both generate the Rust name Probe"),
        "{found}"
    );
}

/// A repeated export is a repeated member of the generated interface.
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
/// missing constant.
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

/// Everything `check` refuses, and the sentence it refuses it with. The schema
/// is written by hand, so the message is the whole user interface.
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

    let mut failures = Vec::new();
    for (what, source, expected) in &cases {
        let found = problems(source);
        if !found.contains(expected) {
            failures.push(format!("{what}: expected {expected:?}, got:\n{found}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// A slot is reused, and the golden vectors assert zeros in the payload — a
/// promise nothing kept while a writer set only its own fields.
#[test]
fn a_command_writer_fills_the_whole_payload() {
    let schema = probe_schema(24, r#"{ name = "tempo", type = "u32", offset = 0 }"#, "");
    assert!(
        rust_of(&schema).contains("*payload = [0u8; COMMAND_PAYLOAD_SIZE];"),
        "{}",
        rust_of(&schema)
    );
    assert!(
        ts_of(&schema).contains("for (let i = 0; i < COMMAND_PAYLOAD_SIZE; i += 4) {"),
        "{}",
        ts_of(&schema)
    );

    // The case that matters most: this used to write nothing at all.
    let empty = probe_schema(24, "", "");
    assert!(
        rust_of(&empty).contains("*payload = [0u8; COMMAND_PAYLOAD_SIZE];"),
        "{}",
        rust_of(&empty)
    );
    assert!(
        ts_of(&empty).contains("view.setUint32(slot + COMMAND_PAYLOAD_OFFSET + i, 0, true)"),
        "{}",
        ts_of(&empty)
    );
}

/// The cold-path read of ADR-0018: a snapshot that delegates to the free
/// functions, taking only the arrays its fields need, and no class anywhere.
#[test]
fn a_record_gets_a_snapshot_reader() {
    let schema = probe_schema(
        24,
        r#"{ name = "tempo", type = "u32", offset = 0 }"#,
        r#"
[records.meters]
size = 8
shared = true
fields = [
  { name = "level", type = "i32", offset = 0, atomic = true },
  { name = "peak", type = "i32", offset = 4, atomic = true },
]

[records.mixed]
size = 8
fields = [
  { name = "flag", type = "u32", offset = 0 },
  { name = "count", type = "i32", offset = 4, atomic = true },
]
"#,
    );
    let ts = ts_of(&schema);

    assert!(!ts.contains("class"), "{ts}");
    assert!(
        ts.contains("export function readMeters(atoms: Int32Array, base: number) {"),
        "{ts}"
    );
    assert!(ts.contains("level: loadMetersLevel(atoms, base),"), "{ts}");
    assert!(ts.contains("peak: loadMetersPeak(atoms, base),"), "{ts}");

    // A record with both kinds of field needs both arrays.
    assert!(
        ts.contains("export function readMixed(view: DataView, atoms: Int32Array, base: number) {"),
        "{ts}"
    );
    assert!(ts.contains("count: loadMixedCount(atoms, base),"), "{ts}");
    assert!(ts.contains("flag: readMixedFlag(view, base),"), "{ts}");

    // The payload is an array: nothing to delegate to, so it is not in the snapshot.
    assert!(
        ts.contains("export function readCommandSlot(view: DataView, base: number) {"),
        "{ts}"
    );
    assert!(!ts.contains("payload: readCommandSlotPayload"), "{ts}");
}

/// The identifiers a generated file declares at its top level.
fn declared(source: &str, visibility: &str, keywords: &[&str]) -> BTreeSet<String> {
    source
        .lines()
        .filter_map(|line| {
            let (keyword, rest) = line.strip_prefix(visibility)?.split_once(' ')?;
            if !keywords.contains(&keyword) {
                return None;
            }
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

/// `rust_names` and `ts_names` are what the collision check reads, so a name an
/// emitter writes and a list does not know is a hole in the check. Rather than
/// trust the two to stay in step, compare them.
#[test]
fn the_name_lists_match_what_the_emitters_write() {
    let schema = probe_schema(
        24,
        "{ name = \"tempo\", type = \"u32\", offset = 0 }, { name = \"tag\", type = \"u8\", count = 8, offset = 8 }",
        "
[records.meters]
size = 8
shared = true
fields = [
  { name = \"level\", type = \"i32\", offset = 0, atomic = true },
  { name = \"peak\", type = \"i32\", offset = 4, atomic = true },
]
",
    );

    let listed: BTreeSet<String> = schema
        .ts_names()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let written = declared(
        &ts_of(&schema),
        "export ",
        &["function", "class", "const", "type", "interface"],
    );
    assert_eq!(written, listed, "TypeScript");

    let listed: BTreeSet<String> = schema
        .rust_names()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let written = declared(&rust_of(&schema), "pub ", &["const", "enum", "struct"]);
    assert_eq!(written, listed, "Rust");
}

/// An accessor's name is a record's name and a field's name run together, so two
/// records can reach the same one without sharing a type name.
#[test]
fn two_accessors_with_one_name_are_refused() {
    let clashing = format!(
        "{VALID}
[records.meter]
size = 4
fields = [ {{ name = \"block_counter\", type = \"i32\", offset = 0 }} ]

[records.meter_block]
size = 4
fields = [ {{ name = \"counter\", type = \"i32\", offset = 0 }} ]
"
    );
    let found = problems(&clashing);
    assert!(
        found.contains("both generate the TypeScript name readMeterBlockCounter"),
        "{found}"
    );
}

/// `VALID` with prose on one of everything the schema can describe.
fn documented() -> String {
    VALID
        .replace(
            "command_payload_size = 24",
            r#"command_payload_size = { value = 24, doc = "Bytes a command may use." }"#,
        )
        .replace(
            "probe = 1",
            r#"probe = { value = 1, doc = "The only kind these tests have." }"#,
        )
        .replace("size = 32\n", "size = 32\ndoc = \"A slot in the ring.\"\n")
        .replace(
            r#"{ name = "kind", type = "u32", offset = 0 }"#,
            r#"{ name = "kind", type = "u32", offset = 0, doc = "The command this slot carries." }"#,
        )
        .replace(
            "[commands.probe]\n",
            "[commands.probe]\ndoc = \"The command these tests write.\"\n",
        )
        .replace(
            r#"{ name = "tempo", type = "u32", offset = 0 }"#,
            r#"{ name = "tempo", type = "u32", offset = 0, doc = "Micro-BPM." }"#,
        )
}

fn parse(source: &str) -> Schema {
    let schema: Schema = toml::from_str(source).expect("the fixture parses");
    if let Err(problems) = schema.check() {
        panic!("the fixture should be consistent, but: {problems:?}");
    }
    schema
}

/// A unit is not a layout: no vector catches a peak published in dBFS and read
/// as an amplitude. The prose that says which one it is has to reach the place
/// where the value is used, and in a TOML comment it reaches nobody.
#[test]
fn schema_prose_reaches_both_languages() {
    let schema = parse(&documented());
    let rust = rust_of(&schema);
    let ts = ts_of(&schema);

    for expected in [
        "/// Bytes a command may use.\npub const COMMAND_PAYLOAD_SIZE",
        "    /// The only kind these tests have.\n    Probe = 1,",
        "/// A slot in the ring.\n#[repr(C)]",
        "    /// The command this slot carries.\n    pub kind: u32,",
        "/// The command these tests write.\n/// Command `probe`",
        "    /// Micro-BPM.\n    pub tempo: u32,",
    ] {
        assert!(rust.contains(expected), "missing {expected:?} in:\n{rust}");
    }

    for expected in [
        "/** Bytes a command may use. */\nexport const COMMAND_PAYLOAD_SIZE",
        "  /** The only kind these tests have. */\n  probe: 1,",
        "/**\n * A slot in the ring.\n *\n * Byte offsets of the fields of `command_slot`.\n */",
        "  /** The command this slot carries. */\n  kind: 0,",
        " * @param tempo - Micro-BPM.",
    ] {
        assert!(ts.contains(expected), "missing {expected:?} in:\n{ts}");
    }

    // This file is the Apache-licensed surface a plugin author builds against
    // (ADR-0008, NOTICE), so the prose stands over each accessor a caller
    // reaches for, reader and writer alike, rather than once out of hover's way.
    let over = concat!(
        " * The command this slot carries.\n",
        " * @param view - A view over the memory `command_slot` lives in.\n",
        " * @param base - Byte offset of the record inside that memory.\n"
    );
    for expected in [
        format!("{over} */\nexport function readCommandSlotKind"),
        format!(
            "{over} * @param value - The value to write.\n */\nexport function writeCommandSlotKind"
        ),
    ] {
        assert!(ts.contains(&expected), "missing {expected:?} in:\n{ts}");
    }
}

/// rustfmt does not rewrap a doc comment and the generated TypeScript is not
/// formatted at all, so the schema's line breaks are the only ones there are.
#[test]
fn a_doc_of_several_lines_keeps_its_line_breaks() {
    let source = VALID.replace(
        "[commands.probe]\n",
        "[commands.probe]\ndoc = \"\"\"\nFirst.\n\nSecond.\"\"\"\n",
    );
    let schema = parse(&source);

    assert!(
        rust_of(&schema).contains("/// First.\n///\n/// Second.\n"),
        "{}",
        rust_of(&schema)
    );
    // The block runs on into the writer's own line and its parameters, so the
    // closing `*/` is not what follows.
    assert!(
        ts_of(&schema).contains("/**\n * First.\n *\n * Second.\n"),
        "{}",
        ts_of(&schema)
    );
}

/// The ABI version is what the boundary is, not how the file is written. A
/// bumped version tells every plugin author that an offset moved, so editing a
/// comment must not move it.
#[test]
fn prose_is_not_part_of_the_abi() {
    assert_ne!(documented(), VALID, "the fixture documents something");
    assert_eq!(
        crate::abi_hash(&parse(VALID)),
        crate::abi_hash(&parse(&documented())),
    );
}

/// A documented value is a table, and an untagged enum would have reported a
/// misspelled key in it as a value matching no shape — the same silence
/// `deny_unknown_fields` exists to break.
#[test]
fn a_misspelled_key_beside_a_doc_is_refused() {
    let misspelled = VALID.replace("probe = 1", r#"probe = { value = 1, dock = "why" }"#);
    assert!(problems(&misspelled).contains("dock"), "{misspelled}");
}

/// The offset was all TypeScript got, so the length of the region it points at
/// was written by hand on that side — the one number the schema exists to keep
/// both sides from choosing separately.
#[test]
fn a_record_array_gets_its_length_and_a_view() {
    let schema = probe_schema(
        24,
        r#"{ name = "tempo", type = "u32", offset = 0 }"#,
        r#"
[records.block]
size = 32
fields = [
  { name = "samples", type = "f32", count = 8, offset = 0 },
]
"#,
    );
    let ts = ts_of(&schema);

    for expected in [
        "export const BLOCK_SAMPLES_LENGTH = 8",
        "export function blockSamples(buffer: ArrayBufferLike, base: number): Float32Array {",
        "return new Float32Array(buffer, base, BLOCK_SAMPLES_LENGTH)",
        "`base` must be a multiple of 4.",
        "export const COMMAND_SLOT_PAYLOAD_LENGTH = 24",
        "return new Uint8Array(buffer, base + 8, COMMAND_SLOT_PAYLOAD_LENGTH)",
    ] {
        assert!(ts.contains(expected), "missing {expected:?} in:\n{ts}");
    }

    // A byte has no alignment to demand.
    assert!(!ts.contains("multiple of 1"), "{ts}");
}

/// Two blocks above one declaration: TypeScript attaches the one that touches
/// it and the other is text nothing reads, so the command's own prose was
/// invisible in every editor. The writer also documented one argument of four.
#[test]
fn a_command_writer_carries_one_block_and_every_parameter() {
    let source = VALID
        .replace(
            "[commands.probe]\n",
            "[commands.probe]\ndoc = \"What the probe does.\"\n",
        )
        .replace(
            r#"{ name = "tempo", type = "u32", offset = 0 }"#,
            r#"{ name = "tempo", type = "u32", offset = 0, doc = "Micro-BPM." }"#,
        )
        .replace(
            r#"{ name = "frame_offset", type = "u32", offset = 4 }"#,
            r#"{ name = "frame_offset", type = "u32", offset = 4, doc = "Where in the block it lands." }"#,
        );
    let ts = ts_of(&parse(&source));

    assert!(!ts.contains("*/\n/**"), "one block per declaration:\n{ts}");
    for expected in [
        " * What the probe does.\n *\n * Writes a complete `probe` slot",
        " * @param view - ",
        " * @param slot - ",
        " * @param frameOffset - Where in the block it lands.",
        " * @param tempo - Micro-BPM.",
    ] {
        assert!(ts.contains(expected), "missing {expected:?} in:\n{ts}");
    }
}
