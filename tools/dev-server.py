#!/usr/bin/env python3
"""Serve static files with the two headers `SharedArrayBuffer` needs.

Why this exists: `SharedArrayBuffer` only exists on a cross-origin isolated
page, and isolation is granted by two response headers (ARCHITECTURE.md §1).
Without them the page loads and the wasm compiles; the failure surfaces later as
a missing constructor, pointing at the wasm rather than at the server. Python's
own `http.server` sends neither header and has no flag to add them.

Temporary by design. Once sound comes out of the worklet, `trunk serve` takes
over — it already sends the same headers (Trunk.toml), which is also why this
defaults to the same port.

Usage:  tools/dev-server.py [directory] [port]
        tools/dev-server.py dist-first-sound     # the slice 1 probe
"""

import mimetypes
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Python does not always know this one, and `instantiateStreaming` rejects
# anything else. Registering it costs nothing when the mapping is already there.
mimetypes.add_type("application/wasm", ".wasm")

HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    # Without this the browser keeps serving the previous .wasm after a rebuild,
    # and the next half hour goes into debugging an error already fixed.
    "Cache-Control": "no-store",
}


class Handler(SimpleHTTPRequestHandler):
    # Default is HTTP/1.0, which closes the connection after every response. A
    # page pulling a dozen files then pays a dozen handshakes.
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        for name, value in HEADERS.items():
            self.send_header(name, value)
        super().end_headers()


def main(argv):
    directory = argv[0] if argv else "dist"
    port = int(argv[1]) if len(argv) > 1 else 8080

    if not os.path.isdir(directory):
        print(f"no such directory: {directory}", file=sys.stderr)
        return 2

    handler = lambda *a, **kw: Handler(*a, directory=directory, **kw)  # noqa: E731
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)

    banner = [f"serving {os.path.abspath(directory)} on http://127.0.0.1:{port}"]
    banner += [f"  {name}: {value}" for name, value in HEADERS.items()]
    banner += ["check in the console: crossOriginIsolated === true"]
    # flush: redirected into a file this is block-buffered, and the banner is
    # exactly what you go looking for when isolation does not work.
    print("\n".join(banner), flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
