// SPDX-License-Identifier: AGPL-3.0-only
//
// The schema as parsed, and the checks that make writing offsets by hand safe.
// Nothing here computes a layout: every offset in the file is taken as given
// and only tested for alignment, overlap and fit (ADR-0013).
//
// Every struct below refuses a key it does not know. The schema is the single
// source for the boundary, and a key serde quietly ignores is a line the author
// believes they wrote.

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    pub abi: Abi,
    pub constants: BTreeMap<String, u64>,
    pub enums: BTreeMap<String, BTreeMap<String, u32>>,
    pub records: BTreeMap<String, Record>,
    pub commands: BTreeMap<String, Command>,
    pub exports: Vec<Export>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Abi {
    pub major: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub size: usize,
    #[serde(default)]
    pub shared: bool,
    pub fields: Vec<Field>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub fields: Vec<Field>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
    pub offset: usize,
    #[serde(default = "one")]
    pub count: usize,
    #[serde(default)]
    pub atomic: bool,
}

fn one() -> usize {
    1
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Type {
    U8,
    U16,
    U32,
    I32,
    F32,
    F64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Export {
    pub name: String,
    #[serde(default)]
    pub kind: ExportKind,
    #[serde(default)]
    pub params: Vec<Param>,
    pub returns: Option<Type>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
}

#[derive(Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    #[default]
    Function,
    Memory,
}

impl Type {
    pub fn size(self) -> usize {
        match self {
            Type::U8 => 1,
            Type::U16 => 2,
            Type::U32 | Type::I32 | Type::F32 => 4,
            Type::F64 => 8,
        }
    }

    /// The spelling the schema uses. The ABI hash is taken over these, not
    /// over Rust's Debug output, so that renaming a variant of this enum does
    /// not move an ABI version that plugins depend on.
    pub fn schema_name(self) -> &'static str {
        match self {
            Type::U8 => "u8",
            Type::U16 => "u16",
            Type::U32 => "u32",
            Type::I32 => "i32",
            Type::F32 => "f32",
            Type::F64 => "f64",
        }
    }

    pub fn rust(self) -> &'static str {
        match self {
            Type::U8 => "u8",
            Type::U16 => "u16",
            Type::U32 => "u32",
            Type::I32 => "i32",
            Type::F32 => "f32",
            Type::F64 => "f64",
        }
    }

    /// A zero of this type, spelled so that it needs no inference: `[0u8; 4]`
    /// carries its own type where `[0; 4]` would not.
    pub fn rust_zero(self) -> &'static str {
        match self {
            Type::U8 => "0u8",
            Type::U16 => "0u16",
            Type::U32 => "0u32",
            Type::I32 => "0i32",
            Type::F32 => "0f32",
            Type::F64 => "0f64",
        }
    }

    /// The DataView accessor suffix, e.g. `getUint32` / `setUint32`.
    pub fn view_suffix(self) -> &'static str {
        match self {
            Type::U8 => "Uint8",
            Type::U16 => "Uint16",
            Type::U32 => "Uint32",
            Type::I32 => "Int32",
            Type::F32 => "Float32",
            Type::F64 => "Float64",
        }
    }

    /// `getUint8` and `setUint8` take no byte-order argument, because one byte
    /// has no byte order. Every other accessor takes it and the generated code
    /// always passes it (ADR-0013). Handing a third argument to `setUint8` is
    /// not a harmless extra: TypeScript rejects the call.
    pub fn view_takes_endianness(self) -> bool {
        self.size() > 1
    }

    pub fn ts_array(self) -> &'static str {
        match self {
            Type::U8 => "Uint8Array",
            Type::U16 => "Uint16Array",
            Type::U32 => "Uint32Array",
            Type::I32 => "Int32Array",
            Type::F32 => "Float32Array",
            Type::F64 => "Float64Array",
        }
    }
}

impl Field {
    pub fn bytes(&self) -> usize {
        self.ty.size() * self.count
    }

    pub fn end(&self) -> usize {
        self.offset + self.bytes()
    }

    pub fn is_array(&self) -> bool {
        self.count != 1
    }

    /// The spelling of this field in Rust. Records and commands ask the same
    /// question and must get the same answer: a field that answered `u8` for a
    /// count of eight would carry one byte of the eight the schema reserved.
    pub fn rust_type(&self) -> String {
        if self.is_array() {
            format!("[{}; {}]", self.ty.rust(), self.count)
        } else {
            self.ty.rust().to_owned()
        }
    }

