# escapement

A browser DAW with real-time collaborative editing.

- **A real product**, not a demo of a technique.
- **FL Studio is the reference** for techniques and the feel of working —
  patterns, channel rack, playlist, mixer. Not for the interface, which
  is ours.
- **2–5 people in a room**, editing the same project at once, with the
  project surviving network drops.
- **Rust engine** compiled to WASM, running in an AudioWorklet;
  **TypeScript** for the document, the sync layer, the server and the
  interface.
- **Plugins** in Rust and in TS, on one versioned contract.

**Status: design stage.** The architecture is settled and written down;
there is no code yet. The place to start is
[docs/architecture.md](docs/architecture.md), and the reasoning behind
each choice is in the [decision records](docs/adr/README.md) — including
the ones that look surprising, such as [why the CRDT is Yjs rather than
a Rust one](docs/adr/0003-crdt-yjs.md) and [what the two-language engine
boundary costs](docs/adr/0011-engine-boundary-schema.md).

## Licensing

| Part | License |
|---|---|
| Application and engine | [AGPL-3.0-only](LICENSE) + [plugin exception](LICENSE-PLUGIN-EXCEPTION) |
| Plugin contract and boundary schema | Apache-2.0 |
| Documentation | CC-BY-4.0 |

You may run escapement yourself, modify it and distribute it; if you
offer a modified version as a network service, the AGPL asks you to
offer its source to users too. **Plugins are exempt from copyleft**: a
module that talks to the host only through the published plugin ABI is
not a derivative work of the host and can be licensed however its author
likes. The details are in [NOTICE](NOTICE) and
[ADR-0012](docs/adr/0012-license-and-public-repo.md).

The name and the logo are not covered by those licenses; see
[TRADEMARK.md](TRADEMARK.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — the project is early, so
opening an issue before writing code saves everyone time. Contributions
are accepted under a [CLA](CLA.md).

Security problems go through [SECURITY.md](SECURITY.md), never a public
issue.
