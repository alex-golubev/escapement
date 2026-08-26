#!/usr/bin/env python3
"""Assert what has to be true of the worklet's module, and is true of no other.

Two properties, both about the built artifact rather than about our source, and
both breaking in the browser rather than at the build.

**No allocator.** `escapement-core` is `no_std`, so nothing there can name a
`Vec`. That is a check on our own source and it stops at the crate boundary:
the worklet crate links `std`, and a dependency is free to allocate inside
itself no matter what our crates declare. The property that actually matters is
whether an allocator ended up in the module the audio thread runs, so that is
what this asks.

The signal is not subtle. A single `Vec` in `process` took the module from
6891 to 26 318 bytes and brought in `dlmalloc`, `__rust_alloc`, `rust_oom` and
the panic formatting machinery behind them.

Whole symbol names are matched rather than the substring `alloc`, because this
project allocates voices: `voice_allocation` in the sampler (ARCHITECTURE.md
§5) is not a heap.

**No imports.** `worklet.js` instantiates from a compiled module with no import
object, which is what makes `process()` ready on its first call rather than
after a promise — there is no `fetch` inside `AudioWorkletGlobalScope` to
compile with (§1). A module with an import section cannot be instantiated that
way at all, and the throw names the module rather than whatever put the import
there.

Also not subtle, and measured rather than feared: reaching the region from the
interface needs `js-sys`, and putting it behind a cargo feature on
`escapement-protocol` put it in the worklet too — cargo unifies features across
a workspace build. Four `__wbindgen` imports, an allocator, and 8568 bytes
became 468 568. That is why the outside half is `escapement-view`, a crate the
worklet does not depend on, rather than a feature.

Making the worklet crate `no_std` instead does not work and is not a matter of
taste: a `cdylib` without `std` needs its own `#[panic_handler]`, and the dev
profile's unwinding panics are unsupported without `std`, so it would take
`panic = "abort"` across the whole workspace — after which the host `.dylib`
still fails to link, having no libc. Measured, not assumed.

Usage:  tools/check-worklet-module.py <file.wasm> [<file.wasm> ...]
"""

import sys

from wasm import sections, uleb

SECTION_CUSTOM = 0
SECTION_IMPORT = 2

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

IMPORT_KINDS = {0x00: "func", 0x01: "table", 0x02: "memory", 0x03: "global"}


def name_section(buf):
    """The custom section holding symbol names, or None if the module has none.

    None is not "clean". Symbol names are what the allocator check reads, so a
    module without them cannot be checked at all — `strip` in a profile would
    produce exactly that, and silently passing is the one answer that must not
    happen.
    """
    for section_id, start, end in sections(buf):
        if section_id == SECTION_CUSTOM:
            length, j = uleb(buf, start)
            if buf[j : j + length] == b"name":
                return buf[j + length : end]
    return None


def _name(buf, i):
    length, i = uleb(buf, i)
    return buf[i : i + length].decode("utf-8", "replace"), i + length


def _skip_limits(buf, i):
    """Flags, minimum, and a maximum only when the low bit says there is one."""
    flags = buf[i]
    i += 1
    _, i = uleb(buf, i)
    if flags & 1:
        _, i = uleb(buf, i)
    return i


def imports(buf):
    """Every import as `module.field`, empty when there is no import section.

    A module with no import section and one with an empty one are the same
    thing here: nothing has to be supplied to instantiate it.
    """
    span = next((start for kind, start, _ in sections(buf) if kind == SECTION_IMPORT), None)
    if span is None:
        return []

    found = []
    count, i = uleb(buf, span)
    for _ in range(count):
        module, i = _name(buf, i)
        field, i = _name(buf, i)
        kind = buf[i]
        i += 1
        if kind == 0x00:
            _, i = uleb(buf, i)
        elif kind == 0x01:
            i = _skip_limits(buf, i + 1)
        elif kind == 0x02:
            i = _skip_limits(buf, i)
        elif kind == 0x03:
            i += 2
        else:
            raise ValueError(f"unknown import kind {kind:#04x}")
        found.append(f"{IMPORT_KINDS[kind]} {module}.{field}")
    return found


def main(argv):
    if not argv:
        print(__doc__)
        return 2

    unchecked = allocates = imported = False
    for path in argv:
        with open(path, "rb") as f:
            buf = f.read()

        needs = imports(buf)
        if needs:
            print(f"FAIL {path}: {len(needs)} imports, so it cannot be instantiated bare")
            for one in needs:
                print(f"       {one}")
            imported = True
        else:
            print(f"ok   {path}: nothing imported")

        names = name_section(buf)
        if names is None:
            print(f"FAIL {path}: no name section, so the allocator check cannot run")
            unchecked = True
            continue

        found = [s for s in ALLOCATOR_SYMBOLS if s.encode() in names]
        if found:
            print(f"FAIL {path}: an allocator reached the audio thread ({', '.join(found)})")
            allocates = True
        else:
            print(f"ok   {path}: no allocator")

    if imported:
        print(
            "\nThe worklet is instantiated with no import object (§1), so an\n"
            "import is a module that will not start. A dependency reaching for\n"
            "JavaScript is the usual cause — check what a cargo feature pulled\n"
            "into this crate's graph."
        )
    if allocates:
        print(
            "\nSomething on the audio path allocates (ARCHITECTURE.md §1). It is\n"
            "as likely to be a dependency allocating inside itself as our own\n"
            "code: build with `--target wasm32-unknown-unknown --release`, then\n"
            "read the name section for what pulled `dlmalloc` in."
        )
    if unchecked:
        print("\nSymbol names were stripped. Check `strip` in Cargo.toml.")
    return 1 if (allocates or unchecked or imported) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
