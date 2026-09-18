# Contributing to escapement

escapement is a browser DAW with real-time collaborative editing. The
project is early: the architecture is written down, and the code so far
is the engine boundary generated from `schema/`. Start with
[docs/architecture.md](docs/architecture.md) and the
[decision records](docs/adr/README.md) — they explain not just what the
project is, but why it is shaped that way.

## Before you write code

The project is early enough that a large unsolicited pull request is
likely to collide with a decision that is already made. Open an issue
first and describe what you want to change. For anything that touches
the architecture, expect the discussion to end in a new ADR.

## The rules that are not obvious

- **Everything in this repository is in English** — code, comments,
  identifiers, documentation, commit messages, issues and pull requests.
- **Architecture decisions live in ADRs.** One decision per file in
  `docs/adr/`, following [the template](docs/adr/template.md). An
  accepted ADR is not rewritten in substance: if a decision changes, add
  a new ADR and mark the old one superseded.
- **No secrets in the repository.** Not in code, not in tests, not in
  fixtures. Infrastructure, deployment configuration and anything
  operational live in a separate private repository, by
  [ADR-0012](docs/adr/0012-license-and-public-repo.md).
- **The real-time rules are not style preferences.** No allocations, no
  locks, no panics in the audio path; see
  [ADR-0002](docs/adr/0002-engine-rust-wasm-audioworklet.md). Code that
  breaks them will be rejected however clean it looks.
- **Every project edit goes through a domain operation.** Nothing writes
  into the Yjs document directly outside `packages/document`; see
  [ADR-0007](docs/adr/0007-domain-operations.md).
- **Functional wherever it is possible.** Free functions and plain
  immutable data, not objects carrying identity and mutable state; see
  [ADR-0018](docs/adr/0018-functional-by-default.md). On the audio path
  this is the same answer the real-time rules give: a function taking
  data and returning data is the only shape that allocates nothing.
- **Comments are rationed.** A file header may say what the file is for
  and record a non-obvious decision. Inside the code, comment only where
  the reason cannot be read off the code itself. Code buried in
  commentary is harder to read, not easier.
- **The engine boundary is generated from `schema/`.** Do not hand-write
  offsets or enum values on either side; see
  [ADR-0011](docs/adr/0011-engine-boundary-schema.md).

## Branches, commits and pull requests

- Branch names are `<type>/<short-name>`: `feature/piano-roll`,
  `fix/ring-buffer-overrun`, `chore/ci`, `docs/adr-0013`,
  `refactor/atom-adapter`.
- Commit subjects follow
  [Conventional Commits](https://www.conventionalcommits.org):
  `feat(engine): add voice pool`.
- **Keep the subject line the whole message.** Add a body only for a
  decision the diff cannot show, and then one or two sentences. Nobody
  reads a wall of text, and an ADR is the place for reasoning.
- One logical change per pull request — the documentation a change adds
  or makes stale is part of that change, not a separate one. Keep
  unrelated cleanups out of it.
- Say in the pull request how you tested the change.

## Licensing of your contribution

Contributions are accepted under a
[Contributor License Agreement](CLA.md). When you open your first pull
request a maintainer will ask you to accept it in the pull request
itself; that happens once, not per pull request. There is no CLA bot
because no maintained one exists, see
[ADR-0014](docs/adr/0014-tooling-and-ci.md). The reasoning is in
[ADR-0012](docs/adr/0012-license-and-public-repo.md): without it the
project could not grant commercial exceptions to its own license.

Your contribution is licensed under whichever license applies to the
part of the repository it lands in, as set out in [NOTICE](NOTICE). Note
in particular that the plugin contract and the boundary schema
(`schema/`, `crates/plugin-sdk`, `crates/protocol`,
`packages/plugin-sdk`, `packages/protocol`) are **Apache-2.0**, not AGPL, so that plugin
authors never have to think about our license.

## Security

Do not report security problems in public issues. Use the process in
[SECURITY.md](SECURITY.md).

## Code of conduct

Be straightforward and civil. Argue about the work, not about the
person. Maintainers may remove comments and close threads that make the
project a worse place to work.
