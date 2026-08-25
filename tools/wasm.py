#!/usr/bin/env python3
"""Reading a built wasm module — what the two wasm checks beside this file need.

Here rather than copied into each: they ask different questions of the same
bytes, and a section walk that drifted between them would leave one of the two
answering about a module it had parsed differently. Both exist so that a wrong
answer does not reach the browser, which is what makes that dangerous.

Not a module for anything outside this directory. Both callers are run as
`python3 tools/<name>.py`, which is what puts this directory first on the path.
"""

MAGIC = b"\0asm"


def uleb(buf, i):
    """The one integer encoding wasm uses. Returns the value and where it ended."""
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, i


def sections(buf):
    """Yield (id, start, end) for every section, `start` already past the size."""
    if buf[:4] != MAGIC:
        raise ValueError("not a wasm module")
    i = 8
    while i < len(buf):
        section_id = buf[i]
        i += 1
        size, i = uleb(buf, i)
        end = i + size
        yield section_id, i, end
        i = end

