#!/bin/sh
# Assemble the slice 1 probe. Trunk is configured but out of the loop until
# sound comes out: it would be a second suspect when something breaks, and it
# assumes one app and one wasm where there are two.
#
# Its own directory, not `dist`. Trunk owns that one and clears it on every
# build, so sharing it would make `index.html` whichever of the two ran last —
# with `tools/dev-server.py` serving it either way and saying nothing.
set -eu
cd "$(dirname "$0")/.."

OUT=dist-first-sound

cargo build -p escapement-worklet --target wasm32-unknown-unknown --release

# +atomics alone links a private memory and fails only in the browser; a growable
# memory would leave memory.grow reachable from the audio thread (§1).
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm

# An allocator on the audio path is a dropout waiting for a busy moment (§1),
# and an import is a module that will not instantiate at all.
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm

mkdir -p "$OUT"
cp web/first-sound.html "$OUT/index.html"
cp web/worklet.js "$OUT/worklet.js"
cp target/wasm32-unknown-unknown/release/escapement_worklet.wasm "$OUT/"

echo "$OUT/ ready — serve it with: tools/dev-server.py $OUT"
