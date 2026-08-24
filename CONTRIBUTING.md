# Contributing

## A CLA is required

External changes are accepted **only with a signed CLA** (Contributor License
Agreement).

The reason is simple: without one, contributed code belongs to whoever wrote it.
Changing the project's license would then become impossible — it would require
tracking down everyone who ever sent a patch.

A CLA leaves copyright with the author of the change and grants the project broad
rights, including relicensing. It is not an assignment of copyright.

> **Not set up yet:** a CLA check bot (cla-assistant or equivalent) needs to be
> connected to this repository **before the first external PR**. Until then,
> external changes cannot be accepted.

## Dependency licenses

Every new dependency gets its license checked. **GPL and AGPL are refused, with
no exceptions.** The reason is in the README.

Permissive licenses (MIT, Apache-2.0, BSD, ISC, MPL-2.0) are fine.

## Crate discipline

- `escapement-core` runs on the real-time thread. Allocation, locking, panicking,
  I/O and logging on the processing path are all forbidden. Allocation is allowed
  only while building the graph, before playback starts.
- `escapement-render` must not know about Leptos. No framework types in its
  public API.

The reasoning for both is in ARCHITECTURE.md.
