#!/usr/bin/env python3
"""Put a chromedriver beside the build, matching the installed Chrome.

Why this exists: the browser tests need a WebDriver, and Chrome refuses a
session to a driver whose major version is not its own — so the driver is not
something to install once and forget. There is no package manager to ask for it
either: homebrew's cask was disabled because the binary does not pass the
Gatekeeper check, and Google publishes neither a signature with a publisher
behind it nor a checksum. So it is fetched here, pinned to the Chrome actually
on this machine, and left in `target/` rather than on PATH — an unsigned binary
belongs with build output, where `cargo clean` reaches it.

`.cargo/config.toml` points `CHROMEDRIVER` at what this writes, which is how
`wasm-bindgen-test-runner` finds it without PATH being involved.

Usage:  python3 tools/chromedriver.py
"""

import json
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BINARY = ROOT / "target" / "chromedriver" / "chromedriver"

# Keyed by MAJOR.MINOR.BUILD, which is the granularity Chrome and its driver are
# released in together. The bare `latest-versions` endpoints answer for whatever
# Chrome is current, which is not the question here.
ENDPOINT = (
    "https://googlechromelabs.github.io/chrome-for-testing/"
    "latest-patch-versions-per-build-with-downloads.json"
)

# Where Chrome hides. macOS keeps it inside the bundle rather than on PATH.
CHROME = {
    "Darwin": ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    "Linux": ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
}

PLATFORM = {
    ("Darwin", "arm64"): "mac-arm64",
    ("Darwin", "x86_64"): "mac-x64",
    ("Linux", "x86_64"): "linux64",
}

VERSION = re.compile(r"(\d+\.\d+\.\d+\.\d+)")


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def version_of(command):
    """The four-part version a Chrome or a chromedriver reports, or None."""
    try:
        spoken = subprocess.run(
            [command, "--version"], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return None
    found = VERSION.search(spoken.stdout)
    return found.group(1) if found else None


def build(version):
    """MAJOR.MINOR.BUILD — what a Chrome and its driver have to agree on."""
    return version.rsplit(".", 1)[0]


def chrome():
    for candidate in CHROME.get(platform.system(), []):
        found = shutil.which(candidate) or (
            candidate if Path(candidate).exists() else None
        )
        if found and (version := version_of(found)):
            return version
    fail(f"no Chrome found — looked at {', '.join(CHROME.get(platform.system(), []))}")


def download_url(wanted, target):
    """The driver for `wanted`, else the newest sharing its major version."""
    with urllib.request.urlopen(ENDPOINT, timeout=60) as response:
        builds = json.load(response)["builds"]

    if wanted not in builds:
        major = wanted.split(".", 1)[0] + "."
        near = sorted(b for b in builds if b.startswith(major))
        if not near:
            fail(f"no chromedriver published for Chrome {wanted}.x")
        print(f"no build {wanted}; taking {near[-1]}, the newest of that major")
        wanted = near[-1]

    entry = builds[wanted]
    for download in entry["downloads"].get("chromedriver", []):
        if download["platform"] == target:
            return download["url"], entry["version"]
    fail(f"chromedriver {wanted} is not published for {target}")


def install(url):
    """Unpack the one file wanted out of the archive, and make it runnable."""
    BINARY.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "chromedriver.zip"
        with urllib.request.urlopen(url, timeout=300) as response:
            archive.write_bytes(response.read())
        with zipfile.ZipFile(archive) as bundle:
            # Nested under a per-platform directory, so the name is searched for
            # rather than assumed.
            inside = next(
                name
                for name in bundle.namelist()
                if Path(name).name == "chromedriver" and not name.endswith("/")
            )
            with bundle.open(inside) as source, open(BINARY, "wb") as destination:
                shutil.copyfileobj(source, destination)
    BINARY.chmod(BINARY.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def main():
    target = PLATFORM.get((platform.system(), platform.machine()))
    if not target:
        fail(f"no chromedriver for {platform.system()} {platform.machine()}")

    wanted = chrome()
    have = version_of(str(BINARY)) if BINARY.exists() else None
    if have and build(have) == build(wanted):
        print(f"chromedriver {have} already matches Chrome {wanted}")
        return

    url, version = download_url(build(wanted), target)
    install(url)

    # Asked of the file rather than assumed from the archive: an unpacked binary
    # that will not execute is the failure this script exists to prevent, and it
    # is silent until a test run blames the runner.
    landed = version_of(str(BINARY))
    if not landed:
        fail(f"{BINARY} was written but will not run")
    print(f"chromedriver {landed} for Chrome {wanted} → {BINARY.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
