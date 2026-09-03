---
paths:
  - "crates/*/build.rs"
  - ".cargo/config.toml"
  - "Trunk.toml"
  - "web/**"
  - "tools/build-worklet.sh"
  - "tools/dev-server.py"
---

# Building the two wasm modules

Two of these break only in the browser, long after the build that caused them
succeeded.

- **`+atomics` alone does not give you shared memory.** The feature flag makes
  atomic instructions available but still links a *private* memory; shared memory
  must be requested from the linker (`--shared-memory`, legal only with
  `--max-memory`). Dropping those link args still builds, still produces valid
  wasm, and fails only in the browser — pointing at the wasm rather than at the
  flag. `tools/check-shared-memory.py` guards this in CI.
- **The worklet's memory is fixed and the UI's grows**, so their link args live in
  `crates/*/build.rs`, not in `.cargo/config.toml` — `rustflags` there apply to
  every crate built for the target and cannot tell the two apart. `memory.grow` is
  not bounded and a quantum is 2.7 ms, so the worklet links `--initial-memory`
  equal to `--max-memory` (§1); shared memory reserves its maximum up front
  regardless, so growth would buy nothing. Note this is *not* about stale views —
  growing a **shared** memory keeps them valid, unlike a private one. CI checks it
  with `--fixed`.
- **`build-std` and `cargo miri` collide.** `build-std` engages whenever
  `--target` is passed, and `cargo miri` passes one — for the host. Miri builds
  its own sysroot as well, and the two fight over `core`. It fails inside
  `compiler_builtins` with hundreds of "cannot find `Some` in this scope", which
  points nowhere near the cause. Cargo finds `.cargo/config.toml` by walking up
  from the *working directory*, not from the manifest, so `tools/miri.sh` runs
  from outside the repository and points cargo back at it.

## The rest of the configuration

- `.cargo/config.toml` enables `+simd128` and `+atomics,+bulk-memory,+mutable-globals`
  for the whole target — they change the ABI, so every crate in the link must agree.
  Memory link args are per crate in `crates/*/build.rs`. The toolchain is a **pinned
  dated nightly** — atomics-enabled wasm needs std rebuilt from source
  (`build-std`), which is nightly-only. The pin is dated on purpose: CI runs clippy
  with `-D warnings`, and a floating nightly reddens untouched trees.
- `build-std` only engages when `--target` is passed explicitly, so host builds and
  `cargo test` keep using the prebuilt std and stay fast.
- **Install host tooling with `cargo +stable install`** — `cargo +stable install
  trunk`, never plain `cargo install trunk`. Run inside the repo, `cargo install`
  picks up the pinned nightly and builds the tool with it; trunk's dependency
  `lightningcss` does not compile there. Trunk is a host binary and has nothing
  to do with the wasm toolchain.
- **Two builders, one output directory, and Trunk owns it.** Trunk builds the
  interface and clears `dist` on every build. The worklet is still built by a
  script of its own — `tools/build-worklet.sh`, which is where its three checks
  live — but Trunk runs it as a pre-build hook and copies the result in, rather
  than the two assembling directories side by side. That is what keeps
  `index.html` from being whichever builder ran last, which is what the earlier
  arrangement of two directories was avoiding by other means.
- **Two Trunks at once fight over `dist`.** A `trunk build` while `trunk serve`
  is running fails with "error writing finalized HTML output", which names
  neither Trunk nor the directory. Nothing to do with the worklet — stop the
  server first.
- COOP/COEP headers are mandatory for `SharedArrayBuffer`. Sent by `trunk serve`
  from `Trunk.toml` and by `tools/dev-server.py`; production hosting must send
  the same. Without them the failure looks like broken wasm rather than a missing
  header.
- **wasm-opt is off** (`data-wasm-opt="0"` on the rust link in `web/index.html`).
  It is a third tool after cargo and `wasm-bindgen` able to change the module
  quietly, and on one carrying atomics, shared memory and simd128 it has to be
  told about each of them or it refuses or strips. Turning it on is worth a
  measurement of its own rather than a default.
- `escapement-app` is built with `opt-level = "s"`; everything else with `3` + LTO.
