---
paths:
  - "Cargo.toml"
  - "crates/*/Cargo.toml"
  - "deny.toml"
---

# What may be linked into a bundle

- **No whole-program copyleft, ever** — GPL, AGPL, SSPL. Shipping a wasm bundle
  to a browser is distribution, so such a dependency would force the whole
  product to follow it. This is why time-stretch is Signalsmith rather than
  Rubber Band. File-level copyleft is a different category and is allowed:
  MPL keeps its own files and leaves the product's license alone, at the cost
  of an attribution page. `deny.toml` is the allow-list and carries the bar for
  adding to it; the `licenses` job in CI is what makes this one of the few
  invariants here that a machine checks rather than a person remembers.
- A dependency that allocates internally also breaks the real-time thread without
  saying so — see `.claude/rules/rt-safety.md` before adding one under
  `crates/core` or `crates/worklet`.
