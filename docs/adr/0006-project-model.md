# ADR-0006. Project model and workflow

- Status: accepted
- Date: 2026-09-17

## Context

escapement is built around a pattern-based workflow: notes live in
patterns, and patterns are arranged on a playlist whose tracks are not
tied to instruments.

That differs markedly from the more common model where an instrument
owns a track and its clips. The difference is structural, not cosmetic,
so it has to be baked into the data from the start; changing the model
later is expensive.

## Decision

### Entities

- **Channel** (channel rack) — a generator, sampler or instrument. Every channel is routed to a mixer insert.
- **Pattern** — a container of notes for several channels at once. The step sequencer and the piano roll are two views of the same data.
- **Arrangement** (playlist):
  - tracks are not bound to instruments;
  - any track takes clips of three kinds: pattern, audio, automation;
  - a project can hold several arrangements. When collaborating, patterns are shared while each person can keep their own draft arrangement.
- **Mixer** — inserts with effect slots, routing from any insert into any other, sends, sidechain, plugin delay compensation (PDC).
- **Automation clip** — a separate entity, bound to any parameter.
- **Make unique** — a pattern instance can be turned into an independent copy. In multiplayer this is also a way to avoid conflicts.
- **Note properties**: velocity, pan, release, mod X/Y, fine pitch, slide.

Storage in Yjs is covered by [ADR-0003](0003-crdt-yjs.md).

### The workflow we are building

This is a backlog, not an order of work.

**Editing**
- Ghost notes: notes from other channels shown dimmed in the piano roll.
- Piano roll tools: chop, glue, strum, arpeggiate, quantize, scale highlighting, chord input.
- Painting clips in the playlist: pick a pattern, then paint with the left button and erase with the right.
- An action history with named steps.
- Scripts for the piano roll and MIDI controllers, written in TS ([ADR-0008](0008-plugins.md)).

**Recording**
- Retrospective MIDI capture: everything played over MIDI in the last few minutes is kept and can be dumped into a pattern after the fact.

**Mixer and automation**
- An automation clip for any parameter in one click.
- "Last tweaked parameter", MIDI learn.
- A modular plugin graph in the future.

**Performance** — especially important in a browser
- Smart disable: a plugin switches itself off when its input goes silent.
- Freeze / render to audio: a channel or pattern is frozen to audio to free up CPU.

**Workflow**
- Everything is keyboard-driven; windows open and close on hotkeys.
- A sample browser with click-to-preview and drag-and-drop into the rack or playlist.
- Project templates.

## Consequences

- From day one the data model supports patterns, instrument-free tracks and multiple arrangements.
- The same note data is shown in two editors, and both have to stay consistent.
- Smart disable and freeze shape the plugin and engine APIs: a silence signal and offline rendering of part of a project ([ADR-0002](0002-engine-rust-wasm-audioworklet.md), [ADR-0008](0008-plugins.md)).
- The interface is ours to design. These entities and techniques constrain what it has to express, not what it has to look like.

## Alternatives considered

- **A track model where an instrument owns a track.** Simpler to implement and familiar to more people, but it gives up the pattern as a reusable unit shared across channels, which is the centre of the workflow we want.
- **Patterns without multiple arrangements.** Cheaper, but a single arrangement forces collaborators to fight over one timeline instead of each keeping a draft.