    pub fn rust_zero(&self) -> String {
        if self.is_array() {
            format!("[{}; {}]", self.ty.rust_zero(), self.count)
        } else {
            self.ty.rust_zero().to_owned()
        }
    }

    /// An array field is passed as the typed array of its element type, never
    /// as a single number.
    pub fn ts_type(&self) -> &'static str {
        if self.is_array() {
            self.ty.ts_array()
        } else {
            "number"
        }
    }

    /// `derive(Default)` covers arrays only up to 32 elements, so a longer one
    /// needs the impl written out. Asking here keeps that std detail in one
    /// place instead of in the emitter's head.
    pub fn needs_written_default(&self) -> bool {
        self.is_array() && self.count > 32
    }
}

impl Schema {
    pub fn constant(&self, name: &str) -> Result<usize, String> {
        self.constants
            .get(name)
            .map(|v| *v as usize)
            .ok_or_else(|| format!("constants.{name} is missing"))
    }

    /// Every problem at once: a generator that reports one error per run
    /// turns a schema edit into a guessing game.
    pub fn check(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        // The version word is the major number in its top byte and the schema
        // hash in the rest, so a major that does not fit a byte is not a large
        // version: it is a shifted-out one, and the engine would answer a
        // number no plugin could match.
        if self.abi.major > 0xff {
            errors.push(format!(
                "abi.major is {}, but the ABI version word gives it one byte (0 to 255)",
                self.abi.major
            ));
        }

        let payload_offset = self.constant("command_payload_offset");
        let payload_size = self.constant("command_payload_size");
        for missing in [&payload_offset, &payload_size] {
            if let Err(message) = missing {
                errors.push(message.clone());
            }
        }
        let Some(slot) = self.records.get("command_slot") else {
            errors.push("records.command_slot is missing".to_owned());
            return Err(errors);
        };
        let slot_size = slot.size;

        // Every command writer spells the slot header out: the TypeScript one
        // writes `CommandSlotOffsets.kind` with `setUint32`. Renaming either
        // field, or narrowing it, used to generate a file that does not
        // compile, so the dependency is stated here rather than assumed there.
        for (header, expected) in [("kind", Type::U32), ("frame_offset", Type::U32)] {
            match slot.fields.iter().find(|field| field.name == header) {
                None => errors.push(format!(
                    "records.command_slot has no field {header}, which every command writer addresses by name"
                )),
                Some(field) if field.is_array() => errors.push(format!(
                    "records.command_slot.{header} has a count of {}, but the command writers address it as one value",
                    field.count
                )),
                Some(field) if field.ty != expected => errors.push(format!(
                    "records.command_slot.{header} is {}, but the command writers address it as {}",
                    field.ty.schema_name(),
                    expected.schema_name()
                )),
                Some(_) => {}
            }
        }

        let (Ok(payload_offset), Ok(payload_size)) = (payload_offset, payload_size) else {
            return Err(errors);
        };

        if payload_offset + payload_size != slot_size {
            errors.push(format!(
                "command_payload_offset + command_payload_size is {}, but records.command_slot.size is {slot_size}",
                payload_offset + payload_size
            ));
        }
        // Slots sit next to each other in the ring, so a slot that is not a
        // multiple of 8 would misalign every field of the following slot.
        if !slot_size.is_multiple_of(8) {
            errors.push(format!(
                "records.command_slot.size {slot_size} is not a multiple of 8"
            ));
        }
        if !payload_offset.is_multiple_of(8) {
            errors.push(format!(
                "command_payload_offset {payload_offset} is not a multiple of 8"
            ));
        }

        for (name, record) in &self.records {
            check_fields(
                &mut errors,
                &format!("records.{name}"),
                &record.fields,
                0,
                record.size,
            );
            // A record is a map of memory, and the emitted struct has only the
            // fields declared here. A hole would make rustc compute a smaller
            // struct than the schema claims, which the generated assertion
            // would report as a size mismatch without naming the cause.
            check_tiling(
                &mut errors,
                &format!("records.{name}"),
                &record.fields,
                record.size,
            );
            if record.shared {
                for field in &record.fields {
                    if !field.atomic {
                        errors.push(format!(
                            "records.{name}.{}: a shared record is published with Atomics, so every field must be atomic",
                            field.name
                        ));
                    }
                }
            }
        }

        // The payload region is declared twice — once as a pair of constants and
        // once as the field that occupies it — so the two must be checked
        // against each other or they will drift apart.
        if !slot
            .fields
            .iter()
            .any(|field| field.offset == payload_offset && field.bytes() == payload_size)
        {
            errors.push(format!(
                "records.command_slot has no field covering the payload at {payload_offset}..{}, which command_payload_offset and command_payload_size declare",
                payload_offset + payload_size
            ));
        }

        for name in self.commands.keys() {
            if self.records.contains_key(name) {
                errors.push(format!(
                    "{name} is both a record and a command, and the two would generate the same type"
                ));
            }
        }

        let kinds = self.enums.get("command_kind");
        for (name, command) in &self.commands {
            if kinds.is_none_or(|k| !k.contains_key(name)) {
                errors.push(format!("commands.{name} has no code in enums.command_kind"));
            }
            check_fields(
                &mut errors,
                &format!("commands.{name}"),
                &command.fields,
                payload_offset,
                payload_size,
            );
            for field in &command.fields {
                if field.atomic {
                    errors.push(format!(
                        "commands.{name}.{}: commands live in unshared memory and cannot be atomic",
                        field.name
                    ));
                }
            }
        }

        for (name, values) in &self.enums {
            let mut seen = BTreeMap::new();
            for (variant, value) in values {
                if let Some(other) = seen.insert(*value, variant) {
                    errors.push(format!(
                        "enums.{name}: {variant} and {other} share the code {value}"
                    ));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

/// Records have no implicit padding: the fields must cover the declared size
/// exactly, with nothing left over at either end.
fn check_tiling(errors: &mut Vec<String>, what: &str, fields: &[Field], size: usize) {
    let mut ordered: Vec<&Field> = fields.iter().collect();
    ordered.sort_by_key(|field| field.offset);

    let mut covered = 0;
    for field in ordered {
        if field.offset > covered {
            errors.push(format!(
                "{what}: bytes {covered}..{} belong to no field, and the generated struct would be smaller than {size} bytes",
                field.offset
            ));
        }
        covered = covered.max(field.end());
    }
    if covered < size {
        errors.push(format!(
            "{what}: the fields cover {covered} of {size} bytes; either a field is missing or the size is wrong"
        ));
    }
}

/// `base` is where the record starts inside the containing memory, which for a
/// command payload is not zero: alignment has to be judged from there.
fn check_fields(
    errors: &mut Vec<String>,
    what: &str,
    fields: &[Field],
    base: usize,
    capacity: usize,
) {
    let mut seen_names: Vec<&str> = Vec::new();
    let mut occupied: Vec<(usize, usize, &str)> = Vec::new();

    for field in fields {
        let where_ = format!("{what}.{}", field.name);

        if seen_names.contains(&field.name.as_str()) {
            errors.push(format!("{where_}: duplicate field name"));
        }
        seen_names.push(&field.name);

        if field.count == 0 {
            errors.push(format!("{where_}: count is zero"));
        }

        let align = field.ty.size();
        if !(base + field.offset).is_multiple_of(align) {
            errors.push(format!(
                "{where_}: offset {} is not aligned to {align} bytes (the record starts at {base})",
                field.offset
            ));
        }

        if field.end() > capacity {
            errors.push(format!(
                "{where_}: ends at {} but only {capacity} bytes are available",
                field.end()
            ));
        }

        if field.atomic {
            if field.ty != Type::I32 {
                errors.push(format!(
                    "{where_}: an atomic field must be i32, because Atomics reads it through an Int32Array"
                ));
            }
            if !(base + field.offset).is_multiple_of(4) {
                errors.push(format!("{where_}: an atomic field must be 4-byte aligned"));
            }
            if field.is_array() {
                errors.push(format!("{where_}: an atomic field cannot be an array"));
            }
        }

        for (start, end, other) in &occupied {
            if field.offset < *end && *start < field.end() {
                errors.push(format!(
                    "{where_}: bytes {}..{} overlap {other} at {start}..{end}",
                    field.offset,
                    field.end()
                ));
            }
        }
        occupied.push((field.offset, field.end(), &field.name));
    }
}
