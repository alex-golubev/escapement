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
# starts. The processor pulls real values out of engine.ts, render.ts and the
# command protocol, so the check has something to bite on.
if grep -nE '^[[:space:]]*(import|export)[[:space:]]' "$destination"; then
    echo "Bundle still contains import/export — it will not load in AudioWorkletGlobalScope" >&2
    exit 1
fi

# The same failure by the other door, and this one arrives here from ESLint.
# `no-restricted-syntax` used to ban `import()` under src/worklet/ by AST
# selector; Biome has no rule taking one, so the check moved to the artifact.
# That is the better place for it anyway — the bundle is what has no module
# loader behind it, and the bundle is what this reads. It also now covers a
# dynamic import arriving through a dependency, which the source rule never saw.
#
# esbuild rewrites a dynamic import of a bundled module into a resolved promise,
# so what survives to here is the kind that would actually be evaluated at
# runtime: a specifier esbuild could not resolve, left for a loader that does
# not exist.
if grep -nE '\bimport[[:space:]]*\(' "$destination"; then
    echo "Bundle contains a dynamic import — there is no module loader to resolve it" >&2
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
