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
- **No list in the document holds an entity, ever.** Order lives as a rank
  inside the entity and a collection is always a map keyed by identity (§2.6,
  2026-09-07). Yrs has no move operation, so a list would be reordered by
  deleting and re-inserting; the entity is a map of registers, the insert builds
  a *new* map, and whatever somebody else was writing to the old one lands on a
  tombstone. Measured: 432 of 3474 edits gone over 2000 random rounds — and both
  replicas agreed on every one, so a convergence test passes while the document
  is wrong. Reaching for a list gives this up while still compiling.
- **A rank is compared, never parsed.** It is an opaque type like `Position` and
  the identity, its ordering *is* its meaning, and reading it as a number invents
  an arithmetic the merge does not have. Minting one needs a key strictly between
  two keys, a longer key when there is no room, and the peer on the end so two
  people filling one gap do not agree on a key by accident. Ties in the sort are
  broken by identity, or two replicas draw the same document in two orders.
- **A pattern is referenced, never copied** (§2.6). A playlist instance points at
  the pattern, so editing it changes all twenty places it plays. The shape holds
  on either side: a channel, a track and a mixer insert are three entities
  rather than one fused thing, and playlist lanes are visual rather than
  routing. A copy at any of the three is what makes the model
  Ableton-shaped, and unpicking that later is the rewrite §2.6 exists to avoid.
- **An edge with one end is a register on the many side, never a list on the
  one side** (§2.6). A channel holds the insert it feeds and a clip holds its
  lane; an insert listing its channels merges two people's moves into a channel
  feeding two inserts, which the audio graph has no reading of. The many-to-many
  that does exist is a send between inserts, and it brings the cycle with it.
- **An entity is a map of registers, one per field, never one value** (§2.6).
  Two people change different fields of one channel far more often than they
  change the same one, and a whole-entity value keeps only the later writer.
  Measured: registers cost 1.6x the saved document and a little over twice the
  memory, and 2.6x *less* traffic while a curve is drawn. How often the
  document is committed does not reach the wire at all, so the rate the
  interface draws at is nobody else's business.
- **A rank only where the order is the data; nothing but identity everywhere
  else** (§2.6). Lanes, channels and inserts were arranged by a person and carry
  a rank. Clips, notes and automation points have a position instead, and a rank
  on them would be a second ordering to keep true. The two maps of §2.5 are the
  same rule reached from the other end.
- **Identity is 128 random bits behind an opaque type — except an asset's, which
  is the hash of its bytes** (§2.6, §2.4). A counter needs somebody to hand out
  numbers, and two people offline both reach four; a peer and a private counter
  halve the key and buy a collision the day the counter does not survive a
  reload. Minting an asset an identity of its own throws away the deduplication
  a content-addressed store gives for free. In the document it is spelled as 22
  base64 characters, and it is stored once per *occurrence* rather than once per
  entity — every reference between entities is a name, so a clip carries three.
- **A dangling reference is legal, and every read of one returns an absence**
  (§2.6). A deletes a pattern while B places its twenty-first instance; nothing
  prevents it, because the two edits never met. Resolution answers with an
  option, the sequencer skips what does not resolve, and a channel whose insert
  is gone falls silent rather than to the master — a merge that reroutes audio
  nobody rerouted is worse than one that stops it audibly.
- **A field no constructor accepts makes its entity absent, and the timeline is
  the exception** (§2.6). A gain out of range or a denominator that does not
  divide a whole note comes from a bug or a damaged file rather than from a
  merge, and absence is a state every read site already handles. The timeline
  cannot be absent, so an unreadable tempo or signature falls back to the
  default instead — refusing to open the document is the one outcome none of
  these rules permit.
- **The document carries its own version, from the first struct** (§2.6). The
  header of the shared region carries one for a weaker version of the same
  reason (§3); a project outlives a client by years. It cannot be added later,
  because the documents that would need it are the ones already written.
- **Undo belongs to its author, and comes from the library.** "Undo my last
  action" is not "undo the last action" — a known hard problem, and one that
  looks easy right up until a second person is in the document (§3). Yrs has it,
  measured (§2.4), and it is scoped by **transaction origin**: a write made in a
  transaction that does not carry ours is simply not on the undo stack. Nothing
  reports that, so every transaction the model opens on the user's behalf tags
  itself, and the ones that must not be undoable — applying a remote update —
  are the exception that has to be deliberate.
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
