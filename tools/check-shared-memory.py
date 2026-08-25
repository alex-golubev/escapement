#!/usr/bin/env python3
"""Assert that built wasm modules declare *shared* linear memory.

Why this exists: `-C target-feature=+atomics` is not sufficient. It makes atomic
instructions available, but the module still links with a private, unshared
memory unless the linker is also told `--shared-memory` (which in turn is only
legal alongside a declared `--max-memory`).

The failure is silent. The build succeeds, the wasm is valid, and it dies in the
browser at instantiation time with an error that points at the wasm rather than
at the missing flag — the same shape of trap as missing COOP/COEP headers.

With --fixed, also require minimum == maximum. That is what stops `memory.grow`
from ever succeeding, which the worklet needs: grow is not a bounded operation,
and a quantum at 48 kHz leaves 2.7 ms for everything (ARCHITECTURE.md §1).

Usage:  tools/check-shared-memory.py [--fixed] <file.wasm> [<file.wasm> ...]
"""

import sys

from report import advise
from wasm import sections, uleb

PAGE = 64 * 1024
SECTION_IMPORT = 2
SECTION_MEMORY = 5
KIND_FUNC, KIND_TABLE, KIND_MEMORY, KIND_GLOBAL = 0, 1, 2, 3


def size(pages):
    """Pages are 64 KiB; rounding a small one down to `0 MiB` reads as a bug."""
    kib = pages * PAGE // 1024
    return f"{kib // 1024} MiB" if kib >= 1024 else f"{kib} KiB"


def limits(buf, i):
    flags, i = uleb(buf, i)
    minimum, i = uleb(buf, i)
    maximum = None
    if flags & 1:
        maximum, i = uleb(buf, i)
    return (flags, minimum, maximum), i


def memories(buf):
    """Yield (source, flags, minimum, maximum) for every memory a module holds.

    Both sections matter. A module usually defines its own memory, but a linker
    can equally be told to import one — and reading only the memory section
    reports that as "declares no linear memory", a red build indistinguishable
    from the real failure this script exists to catch.
    """
    for section_id, start, _end in sections(buf):
        if section_id == SECTION_MEMORY:
            count, j = uleb(buf, start)
            for _ in range(count):
                limit, j = limits(buf, j)
                yield ("defined", *limit)

        elif section_id == SECTION_IMPORT:
            count, j = uleb(buf, start)
            for _ in range(count):
                for _name in range(2):
                    length, j = uleb(buf, j)
                    j += length
                kind = buf[j]
                j += 1
                if kind == KIND_MEMORY:
                    limit, j = limits(buf, j)
                    yield ("imported", *limit)
                elif kind == KIND_FUNC:
                    _, j = uleb(buf, j)
                elif kind == KIND_TABLE:
                    j += 1
                    _, j = limits(buf, j)
                elif kind == KIND_GLOBAL:
                    j += 2
                else:
                    raise ValueError(f"unknown import kind {kind}")


def main(argv):
    require_fixed = "--fixed" in argv
    paths = [a for a in argv if a != "--fixed"]
    if not paths:
        print(__doc__)
        return 2

    not_shared = grows = False
    for path in paths:
        found = list(memories(open(path, "rb").read()))
        if not found:
            print(f"FAIL {path}: declares and imports no linear memory")
            not_shared = True
            continue
        for source, flags, minimum, maximum in found:
            shared = bool(flags & 2)
            span = f"min={size(minimum)}"
            if maximum is not None:
                span += f" max={size(maximum)}"
            detail = f"{source}, {span}, flags=0x{flags:02x}"

            if not shared:
                reason = "memory is not shared"
                not_shared = True
            elif maximum is None:
                reason = "no maximum declared"
                not_shared = True
            elif require_fixed and minimum != maximum:
                reason = "memory can grow, --fixed was asked for"
                grows = True
            else:
                print(f"ok   {path}: shared memory, {detail}")
                continue
            print(f"FAIL {path}: {reason} ({detail})")

    # Two different failures with two different fixes.
    if not_shared:
        advise(
            "Check that crates/*/build.rs still pass --shared-memory and",
            "--max-memory=..., alongside -C target-feature=+atomics from",
            ".cargo/config.toml. The feature flag alone is not enough.",
        )
    if grows:
        advise(
            "A fixed memory is --initial-memory equal to --max-memory. Check",
            "crates/worklet/build.rs.",
        )
    return 1 if (not_shared or grows) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
