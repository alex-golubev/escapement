---
name: full-check
description: Run every check this repository has, in the order CI runs them — fmt, clippy, host tests, the wasm build and its three module checks, the browser line, Miri, Loom and mutation testing. Use before opening a pull request, when asked to check the workspace, or to reproduce a red CI job locally.
---

# Run the checks

Run them in this order and stop at the first failure: each step is cheaper than
the one after it, and a later step run on code that fails an earlier one usually
fails for the earlier reason.

## 1. The ordinary checks — seconds

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`-D warnings` is what CI uses; a warning here is a red build there.

## 2. The wasm build and what it must produce

```sh
cargo build --workspace --target wasm32-unknown-unknown --release
python3 tools/check-shared-memory.py target/wasm32-unknown-unknown/release/*.wasm
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm
```

The three scripts catch what a successful build does not say: a memory that came
out private, a worklet memory that can grow, and an import section or an
allocator in the module that runs on the audio thread. A failure here points at
the link args in `crates/*/build.rs`, not at the code.

## 3. The browser line

```sh
cargo test -p escapement-view -p escapement-app --target wasm32-unknown-unknown
```

The only thing that reaches `escapement-view`'s `Atomics` calls and the question
of whether `escapement-app`'s memory came out shared. Needs two host tools
installed:

```sh
cargo +stable install wasm-bindgen-cli --version 0.2.127   # must match Cargo.lock
brew install --cask chromedriver                           # major must match Chrome
```

If chromedriver is missing or its major version does not match the installed
Chrome, this step fails on the runner rather than on the code — say so and move
on rather than editing anything.

## 4. Undefined behaviour, orderings, and whether the tests test anything

```sh
tools/miri.sh -p escapement-protocol -p escapement-worklet
RUSTFLAGS="--cfg loom" cargo test -p escapement-protocol
tools/mutants.py check
```

Miri takes a crate list and never `--workspace`; `tools/miri.sh` exists because
`build-std` and `cargo miri` fight over `core`. `tools/mutants.py check` only
asks whether the two mutation runs still add up — it is fast. The runs
themselves are diff-scoped in CI; locally, run one when a change adds logic:

```sh
python3 tools/mutants.py host --in-diff /tmp/pr.diff   # after: git diff origin/main...HEAD > /tmp/pr.diff
```

Surviving mutants on `Cells::fence_release` and `fence_acquire` are expected —
`.claude/rules/protocol.md` says why.

`cargo-mutants` is a host tool of its own, and `+stable` for the reason in
`.claude/rules/wasm-build.md`:

```sh
cargo +stable install cargo-mutants
```

Without it the step fails as `error: no such command: mutants` — the runner
rather than the code, like a missing chromedriver above.

## 5. Licenses, when a dependency changed

```sh
cargo deny check licenses bans sources
```

`cargo +stable install cargo-deny` if it is not there — the runner again, not
the code.

## Reporting

Report the first failure with the command that produced it and the part of the
output that names the cause. Do not fix a failure in step 3 or 4 by weakening a
test, a `cfg`, or an entry in `.cargo/mutants.toml` without saying that is what
the fix is.
