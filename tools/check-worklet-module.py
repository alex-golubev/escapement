#!/usr/bin/env python3
"""Assert that the worklet module carries no allocator.

`escapement-core` is `no_std`, so nothing there can name a `Vec`. That is a
check on our own source and it stops at the crate boundary: the worklet crate
links `std`, and a dependency is free to allocate inside itself no matter what
our crates declare. The property that actually matters is about the artifact —
whether an allocator ended up in the module the audio thread runs — so that is
what this asks.

Making the worklet crate `no_std` instead does not work and is not a matter of
taste: a `cdylib` without `std` needs its own `#[panic_handler]`, and the dev
profile's unwinding panics are unsupported without `std`, so it would take
`panic = "abort"` across the whole workspace — after which the host `.dylib`
still fails to link, having no libc. Measured, not assumed.

The signal is not subtle. A single `Vec` in `process` took the module from
6891 to 26 318 bytes and brought in `dlmalloc`, `__rust_alloc`, `rust_oom` and
the panic formatting machinery behind them.

Whole symbol names are matched rather than the substring `alloc`, because this
project allocates voices: `voice_allocation` in the sampler (ARCHITECTURE.md
§5) is not a heap.

Usage:  tools/check-worklet-module.py <file.wasm> [<file.wasm> ...]
"""

import sys

from wasm import sections, uleb

SECTION_CUSTOM = 0

# Every one of these was read out of a module built with one `Vec` in it. The
# first three are what `rustc` emits at the call site, the next three what the
# default allocator registers, `dlmalloc` is the implementation it registers,
# and the shim is referenced even when the allocation itself optimizes away —
# which it did, in the first of the two probes.
ALLOCATOR_SYMBOLS = (
    "__rust_alloc",
    "__rust_dealloc",
    "__rust_realloc",
    "__rdl_alloc",
    "__rdl_dealloc",
    "__rdl_realloc",
    "dlmalloc",
    "__rust_no_alloc_shim",
)


def name_section(buf):
    """The custom section holding symbol names, or None if the module has none.

    None is not "clean". Symbol names are what this check reads, so a module
    without them cannot be checked at all — `strip` in a profile would produce
    exactly that, and silently passing is the one answer that must not happen.
    """
    for section_id, start, end in sections(buf):
        if section_id == SECTION_CUSTOM:
            length, j = uleb(buf, start)
            if buf[j : j + length] == b"name":
                return buf[j + length : end]
    return None


def main(argv):
    if not argv:
        print(__doc__)
        return 2

    unchecked = allocates = False
    for path in argv:
        names = name_section(open(path, "rb").read())
        if names is None:
            print(f"FAIL {path}: no name section, so nothing here can be checked")
            unchecked = True
            continue

        found = [s for s in ALLOCATOR_SYMBOLS if s.encode() in names]
        if found:
            print(f"FAIL {path}: an allocator reached the audio thread ({', '.join(found)})")
            allocates = True
        else:
            print(f"ok   {path}: no allocator")

    if allocates:
        print(
            "\nSomething on the audio path allocates (ARCHITECTURE.md §1). It is\n"
            "as likely to be a dependency allocating inside itself as our own\n"
            "code: build with `--target wasm32-unknown-unknown --release`, then\n"
            "read the name section for what pulled `dlmalloc` in."
        )
    if unchecked:
        print("\nSymbol names were stripped. Check `strip` in Cargo.toml.")
    return 1 if (allocates or unchecked) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
