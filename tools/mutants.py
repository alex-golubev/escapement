#!/usr/bin/env python3
"""Run cargo-mutants the two ways this project needs, and check they still meet.

Two runs, because half of `escapement-view` and `escapement-app` is reachable
only from a browser: on a host run their mutants survive with nothing wrong with
them, so the host run leaves those two crates out and a second run takes them
against the wasm target.

Nothing about that pairing is visible from either half of it. Leave a third
crate out of the host run, forget to add it to the other, and coverage drops
with no sign anywhere — the class of failure this directory exists for. `check`
is that sign: it asks cargo-mutants for all three lists and fails unless the two
halves add up to the whole.

The split lives here rather than in `ci.yml` so that what is checked and what is
run cannot become two different things.

Usage:  tools/mutants.py host [extra args...]      # everything but those two
        tools/mutants.py browser [extra args...]   # those two, under wasm
        tools/mutants.py check                     # do the two add up
"""

import subprocess
import sys

# Package name and the path its mutants are named by — cargo-mutants filters
# packages by the first and files by the second, and the two runs need one each.
BROWSER_CRATES = (
    ("escapement-view", "crates/view"),
    ("escapement-app", "crates/app"),
)

TARGET = "wasm32-unknown-unknown"

# The host tests are quick. Every mutant in the other run starts a browser,
# which is where its minutes go — not in the tests having grown.
# Enough of a failure to diagnose it. The whole list can be hundreds of lines,
# and a wall of them is read as no message at all.
SHOWN = 8

HOST_TIMEOUT = "10"
BROWSER_TIMEOUT = "120"


def host_args():
    out = ["--timeout", HOST_TIMEOUT]
    for _, path in BROWSER_CRATES:
        out += ["--exclude", f"{path}/**"]
    return out


def browser_args():
    out = ["--timeout", BROWSER_TIMEOUT, f"--cargo-arg=--target={TARGET}"]
    for package, _ in BROWSER_CRATES:
        out += ["-p", package]
    return out


def run(args):
    return subprocess.call(["cargo", "mutants", *args])


def listed(args):
    """The mutants a run would test, as a set of the names cargo-mutants prints.

    A run that could not answer leaves with 2, where a split that does not add
    up leaves with 1: two different failures, and this tool exists to say which.
    """
    done = subprocess.run(
        ["cargo", "mutants", "--list", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        print(f"FAIL `cargo mutants --list` exited {done.returncode}, so the")
        print("     split cannot be checked at all. It said:\n")
        print(done.stderr.strip() or done.stdout.strip() or "(nothing)")
        raise SystemExit(2)

    return {line for line in done.stdout.splitlines() if line.strip()}


def check():
    host = listed(host_args())
    browser = listed(browser_args())
    every = listed([])

    missing = every - host - browser
    if missing:
        print(f"FAIL {len(missing)} mutants are in neither run:")
        shown = sorted(missing)[:SHOWN]
        for name in shown:
            print(f"       {name}")
        if len(missing) > len(shown):
            print(f"       ... and {len(missing) - len(shown)} more")
        print(
            "\nA crate left out of one run has to be named in the other. Both\n"
            "are BROWSER_CRATES in this file; adding to one adds to both."
        )
        return 1

    # Not an error, but it means a crate is being mutated twice and paying for
    # it twice — worth seeing rather than wondering about the minutes.
    both = host & browser
    if both:
        print(f"warn {len(both)} mutants are in both runs")

    print(f"ok   {len(host)} + {len(browser)} covers all {len(every)} mutants")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 2

    mode, extra = argv[0], argv[1:]
    if mode == "check":
        return check()
    if mode == "host":
        return run(host_args() + extra)
    if mode == "browser":
        return run(browser_args() + extra)

    print(f"unknown mode {mode!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
