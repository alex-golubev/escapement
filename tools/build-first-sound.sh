#!/bin/sh
# Assemble dist/ for the slice 1 probe. Trunk is configured but out of the loop
# until sound comes out: it would be a second suspect when something breaks, and
# it assumes one app and one wasm where there are two.
set -eu
cd "$(dirname "$0")/.."

cargo build -p escapement-worklet --target wasm32-unknown-unknown --release

# +atomics alone links a private memory and fails only in the browser; a growable
# memory would leave memory.grow reachable from the audio thread (§1).
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm

# An allocator on the audio path is a dropout waiting for a busy moment (§1).
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm

mkdir -p dist
cp web/first-sound.html dist/index.html
cp web/worklet.js dist/worklet.js
cp target/wasm32-unknown-unknown/release/escapement_worklet.wasm dist/

echo "dist/ ready — serve it with: tools/dev-server.py"
