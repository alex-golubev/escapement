# Escapement

A collaborative DAW in the browser.

Early development — nothing usable yet.

## Stack

- UI: TypeScript, Preact, dockview; Effect for orchestration
- Project model: Yjs, so several people can work on one project
- Audio engine: Rust compiled to WebAssembly, running in an AudioWorklet over shared memory

## Development

Needs Node 26.12+, pnpm 12 and rustup; the Rust toolchain comes from `rust-toolchain.toml`.

```sh
pnpm install
pnpm dev        # the app on a local Vite server
pnpm test       # lint, types, unit tests in TypeScript and Rust
pnpm test:e2e   # the app in a real browser
```

## License

[AGPL-3.0](LICENSE)
