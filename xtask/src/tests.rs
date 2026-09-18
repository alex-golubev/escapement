// SPDX-License-Identifier: AGPL-3.0-only
//
// The generator's own tests. They exist because the production schema uses one
// corner of what the schema language allows — scalar u32 fields, packed tight —
// so a break in any other corner is invisible until someone writes the command
// that needs it. Each test here is a bug that reached review once.

use crate::emit_ts;
use crate::schema::Schema;

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

fn ts_of(schema: &Schema) -> String {
    emit_ts::emit(schema, 0, 0)
}

/// `DataView.setUint8` takes two arguments. Passing the byte-order flag anyway
/// is not a harmless extra: `tsc` rejects the call, so the generated file did
/// not compile the moment any field was one byte wide.
#[test]
fn single_byte_accessors_take_no_byte_order_argument() {
    let schema = probe_schema(
        24,
        r#"{ name = "flags", type = "u8", offset = 0 }, { name = "tempo", type = "u32", offset = 4 }"#,
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
}
