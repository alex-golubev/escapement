#!/usr/bin/env python3
"""Assert that built wasm modules declare *shared* linear memory.

Why this exists: `-C target-feature=+atomics` is not sufficient. It makes atomic
instructions available, but the module still links with a private, unshared
memory unless the linker is also told `--shared-memory` (which in turn is only
legal alongside a declared `--max-memory`).

The failure is silent. The build succeeds, the wasm is valid, and it dies in the
browser at instantiation time with an error that points at the wasm rather than
at the missing flag — the same shape of trap as missing COOP/COEP headers.

Usage:  tools/check-shared-memory.py <file.wasm> [<file.wasm> ...]
"""

import sys


def uleb(buf, i):
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, i


def memories(buf):
    """Yield (source, flags, minimum, maximum) for every memory a module holds."""
    if buf[:4] != b"\0asm":
        raise ValueError("not a wasm module")
    i = 8
    while i < len(buf):
        section_id = buf[i]
        i += 1
        size, i = uleb(buf, i)
        end = i + size
        if section_id == 5:  # memory section — memory defined by this module
            count, j = uleb(buf, i)
            for _ in range(count):
                flags, j = uleb(buf, j)
                minimum, j = uleb(buf, j)
                maximum = None
                if flags & 1:
                    maximum, j = uleb(buf, j)
                yield "defined", flags, minimum, maximum
        i = end


def main(paths):
    failed = False
    for path in paths:
        found = list(memories(open(path, "rb").read()))
        if not found:
            print(f"FAIL {path}: declares no linear memory")
            failed = True
            continue
        for source, flags, minimum, maximum in found:
            shared = bool(flags & 2)
            detail = f"min={minimum} max={maximum} flags=0x{flags:02x}"
            if shared and maximum is not None:
                print(f"ok   {path}: shared memory, {detail}")
            else:
                reason = "memory is not shared" if not shared else "no maximum declared"
                print(f"FAIL {path}: {reason} ({source}, {detail})")
                failed = True
    if failed:
        print(
            "\nShared memory is missing. Check that .cargo/config.toml still passes\n"
            "  -C link-arg=--shared-memory  and  -C link-arg=--max-memory=...\n"
            "alongside -C target-feature=+atomics. The feature flag alone is not enough.",
            file=sys.stderr,
        )
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1:]))
