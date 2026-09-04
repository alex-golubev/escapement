---
paths:
  - "crates/model/**"
---

# The project document

The one place where a mistake is a rewrite rather than a fix. §2.4 and §2.6 fix
both of this crate's shapes — collaboration and entities — before its first line,
and §2.5 names what shuts the door on them: the first saved project.

- **The document is CRDT-shaped from the first struct.** Not "make it work, then
  make it concurrent": bolting collaborative editing onto a finished model with
  undo/redo is a core rewrite (§2.4), and the model that would have to be
  rewritten is precisely the one that works perfectly for one person. Multiplayer
  is the axis this product is differentiated on, not a feature waiting its turn.
- **Reordering goes through Loro's movable list, never delete-then-insert.** That
  list is the whole reason Loro was taken over Yrs (§2.4), and reaching for an
  ordinary list gives the reason up while still compiling. Two people reordering
  one track under delete-plus-insert end with two identical tracks or none, which
  arrives as a bug from nowhere long after the edit that caused it.
- **A pattern is referenced, never copied** (§2.6). A playlist instance points at
  the pattern, so editing it changes all twenty places it plays. The shape holds
  on either side: a channel, a track and a mixer insert are three entities in a
  many-to-many relation rather than one fused thing, and playlist lanes are
  visual rather than routing. A copy at any of the three is what makes the model
  Ableton-shaped, and unpicking that later is the rewrite §2.6 exists to avoid.
- **Undo belongs to its author, and comes from Loro.** "Undo my last action" is
  not "undo the last action" — a known hard problem, and one that looks easy
  right up until a second person is in the document (§3). Whether Loro has an
  author-scoped undo manager at all is a slice 2 question (§7), to be answered
  before anything is built on the assumption that it does: if it does not, that
  is a significant amount of work currently accounted for nowhere.
- **Ephemeral state stays out of the document, and so do bytes.** Zoom, scroll,
  selection, playhead, cursors and presence are per-user; so is solo, while mute
  is shared (§2.4). A playhead in the CRDT turns every frame into an operation
  that merges, persists and undoes. Audio assets enter by content hash, with the
  bytes in a store of their own.
- **Automation is a specialized structure, not a generic list.** One drag of the
  mouse is hundreds of operations a second, which is exactly where naive CRDT use
  explodes in memory and traffic (§2.4). It wants a soft lock on the lane, and it
  is worth prototyping before the rest of the model leans on it.
- **The audio thread never reads the document.** The model thread publishes an
  immutable snapshot and the audio thread picks it up through double buffering,
  so it reads something consistent and never waits (§3). Design that before the
  model accumulates code, or the real-time thread ends up reaching into
  structures that mutate underneath it — and once it is reading them,
  `.claude/rules/rt-safety.md` governs what it may do.

Positions in the document are musical and never samples: `musical-time.md` in
this directory governs this crate too.
