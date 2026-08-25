#!/bin/sh
# Run the test suite under Miri, which checks for undefined behaviour: invalid
# pointer use in `escapement-protocol`'s one `unsafe` module, and data races —
# including the deliberate one in the state block, where a torn read is expected
# and handled but must still not be a race in the abstract machine.
#
# Why this is not simply `cargo miri test`. `.cargo/config.toml` asks for
# `build-std`, which atomics-enabled wasm needs because no prebuilt std has
# atomics. It engages whenever `--target` is passed — and `cargo miri` passes
# one, for the host. Miri builds its own sysroot as well, and the two collide.
# The failure is inside `compiler_builtins`, hundreds of "cannot find `Some` in
# this scope", and points nowhere near the cause.
#
# Cargo finds `.cargo/config.toml` by walking up from the working directory, not
# from the manifest. So this runs from outside the repository and points cargo
# back at it. The toolchain then has to be named, because `rust-toolchain.toml`
# is found the same way.
#
# Usage:  tools/miri.sh [cargo test arguments]
#   tools/miri.sh -p escapement-protocol
#   MIRIFLAGS=-Zmiri-tree-borrows tools/miri.sh
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$repo/rust-toolchain.toml")

if [ -z "$toolchain" ]; then
    echo "no channel in rust-toolchain.toml" >&2
    exit 1
fi

cd /
exec cargo "+$toolchain" miri test --manifest-path "$repo/Cargo.toml" "$@"
