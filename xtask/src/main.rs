// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace chores, run as `cargo xtask <task>`.

mod emit_rust;
mod emit_ts;
mod names;
mod schema;
#[cfg(test)]
mod tests;

use schema::{Export, ExportKind, Field, Schema};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const SCHEMA_PATH: &str = "schema/boundary.toml";
const RUST_OUT: &str = "crates/protocol/src/generated.rs";
const TS_OUT: &str = "packages/protocol/src/generated.ts";

fn main() -> ExitCode {
    let task = std::env::args().nth(1);
    match task.as_deref() {
        Some("generate") => match generate() {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("{message}");
                ExitCode::FAILURE
            }
        },
        Some("tasks") | None => {
            println!("usage: cargo xtask <task>");
            println!();
            println!("tasks:");
            println!("  generate  regenerate the boundary code from {SCHEMA_PATH}");
            println!("  tasks     list the tasks (this message)");
            ExitCode::SUCCESS
        }
        Some(unknown) => {
            eprintln!("xtask: unknown task {unknown:?}, try `cargo xtask tasks`");
            ExitCode::FAILURE
        }
    }
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points at xtask/; the workspace is its parent.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask always sits one level below the workspace root")
        .to_path_buf()
}

fn generate() -> Result<(), String> {
    let root = workspace_root();
    let source = std::fs::read_to_string(root.join(SCHEMA_PATH))
        .map_err(|err| format!("cannot read {SCHEMA_PATH}: {err}"))?;
    let schema: Schema =
        toml::from_str(&source).map_err(|err| format!("{SCHEMA_PATH} does not parse:\n{err}"))?;

    schema.check().map_err(|problems| {
        let mut message = format!("{SCHEMA_PATH} is not consistent:\n");
        for problem in problems {
            let _ = writeln!(message, "  - {problem}");
        }
        message
    })?;

    let hash = abi_hash(&schema);
    let version = (schema.abi.major << 24) | (hash & 0x00ff_ffff);

    let rust = rustfmt(&emit_rust::emit(&schema, version, hash))?;
    write_if_changed(&root.join(RUST_OUT), &rust)?;
    write_if_changed(&root.join(TS_OUT), &emit_ts::emit(&schema, version, hash))?;
    Ok(())
}

/// A hash of what the boundary *is*, not of how the file is written. Editing a
/// field must move it (ADR-0013); reformatting the TOML, reordering fields that
/// keep their offsets, or renaming a variant of `Type` must not — a spurious
/// bump tells every plugin author that an ABI changed when it did not.
///
/// So: fields in offset order, tables in name order, type names as the schema
/// spells them.
fn abi_hash(schema: &Schema) -> u32 {
    let mut canonical = String::new();
    let _ = writeln!(canonical, "major={}", schema.abi.major);
    for (name, constant) in &schema.constants {
        let _ = writeln!(canonical, "const {name}={}", constant.value);
    }
    for (name, variants) in &schema.enums {
        for (variant, code) in variants {
            let _ = writeln!(canonical, "enum {name}.{variant}={}", code.value);
        }
    }
    for (name, record) in &schema.records {
        let _ = writeln!(
            canonical,
            "record {name} size={} shared={}",
            record.size, record.shared
        );
        for field in in_offset_order(&record.fields) {
            let _ = writeln!(
                canonical,
                "  field {} {} count={} offset={} atomic={}",
                field.name,
                field.ty.schema_name(),
                field.count,
                field.offset,
                field.atomic
            );
        }
    }
    for (name, command) in &schema.commands {
        let _ = writeln!(canonical, "command {name}");
        for field in in_offset_order(&command.fields) {
            let _ = writeln!(
                canonical,
                "  field {} {} count={} offset={}",
                field.name,
                field.ty.schema_name(),
                field.count,
                field.offset
            );
        }
    }
    let mut exports: Vec<&Export> = schema.exports.iter().collect();
    exports.sort_by(|a, b| a.name.cmp(&b.name));
    for export in exports {
        let kind = match export.kind {
            ExportKind::Function => "function",
            ExportKind::Memory => "memory",
        };
        let _ = write!(canonical, "export {kind} {}(", export.name);
        for param in &export.params {
            let _ = write!(canonical, "{}:{},", param.name, param.ty.schema_name());
        }
        let returns = export.returns.map_or("void", |ty| ty.schema_name());
        let _ = writeln!(canonical, ") -> {returns}");
    }

    let digest = Sha256::digest(canonical.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

fn in_offset_order(fields: &[Field]) -> Vec<&Field> {
    let mut ordered: Vec<&Field> = fields.iter().collect();
    ordered.sort_by_key(|field| field.offset);
    ordered
}

/// The emitter does not think about line widths: rustfmt is in the pinned
/// toolchain, so the generated Rust is formatted the same way the rest of the
/// workspace is. The TypeScript side cannot do this — running Node from the
/// Rust build is exactly what ADR-0013 avoided — so there the formatter is
/// switched off for generated files instead.
fn rustfmt(source: &str) -> Result<String, String> {
    let mut child = Command::new("rustfmt")
        .args(["--edition", "2024", "--emit", "stdout", "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|err| format!("cannot run rustfmt: {err}"))?;

    child
        .stdin
        .take()
        .ok_or("rustfmt took no stdin")?
        .write_all(source.as_bytes())
        .map_err(|err| format!("cannot write to rustfmt: {err}"))?;

    let output = child
        .wait_with_output()
        .map_err(|err| format!("rustfmt did not finish: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "rustfmt rejected the generated code: {}",
            output.status
        ));
    }
    String::from_utf8(output.stdout).map_err(|err| format!("rustfmt returned invalid UTF-8: {err}"))
}

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("cannot create {}: {err}", parent.display()))?;
    }
    let unchanged = std::fs::read_to_string(path).is_ok_and(|existing| existing == contents);
    if unchanged {
        println!("unchanged {}", path.display());
        return Ok(());
    }
    std::fs::write(path, contents)
        .map_err(|err| format!("cannot write {}: {err}", path.display()))?;
    println!("wrote     {}", path.display());
    Ok(())
}
