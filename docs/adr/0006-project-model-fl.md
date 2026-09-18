# ADR-0006. Project model and workflow drawn from FL Studio

- Status: accepted
- Date: 2026-09-17

## Context

FL Studio is escapement's reference for techniques and the feel of working. We do not copy FL's interface.

FL's pattern-based model differs markedly from Ableton-style models. It has to be baked into the data from the start; changing the model later is expensive.

## Decision

### Entities

- **Channel** (channel rack) — a generator, sampler or instrument. Every channel is routed to a mixer insert.
- **Pattern** — a container of notes for several channels at once. The step sequencer and the piano roll are two views of the same data.
- **Arrangement** (playlist):
  - tracks are not bound to instruments;
  - any track takes clips of three kinds: pattern, audio, automation;
  - a project can hold several arrangements (FL gained this in version 20). When collaborating, patterns are shared while each person can keep their own draft arrangement.
- **Mixer** — inserts with effect slots, routing from any insert into any other, sends, sidechain, plugin delay compensation (PDC).
- **Automation clip** — a separate entity, bound to any parameter.
- **Make unique** — a pattern instance can be turned into an independent copy. In multiplayer this is also a way to avoid conflicts.
- **Note properties**: velocity, pan, release, mod X/Y, fine pitch, slide.

Storage in Yjs is covered by [ADR-0003](0003-crdt-yjs.md).

### Techniques we are taking

This is a backlog, not an order of work.

**Editing**
- Ghost notes: notes from other channels shown dimmed in the piano roll.
- Piano roll tools: chop, glue, strum, arpeggiate, quantize, scale highlighting, chord input.
- Painting clips in the playlist: pick a pattern, then paint with the left button and erase with the right.
- An action history with named steps.
- Scripts for the piano roll and MIDI controllers (Python in FL), TS for us ([ADR-0008](0008-plugins.md)).

**Recording**
- Score logger: a retrospective capture of everything played over MIDI in the last few minutes, which can be dumped into a pattern.

**Mixer and automation**
- An automation clip for any parameter in one click.
- "Last tweaked parameter", MIDI learn.
- A modular plugin graph (like Patcher) in the future.

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
- We design the interface ourselves, building on these techniques rather than on FL's looks.

## Alternatives considered

- **An Ableton/Logic-style track model** (instrument = track). Not chosen: FL's workflow is the reference.
- **Copying FL's interface.** Not wanted: we are taking the experience, not the looks.
