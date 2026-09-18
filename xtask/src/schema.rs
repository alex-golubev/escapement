// SPDX-License-Identifier: AGPL-3.0-only
//
// The schema as parsed, and the checks that make writing offsets by hand safe.
// Nothing here computes a layout: every offset in the file is taken as given
// and only tested for alignment, overlap and fit (ADR-0013).
//
// Every struct below refuses an unknown key: a key serde ignores is a line the
// author believes they wrote.

use crate::names::{pascal, screaming};
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

    /// `setUint8` takes no byte-order argument, and TypeScript rejects the
    /// call that passes one.
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

    /// Records and commands must get the same answer: a field that answered
    /// `u8` for a count of eight would carry one byte of the eight.
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

    pub fn ts_type(&self) -> &'static str {
        if self.is_array() {
            self.ty.ts_array()
        } else {
            "number"
        }
    }

    /// `derive(Default)` covers arrays only up to 32 elements.
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

    /// Every problem at once: a generator that reports one error per run turns
    /// a schema edit into a guessing game. A check whose input is itself
    /// missing is the only one skipped, and the missing input is reported.
    pub fn check(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        // The version word gives the major its top byte, so anything above
        // 255 is not a large version but a shifted-out one.
        if self.abi.major > 0xff {
            errors.push(format!(
                "abi.major is {}, but the ABI version word gives it one byte (0 to 255)",
                self.abi.major
            ));
        }

        let payload_offset = self.optional_constant(&mut errors, "command_payload_offset");
        let payload_size = self.optional_constant(&mut errors, "command_payload_size");
        let slot = self.records.get("command_slot");
        if slot.is_none() {
            errors.push("records.command_slot is missing".to_owned());
        }

        if let Some(slot) = slot {
            // Every command writer spells the slot header out, so renaming or
            // narrowing either field would generate a file that does not
            // compile. Stated here rather than assumed there.
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

            // Slots sit next to each other in the ring, so a slot that is not a
            // multiple of 8 would misalign every field of the following slot.
            if !slot.size.is_multiple_of(8) {
                errors.push(format!(
                    "records.command_slot.size {} is not a multiple of 8",
                    slot.size
                ));
            }
        }

        if let Some(offset) = payload_offset
            && !offset.is_multiple_of(8)
        {
            errors.push(format!(
                "command_payload_offset {offset} is not a multiple of 8"
            ));
        }

        // The payload region is declared twice — once as a pair of constants and
        // once as the field that occupies it — so the two must be checked
        // against each other or they will drift apart.
        if let (Some(slot), Some(offset), Some(size)) = (slot, payload_offset, payload_size) {
            if offset + size != slot.size {
                errors.push(format!(
                    "command_payload_offset + command_payload_size is {}, but records.command_slot.size is {}",
                    offset + size,
                    slot.size
                ));
            }
            if !slot
                .fields
                .iter()
                .any(|field| field.offset == offset && field.bytes() == size)
            {
                errors.push(format!(
                    "records.command_slot has no field covering the payload at {offset}..{}, which command_payload_offset and command_payload_size declare",
                    offset + size
                ));
            }
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

        // Two declarations that reach the same emitted name are a duplicate
        // definition in that language. The type names are only part of it: an
        // accessor is a record's name and a field's name run together, so
        // `meter.block_counter` and `meter_block.counter` both ask for
        // `loadMeterBlockCounter`.
        for (language, names) in [("Rust", self.rust_names()), ("TypeScript", self.ts_names())] {
            let mut seen: BTreeMap<String, String> = BTreeMap::new();
            for (name, origin) in names {
                if let Some(other) = seen.insert(name.clone(), origin.clone()) {
                    errors.push(format!(
                        "{origin} and {other} both generate the {language} name {name}"
                    ));
                }
            }
        }

        // A repeated export is a repeated member of the generated interface,
        // which does not compile.
        let mut exported: Vec<&str> = Vec::new();
        for export in &self.exports {
            if exported.contains(&export.name.as_str()) {
                errors.push(format!("exports: {} is declared twice", export.name));
            }
            exported.push(&export.name);
        }

        let kinds = self.enums.get("command_kind");
        for (name, command) in &self.commands {
            if kinds.is_none_or(|k| !k.contains_key(name)) {
                errors.push(format!("commands.{name} has no code in enums.command_kind"));
            }
            if let (Some(offset), Some(size)) = (payload_offset, payload_size) {
                check_fields(
                    &mut errors,
                    &format!("commands.{name}"),
                    &command.fields,
                    offset,
                    size,
                );
            }
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

    /// Every name the generator puts at the top level of the Rust file.
    pub fn rust_names(&self) -> Vec<(String, String)> {
        let mut names = abi_names();
        for name in self.constants.keys() {
            names.push((screaming(name), format!("constants.{name}")));
        }
        for name in self.enums.keys() {
            names.push((pascal(name), format!("enums.{name}")));
        }
        for name in self.records.keys() {
            names.push((pascal(name), format!("records.{name}")));
        }
        for name in self.commands.keys() {
            names.push((pascal(name), format!("commands.{name}")));
        }
        names.push(("EXPORT_FUNCTIONS".to_owned(), "the export list".to_owned()));
        names
    }

    /// The same for TypeScript, which puts far more at the top level: a record
    /// spreads into an offset table, a size, two functions per field and a view.
    pub fn ts_names(&self) -> Vec<(String, String)> {
        let mut names = abi_names();
        for name in self.constants.keys() {
            names.push((screaming(name), format!("constants.{name}")));
        }
        for name in self.enums.keys() {
            let from = format!("enums.{name}");
            names.push((pascal(name), from.clone()));
            names.push((format!("{}Code", pascal(name)), from));
        }
        for (name, record) in &self.records {
            let type_name = pascal(name);
            let from = format!("records.{name}");
            names.push((format!("{type_name}Offsets"), from.clone()));
            names.push((format!("{}_SIZE", screaming(name)), from.clone()));
            let mut has_property = false;
            for field in &record.fields {
                if field.is_array() {
                    continue;
                }
                has_property = true;
                let stem = format!("{type_name}{}", pascal(&field.name));
                let (read, write) = if field.atomic {
                    ("load", "store")
                } else {
                    ("read", "write")
                };
                let field_from = format!("records.{name}.{}", field.name);
                names.push((format!("{read}{stem}"), field_from.clone()));
                names.push((format!("{write}{stem}"), field_from));
            }
            if has_property {
                names.push((format!("read{type_name}"), from));
            }
        }
        for (name, command) in &self.commands {
            let type_name = pascal(name);
            let from = format!("commands.{name}");
            for field in &command.fields {
                if !field.is_array() {
                    continue;
                }
                let stem = format!("{type_name}{}", pascal(&field.name));
                let field_from = format!("commands.{name}.{}", field.name);
                names.push((format!("write{stem}"), field_from.clone()));
                names.push((format!("read{stem}"), field_from));
            }
            names.push((format!("write{type_name}"), from.clone()));
            if !command.fields.is_empty() {
                names.push((format!("read{type_name}"), from));
            }
        }
        names.push(("EngineExports".to_owned(), "the export list".to_owned()));
        names
    }

    /// Missing is an error like any other, not a reason to stop looking.
    fn optional_constant(&self, errors: &mut Vec<String>, name: &str) -> Option<usize> {
        match self.constant(name) {
            Ok(value) => Some(value),
            Err(message) => {
                errors.push(message);
                None
            }
        }
    }
}

fn abi_names() -> Vec<(String, String)> {
    ["ABI_MAJOR", "ABI_HASH", "ABI_VERSION"]
        .into_iter()
        .map(|name| (name.to_owned(), "the ABI version".to_owned()))
        .collect()
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
