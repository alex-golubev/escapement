#!/usr/bin/env bash
#
# Bundle the worklet processor into web/public/worklet/.
#
# The artifact is not kept in history (see .gitignore) — it is reproduced
# in full by this script.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="$root/web/src/worklet/processor.ts"
destination="$root/web/public/worklet/processor.js"
esbuild="$root/web/node_modules/.bin/esbuild"

cd "$root"

mkdir -p "$(dirname "$destination")"

# esbuild is a dependency of web/, so it is driven through its CLI rather than
# imported. Node resolves bare specifiers upward from the importing file, and
# from scripts/ that walk never reaches web/node_modules — importing the JS API
# here would force a root package.json and a second node_modules for one tool.
#
# The binary is run directly rather than through `pnpm exec`, which repeats an
# install pre-flight costing some 200ms against 12ms for this. The script runs
# after every worklet edit, so that check is made explicit here instead, where
# it can also say what to do about it.
if [[ ! -x "$esbuild" ]]; then
    echo "esbuild not found at $esbuild" >&2
    echo "Install it with: pnpm --dir web install" >&2
    exit 1
fi

"$esbuild" "$entry" \
    --bundle \
    --format=iife \
    --target=es2022 \
    --outfile="$destination"

# The bundle must be self-contained. AudioWorkletGlobalScope has no module
# loader, so a surviving import produces a successful build and a module that
# fails only when addModule() runs — the same class of failure the ABI check in
# build-wasm.sh guards against, and just as far from its cause.
#
# Only value imports can trip this; `import type` is erased before bundling even
# starts. Today the processor imports nothing else, so the check has nothing to
# bite on yet — it becomes load-bearing as soon as the worklet pulls a real
# constant out of the command protocol.
if grep -nE '^[[:space:]]*(import|export)[[:space:]]' "$destination"; then
    echo "Bundle still contains import/export — it will not load in AudioWorkletGlobalScope" >&2
    exit 1
fi

# registerProcessor is the whole point of the file: without that call the module
# loads cleanly and the AudioWorkletNode constructor then fails with an
# unregistered-name error that says nothing about why.
if ! grep -q 'registerProcessor' "$destination"; then
    echo "Bundle does not call registerProcessor — the node will not construct" >&2
    exit 1
fi

printf 'processor.js → web/public/worklet/ (%s bytes)\n' "$(wc -c <"$destination" | tr -d ' ')"
