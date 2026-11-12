# Contributing

Escapement is in early development, and its design still changes a lot.

- **Issues** — bugs, questions, ideas — are welcome.
- **Pull requests:** open an issue first, so we agree on the change before you write it.

## Setup

See [Development](README.md#development) in the README.

## Before a pull request

- `pnpm test` passes: Biome (lint and format), rustfmt, clippy, the Rust docs, types, unit tests in TypeScript and Rust.
- `pnpm test:e2e` passes when the change is something the page shows or plays.
- `pnpm test:mutants` passes when the change is in Rust. A mutant that survives wants a test, unless no one could hear
  it or no Rust test can reach it: then it goes into `.cargo/mutants.toml` with its reason.
- After a change to `schema/engine.fbs` or to the plugin catalog, `pnpm gen` is run and its output committed.
- `pnpm format` formats everything Biome and rustfmt cover.

## Code

- TypeScript is strict and functional; Effect runs the orchestration. Choose with Effect — `Option`, `Boolean.match`,
  `Match` — not `if`, `?:` or `switch`: a Biome plugin (`biome-plugins/control-flow.grit`) flags them outside the
  files `biome.jsonc` leaves out.
- A comment says what the code can't: one line where it earns its place.
- The interface is in English.

## Commits and pull requests

- A commit is one change, with a short imperative subject in English.
- Branch off `main`: `feature/…`, `fix/…`, `chore/…`.
- `main` takes only commits CI has checked; pull requests are merged by rebase.

## License

By contributing, you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE), as the rest of the project.
