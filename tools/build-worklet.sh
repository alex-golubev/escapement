#!/bin/sh
# Build the worklet module and hold it to what the audio thread requires.
#
# A Trunk hook rather than a `data-trunk rel="rust"` link: the worklet needs raw
# wasm with no `wasm-bindgen` glue around it — it is instantiated from bytes
# inside `AudioWorkletGlobalScope`, where there is no `fetch` and no import
# object (§1). Trunk's rust pipeline gives the opposite of that.
#
# The three checks stay here rather than moving into CI alone, so that a page
# assembled by hand is held to the same bar as one assembled by a robot.
set -eu
cd "$(dirname "$0")/.."

cargo build -p escapement-worklet --target wasm32-unknown-unknown --release

# +atomics alone links a private memory and fails only in the browser; a growable
# memory would leave memory.grow reachable from the audio thread (§1).
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm

# An allocator on the audio path is a dropout waiting for a busy moment (§1),
# and an import is a module that will not instantiate at all.
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm
