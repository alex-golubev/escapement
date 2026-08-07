#!/usr/bin/env bash
#
# Build the engine to WASM and place the artifact into web/public/.
#
# The artifact is not kept in history (see .gitignore) — it is reproduced
# in full by this script.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="wasm32-unknown-unknown"
artifact="$root/target/$target/release/engine.wasm"
destination="$root/web/public/engine.wasm"

# Build from the workspace root: [profile.*] sections are read only from the
# root manifest, and running from another directory would build with default
# settings — no lto and no panic = "abort".
cd "$root"

if ! rustup target list --installed | grep -qx "$target"; then
    echo "Target $target is not installed." >&2
    echo "Install it with: rustup target add $target" >&2
    exit 1
fi

cargo build --target "$target" --release -p engine

mkdir -p "$(dirname "$destination")"
cp "$artifact" "$destination"

# Check the ABI surface. A lost #[unsafe(no_mangle)], or a function dropped by
# the linker, yields a successful build and a silently useless module — the
# class of failure that costs the most to track down later.
expected=(
    engine_protocol_version
    engine_new
    engine_free
    engine_out_ptr
    engine_cmd_ptr
    engine_cmd_capacity
    engine_telemetry_ptr
    engine_process
)

if command -v node >/dev/null 2>&1; then
    node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const [file, ...expected] = process.argv.slice(1);
        const module = await WebAssembly.compile(readFileSync(file));
        const found = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
        const missing = expected.filter((name) => !found.has(name));
        if (missing.length > 0) {
            console.error(`Module built, but these functions are absent: ${missing.join(", ")}`);
            process.exit(1);
        }
        if (!found.has("memory")) {
            console.error("Module does not export memory — the worklet cannot build its views");
            process.exit(1);
        }
    ' "$destination" "${expected[@]}"
else
    echo "node not found — the ABI surface was not checked" >&2
fi

printf 'engine.wasm → web/public/ (%s bytes)\n' "$(wc -c <"$destination" | tr -d ' ')"
