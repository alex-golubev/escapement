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
  on either side: a channel, a track and a mixer insert are three entities
  rather than one fused thing, and playlist lanes are visual rather than
  routing. A copy at any of the three is what makes the model
  Ableton-shaped, and unpicking that later is the rewrite §2.6 exists to avoid.
- **An edge with one end is a register on the many side, never a list on the
  one side** (§2.6). A channel holds the insert it feeds and a clip holds its
  lane; an insert listing its channels merges two people's moves into a channel
  feeding two inserts, which the audio graph has no reading of. The many-to-many
  that does exist is a send between inserts, and it brings the cycle with it.
- **A movable list only where the order is the data; a map keyed by identity
  everywhere else** (§2.6). Lanes, channels and inserts were arranged by a
  person. Clips, notes and automation points have a position instead, and in a
  list every insertion merges at an index none of them chose. The two maps of
  §2.5 are the same rule reached from the other end.
- **Identity is 128 random bits behind an opaque type — except an asset's, which
  is the hash of its bytes** (§2.6, §2.4). A counter needs somebody to hand out
  numbers, and two people offline both reach four; a peer and a private counter
  halve the key and buy a collision the day the counter does not survive a
  reload. Minting an asset an identity of its own throws away the deduplication
  a content-addressed store gives for free.
- **A dangling reference is legal, and every read of one returns an absence**
  (§2.6). A deletes a pattern while B places its twenty-first instance; nothing
  prevents it, because the two edits never met. Resolution answers with an
  option, the sequencer skips what does not resolve, and a channel whose insert
  is gone falls silent rather than to the master — a merge that reroutes audio
  nobody rerouted is worse than one that stops it audibly.
- **The document carries its own version, from the first struct** (§2.6). The
  header of the shared region carries one for a weaker version of the same
  reason (§3); a project outlives a client by years. It cannot be added later,
  because the documents that would need it are the ones already written.
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
