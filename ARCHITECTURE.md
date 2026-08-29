# Escapement — Architecture Notes

> Status: **pre-project recommendations**, not a final design.
> Date: 2026-08-24. Project: a browser DAW with a Rust (WASM) core.

---

## 0. Summary

The stack is the right call. Rust → WASM inside an `AudioWorklet` is currently the
only sane way to build an actual DAW in a browser, rather than "a player with
effects".

**Target scenario: sample-based production** (loop-based production, beatmaking).
Live recording is out for now; see §2.2 for why this removes a *hard* constraint
rather than merely cutting scope.

**Axis of differentiation: multiplayer.** The sample-based niche is crowded on
tooling but empty on collaboration. It is the one answer to "why a browser rather
than native" that native cannot copy. This turns the project into a **service**,
not a web app (§2.4).

The v1 target is **co-editing** (each person has their own playback). Listening
together and live jamming are later rungs of the same ladder — designed for, but
not built.

**Reference product: FL Studio.** This is a long-term project. That is not a
cosmetic detail — FL differs from Ableton in the *shape of its data*, and that
shapes the project model (§2.6). The product's identity is **patterns, the step
sequencer, the piano roll and the playlist**, not warping.

But there are **six decisions that must be made before the first line of code** —
none of them can be replayed after the fact (see §2).

Native Web Audio nodes (`BiquadFilterNode`, `GainNode` and friends) are useless
for a DAW:

- no sample-accurate automation;
- no control over processing order;
- no plugin delay compensation of your own.

A custom graph in Rust is the right move.

---

## 1. Platform constraints to design around from day one

### AudioWorklet

| Constraint | Consequence |
|---|---|
| Render quantum is hard-wired at **128 samples** and cannot be changed | The engine's internal block size is a multiple of 128, or exactly 128 |
| **No allocation** in the audio callback | Preallocated pools, arena allocator, fixed WASM memory size with no `memory.grow` |
| **No `fetch`** inside `AudioWorkletGlobalScope` | The compiled `WebAssembly.Module` arrives via `processorOptions` or `port.postMessage` |
| Real-time thread | No mutexes, no allocation, no panics, no logging across the boundary |

### Cross-origin isolation

`SharedArrayBuffer` requires:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Build this into hosting **from day one**. Remember it breaks embedding of
third-party iframes, some CDNs and OAuth popups.

### Latency — the honest numbers

- Desktop Chrome, output: **~10–30 ms**
- With `getUserMedia` on input, round-trip: **20–60 ms** depending on the OS
  (per-platform breakdown in §2.2a)

That is "tolerable on headphones", but it is not Reaper with ASIO.

Separately: by default the input path runs through **echo cancellation and AGC** —
these must be explicitly disabled in the constraints (`echoCancellation: false`,
`autoGainControl: false`, `noiseSuppression: false`), otherwise you are recording
a processed signal.

If the product is about recording live instruments, this latency cannot be
optimized away — but it does not block recording either: hardware direct
monitoring works around it. Full analysis in **§2.2**.

---

## 2. Decisions to make before the first line of code

| # | Decision | Status |
|---|---|---|
| 2.1 | Worklet or worker | 🔵 Recommendation: graph in the worklet |
| 2.2 | Latency / live recording | ✅ **Decided:** target is samples, live recording deferred |
| 2.3 | Plugins | 🔵 Recommendation: own ABI + WAM 2.0 |
| 2.4 | Collaboration | ✅ **Decided:** multiplayer is required → CRDT (**Loro**) from day one |
| 2.5 | Musical time model | ✅ Mandatory from day one (follows from 2.2) |
| 2.6 | Project model entities | ✅ FL-shaped — cannot be unpicked later |

### 2.1. Where audio is rendered: worklet or worker?

The two options produce **different products**:

**A. Graph in the worklet**
- ✅ Low latency, live monitoring, playable instruments
- ❌ Permanently imprisoned on the RT thread: no allocation, no locks, no room for error

**B. Graph in a worker, worklet only drains a ring buffer**
- ✅ Freedom: allocation, large buffers, ordinary debugging
- ❌ +50–100 ms of latency

**Recommendation:** option A, with the heavy work (disk streaming, decoding,
waveform peaks, offline render) pushed into workers. The link between them is a
**lock-free SPSC ring buffer over SharedArrayBuffer**. No mutexes across the RT
boundary.

### 2.2. Latency and recording live instruments

This is not one problem but four, of different magnitudes. Three of the four are
solvable; one is not solvable at all. Keeping them apart matters — they get
conflated constantly.

#### (a) Monitoring — not solvable

You play and hear yourself late. Round-trip:
input → OS → browser → worklet → OS → output.

**Chrome supports neither ASIO nor WASAPI exclusive mode.**

| Platform | Round-trip |
|---|---|
| Windows (WASAPI shared) | 30–60 ms |
| macOS (CoreAudio) | 20–40 ms |
| *Native DAW + ASIO @128* | *6–10 ms* |

Musicians tolerate roughly 10–12 ms. Singers have it worst: you also hear your own
voice through bone conduction, and the direct sound layered over the delayed one
produces comb filtering — a "flanged doubling" that is noticeable at 10 ms.

**This cannot be optimized.** It is a limit of the browser's audio stack, not of
our code.

#### (b) The workaround that removes 80% of the problem

**Hardware direct monitoring.** Any decent interface (Scarlett, MOTU, RME, UA,
PreSonus) mixes the input into the headphones internally, never touching the
computer. Zero latency, and the browser is not involved.

The DAW's job is then to **not monitor a second time**, so nothing is heard twice.
That means an explicit per-track monitoring mode (off / hardware / software).

Overdubbing a single source with an interface and direct monitoring works
properly. This is how people track in native DAWs too — it is not a compromise.

It breaks down where you need to hear yourself **through our processing**:

- a guitarist wants to hear an amp, not a dry DI ← the painful case;
- a singer wants reverb "for confidence";
- a laptop mic with no interface — there is physically no direct monitoring.

#### (c) Aligning recordings to the timeline — solvable, and mandatory

The input stream arrives late. Naively stamping recorded chunks with "now" puts
everything on the timeline 20–50 ms late — by an amount that is **unknown and
device-dependent**. That is the difference between a DAW and a toy.

- `AudioContext.outputLatency` + `baseLatency` cover the output side.
- **There is no reliable API for input latency** — the key gap.
- Hence **loopback calibration**: emit an impulse, record it back (via a cable, or
  headphones held to the mic), measure the real round-trip in samples, remember it
  per device. Native DAWs do exactly this.
- Plus a manual per-take nudge in the UI as an escape hatch.
- Store the offset in the project so it stays derivable.

For capture, look at `MediaStreamTrackProcessor` (Chrome only): it hands you
`AudioData` with explicit timestamps rather than "whatever showed up in this render
quantum" via `MediaStreamAudioSourceNode`.

#### (d) Clock drift — solvable by discipline

If input and output are **different physical devices**, their crystals are
independent and they drift apart. Over a five-minute take it is already audible.
Chrome hides this by resampling the input to the `AudioContext` rate, but the
resampling is opaque and adds unknown latency of its own.

→ Detect mismatched devices and warn. One interface for both input and output is
the only sane configuration.

#### (e) Dropouts — solvable architecturally

The worklet runs on an RT thread, but a browser is not an RTOS. Tab throttling,
neighbouring tabs, compositor pressure, and your own UI. A glitch mid-take is
unforgivable: you lose a performance, not a second of audio.

A direct architectural requirement:

```
capture → ring buffer → worker → OPFS
```

Continuously, never buffering an entire take in memory, with the UI thread never
touching it. Plus an honest "this take glitched" indicator.

**A trick:** if the user monitors through hardware, low latency is unnecessary —
take a large buffer and buy reliability with it.
⚠️ Caveat: `latencyHint` is set when the `AudioContext` is created and cannot be
changed on the fly, so a "recording mode" requires recreating the context. Design
the session around that.

#### Verdict

| Scenario | Status |
|---|---|
| Overdub of one source + interface + direct monitoring | ✅ **Works** properly |
| Monitoring through our effects (amp sim) | ❌ **Does not work.** macOS just barely, Windows badly |
| Multi-mic recording (drums, a band) | ❌ **Do not promise it.** Multichannel input in browsers is weak and uneven |
| Landing on the grid | ⚠️ Solvable, but **calibration has to be built** |

The conclusion is not "there will be no live recording". It is that live recording
is a **supported workflow with a documented hardware requirement**, not a headline
feature. That is a reasonable position. What would be unreasonable is promising
"record guitar through our tube preamp in real time".

#### ✅ Decision taken

**Target: sample-based production. Live recording deferred.**

This removes a **hard** constraint rather than merely cutting scope. Two thresholds
need to be told apart:

| Threshold | Value | Does the browser meet it |
|---|---|---|
| Monitoring an acoustic source | 10–12 ms | ❌ No |
| Triggering from a MIDI controller | ~25–30 ms is tolerable | ✅ Yes |

A pad feels slightly soft but remains playable: there is no comb filtering, because
there is no direct acoustic path from the instrument to the ear. Sample-based work
only ever hits the second threshold.

**Direct consequences:**

1. The `AudioContext` is created with **`latencyHint: 'playback'` by default** —
   large buffers, far fewer dropouts, DSP headroom per block, tolerance for UI
   load. The trick from §2.2e stops being a compromise and becomes the default.
   Switching to `'interactive'` only when a MIDI controller is connected (which
   requires recreating the context).
2. The entire recording path — loopback calibration, streaming capture into OPFS,
   clock drift detection — **leaves the critical path**. Not built now.
3. The difficulty **does not disappear, it relocates** — into time-stretching (§5),
   the sample library, the sampler, and the time model (§2.5).

The material above (a–e) is kept as finished analysis for whenever live recording
comes back into scope.

### 2.3. Plugins — own format or WAM?

This is where a DAW lives or dies. **VST/AU are fundamentally impossible in a
browser.**

> ⚠️ **Weight increased after §2.6.** FL's identity is heavily tied to its own
> instruments, and this is a long-term project — so an internal device ABI is
> needed early and needs to be good, because everything else will stand on it.
> This is still a recommendation, not a decision (see the table at the top of §2).

**Recommendation — both:**
- A custom ABI on Rust traits for built-in devices: fast, in-process, no overhead
- **WAM 2.0** (Web Audio Modules) — the de facto standard for browser plugins, as
  the extension point for third parties

### 2.4. Collaboration — ✅ decided: multiplayer is required

The project model is **CRDT-compatible from the very beginning**. Bolting
collaborative editing onto a finished model with undo/redo is a core rewrite, not
a feature.

#### ✅ Decided: a ladder, with co-editing as the target

This is not a choice between three options but a **ladder**: each rung builds on
the previous one and is worth having on its own.

| Rung | What | Status |
|---|---|---|
| **1. Co-editing** | Two people edit one project, each with their own playhead and playback | ✅ **v1 target** |
| **2. "Listening together"** | Follow mode: one person drives, the others listen along | 🔵 Not built, but designed for |
| **3. Live jam** | Both play into a session and hear each other | ⬜ Out of scope, door left open |

**Co-editing ≠ shared playback.** Figma does not synchronize anyone's playback.

#### Rung 1 — the foundation

Requires nothing beyond what slice 2 already covers (CRDT, transport, presence).
A works on drums, B works on bass, and each sees the other's changes immediately:
when A hits play, they hear B's latest bass — just not in sync with B.

#### Rung 2 — not an audio feature but a "we're in the same room" feature

Simultaneity only means something **if people are also talking**. Otherwise "listen
from bar 33" does the job. The honest version of rung 2 is a "listening session" =
synchronized transport **plus voice**, which is a considerably larger chunk of
product than the name suggests.

The cheap variant covering 90% of the value is **follow mode**: one person drives,
the others watch and listen along, like a spectator in Figma. It is asymmetric and
therefore much simpler — no clock negotiation, A simply broadcasts "I am at
position P" and B slaves to it.

> **For listening along, latency does not have to be zero — it has to be stable.**
> If B runs 200 ms behind A, nobody notices. This is listening together, not
> playing together.

#### Rung 3 — a different product surface

**Low latency is not needed here** as long as everything is quantized to bars: at
120 bpm a bar is two seconds, and a network round-trip fits with room to spare.
A plays a loop, it commits on the next bar, B hears it from the next bar. This is
how Endlesss worked.

But it means a clip launcher instead of a timeline and sessions instead of
projects — essentially Ableton's Session View plus multiplayer. Not the first
version.

#### ⚠️ The one architectural requirement from the whole ladder

> **The transport must be drivable from outside.**
> The engine accepts "start at position P at host time T", not only "play now".

If the transport is purely local UI state, rung 2 later means threading control
through every layer. Designing for it now is nearly free; retrofitting it hurts.

Everything else (clock estimation protocol, voice, jamming) can be deferred
entirely and gets in the way of nothing.

#### ⚠️ Tempo changes underneath someone else's playback

**Tempo lives in the CRDT** (§2.5), so it is shared. Which means: A changes the
project tempo while B is listening, and B's playback shifts underneath them.

Formally correct — it is document state. But it is an unpleasant moment, and it
tends to surface during a demo. Options: apply tempo changes for others at the
next transport stop, or accept it as is. Not to be decided now.

#### Key principle: audio never goes over the network

Both clients have **the same samples and the same graph** → both render locally and
identically. Only two things are synchronized:

1. **project state** — via CRDT;
2. **transport position** — a lightweight clock protocol.

Shared transport is therefore quite reachable: agreement within a few milliseconds
is enough, not sample-accurate lockstep.

Incidentally: **live jamming does not contradict §2.2 on latency** if it is
loop-based and bar-quantized — everything lands on bar boundaries and 30 ms
bothers nobody. This is how Endlesss worked.

#### ✅ Chosen: Loro

| Candidate | Verdict |
|---|---|
| **Loro** | ✅ **Taking it.** Rust-native, **explicit movable lists** |
| Yrs (Yjs port) | Ready-made ecosystem, but weak list moves |
| Automerge | Mature, but heavier on memory |

**The deciding criterion is movable lists.** In a DAW, tracks and effect chain
order get reordered constantly. Most CRDTs model "move" as "delete + insert": if
two people reorder the same track simultaneously, the result can be **two identical
tracks or none at all**. It looks like a bug out of nowhere and is hard to track
down.

The remaining criteria — wasm bundle size and memory on a large document (thousands
of notes and automation points) — get verified in slice 2 (§7).

#### ⚠️ What Loro costs us

Yrs would have provided a ready ecosystem; Loro does not. Added to the scope:

- **sync transport** — a websocket relay, written by us (Yjs ships one);
- **presence protocol** — cursors and "who is where", written by us (Yjs ships
  awareness). Not hard in itself: ephemeral state, no persistence;
- **young-library risk** — fewer production deployments, smaller community. This is
  a deliberate bet, and it sits in the project model, meaning that migrating later
  equals rewriting the model.

One item to verify explicitly in slice 2: **is there an undo manager scoped to the
author** (§3). If not, that is a significant amount of extra work.

#### ⚠️ Automation curves — the stress test that breaks everything

Thousands of points, and drawing with the mouse produces hundreds of operations per
second. This is exactly where naive CRDT usage explodes in memory and traffic.

The likely answer: automation is **not a generic structure** but a specialized one,
with a soft lock on the lane ("Anya is editing this right now"). Worth prototyping
early.

#### What is synchronized and what is not

**CRDT (shared document state):**
- clip placement, tracks, ordering, routing
- MIDI notes, automation curves
- mixer state, device chains
- tempo and time-signature maps (§2.5)

**Per-user (ephemeral, not persisted):**
- zoom, scroll, selection, playhead position
- cursors and presence
- **solo** ← debatable, but solo makes more sense as personal while mute is shared

**On a separate channel:**
- audio asset bytes (see below)

#### The server — the project becomes a service

If A drops in a 40 MB loop, B has to get it. Which means:

```
content-addressed store (hash → bytes)
  ← the CRDT holds only a hash reference
  ← local cache in OPFS keyed by hash
```

Required: a sync relay, storage, accounts, bandwidth bills. The project turns from
"a web app" into **a service**. This affects §5 (licensing) and question 3 in §8.

#### Presence — the best effect-to-effort ratio

Cursors, selections, "who is holding this track". Ephemeral state, no persistence
needed — just broadcast it over the same transport. The most visible effect for the
least money in the whole of multiplayer.

With Loro the protocol is ours to write (with Yjs it would have been ready — see
"what Loro costs us"), but it is an easy job precisely because it is ephemeral:
losing that state costs nothing.

#### Offline for free

CRDTs merge on their own → a browser DAW survives a wifi drop mid-session. This is
an argument **for CRDT over OT**: OT needs a server to be always present.

#### The price of the decision

Multiplayer roughly **doubles the project**. It is worth it — it is the one axis
where native cannot catch up. But let it be a conscious choice.

### 2.5. Musical time model — now or never

A direct consequence of §2.2: since everything is stretched to tempo, **the tempo
map stops being optional**.

Mandatory from day one:

- clip positions stored in **musical time** (rational fractions of a bar, or PPQ),
  **not in samples**;
- a tempo map with ramps, not a single number;
- a time-signature map;
- sample-accurate conversion between musical time and samples **in both directions**.

> The classic mistake is "we'll store positions in samples and add tempo later".
> The only cure is rewriting the core. Same "now or never" category as §2.4 on
> CRDTs.

> **Decided 2026-08-29.** Of the two representations offered above, **PPQ** — a
> position is an integer count of ticks, at **5 765 760 ticks to the quarter**
> (2^7 · 3^2 · 5 · 7 · 11 · 13).
>
> Precision did not decide it. The two differ there by hundredths of a
> millisecond, and the error does not accumulate: positions are absolute, so the
> hundredth copy of a pattern lands exactly as far out as the first. **The
> document decided it.** A rational position is a pair, and (3,2) and (6,4) are
> different pairs holding the same number — so two people placing a note on the
> same beat can write two different values, which is the failure §2.4 chose Loro
> to avoid. Normalizing on construction fixes that and leaves an invariant which
> must then hold through serialization, across the network, and in a client
> version not yet written. An integer tick is canonical by construction and has
> no such invariant to break.
>
> Two smaller reasons point the same way. Rational addition multiplies
> denominators, so it needs reduction — and on the audio thread, checked
> arithmetic with invented behaviour on overflow, where `escapement-core` may
> not panic. And the conversion running every quantum is samples to position,
> which has one natural answer on a fixed grid and none at all without one.
>
> **Rejected: `f64` beats**, as Ableton and Reaper store it. Not among the two
> above, and worse than either here — a third of a beat is not representable at
> all, and equality of positions is precisely what the document needs.
>
> The resolution is generous on purpose, and the asymmetry is the argument: a
> finer grid is always reachable from a coarser one by multiplication, while a
> coarser one has already lost what it cannot hold. MIDI's usual values and FL's
> — 96, 480, 960 — all divide it exactly, so nothing is lost on import. At `i64`
> the ceiling is around a trillion quarter notes, and the cost in the document
> is a few bytes per position.
>
> **What this closes is the document, not the type.** The door shuts when the
> first project is saved, and §7's slice 2 puts two stages before that: the type
> in use with no document, then entities as plain structs with no CRDT beneath
> them. So the position is a type with a private field and nothing outside its
> crate doing arithmetic on the raw integer — the same cheap insurance §4 buys
> for the renderer. Worth revisiting once, before Loro goes underneath; after
> that it is a migration.

> **Decided 2026-08-29.** A tempo ramp is **linear in beats per minute**, not in
> the period those beats imply.
>
> Not a matter of taste: a ramp is a curve either way, and only one of the two
> can be the straight one. The same two tempo marks over the same eight bars —
> 60 to 180 — part by three and three quarter seconds depending on which. That
> is a different place in the song, not a different shade of a curve.
>
> Precision did not decide this one either, though it was expected to. The
> closed form for a linear-bpm ramp is a logarithm and its inverse an
> exponential, which looked like a threat to the sample-accurate conversion
> demanded above. Measured, the round trip through samples costs about 2 x 10^-8
> of a sample, and the linear-period form is no better. The objection was
> withdrawn rather than answered.
>
> What decides it is that the curve is **drawn**. Tempo is a parameter in beats
> per minute, automated like any other, and an automation curve interpolates its
> parameter — so a straight line between two tempo marks is straight in beats
> per minute. Make the period linear instead and the line someone drew is no
> longer the tempo but a curve nobody asked for. The same rule that settled the
> representation above: the data means what it says.
>
> **Rejected: linear in the period.** It integrates to a quadratic rather than a
> logarithm and inverts through a square root rather than an exponential, which
> is marginally cheaper and buys nothing — `escapement-core` already carries
> `libm` for the oscillator.
>
> **A segment with no ramp in it is a second formula, not an edge case.** The
> integral of a period over position takes one form while the tempo moves and
> another while it stands still, and the moving one divides by the rate of
> change. At a rate of zero that is not an error to be handled: `f64` division
> does not trap, so it gives an infinity, the infinity meets a logarithm of one,
> and the result is a NaN — which compares false to everything, sorts nowhere,
> and saturates to tick zero on its way to an integer. The start of the project,
> silently — the value the oscillator in `escapement-core` already refuses for
> the same reason.
>
> So the two kinds of segment are told apart **when the map is built**, in the
> model, where allocating and deciding are both allowed; the audio thread reads
> which form applies instead of comparing a float against a threshold. A
> threshold does exist — the logarithmic form loses precision well before the
> rate reaches zero — and choosing where it falls is not a judgement to make
> once per quantum.
>
> The time-signature map is not interpolated at all. A signature steps at a bar
> line; there is no ramp from 4/4 to 7/8 to have an opinion about.

### 2.6. Project model entities — FL-shaped

The reference is FL Studio, and it differs from Ableton **not cosmetically but in
the shape of its data**. Three things must be in the model immediately, because
unpicking them later means a rewrite.

#### 1. A pattern is a reference, not a copy

A pattern instance in the playlist **references** the pattern. Edit the pattern and
all twenty places it appears change.

So a pattern is a first-class entity with its own lifetime, not "a clip with notes
inside it".

For §2.4 this is mostly good: editing a pattern is editing **one** object, not
twenty. And slightly frightening: two people editing a pattern that plays in twenty
places.

#### 2. Channel ≠ track ≠ mixer insert

In most DAWs these are one fused entity. In FL they are three distinct things in a
many-to-many relationship:

```
channel (sound source)
  → routes to a mixer insert
    ← several channels can share one insert
```

#### 3. Playlist lanes do not define routing

They are visual lanes, not routes. Patterns, audio clips and automation clips can
go anywhere.

---

All three concern the project model, which per §2.4 must be CRDT-compatible from
day one. So **both shapes are fixed at the same time**, before the first line of
the model is written.

---

## 3. Boundaries

> **Updated after §4.** This section was originally about the Rust/JS boundary.
> After choosing Leptos there is no language boundary for the UI — there is no
> TypeScript in the project. What remains is the boundary **between threads**, and
> that one is not going anywhere.

### What remains: audio thread ↔ UI thread

The worklet is a **separate wasm instance with its own linear memory**. It cannot
see the UI thread's memory, no matter how much Rust sits on either side.

So the exchange still goes through `SharedArrayBuffer`:

- **UI → engine**: commands, via a command ring buffer
- **engine → UI**: state diffs plus high-frequency values (see below)

The gain from Leptos is that **the protocol is written once in Rust** and used by
both ends — rather than duplicated in TypeScript, where two implementations must
agree and nothing checks that they do.

### Whose memory the rings live in

The two paragraphs above skip a step. Wasm can address **only its own** linear
memory: a pointer is an offset from its base, and no instruction reaches outside
it. So a `SharedArrayBuffer` allocated alongside the two modules is unreachable
from Rust on either side — it can be touched only from JavaScript, through a typed
view and `Atomics`. Read literally, that puts JavaScript on the audio path and
cancels §6's "the protocol is written once in Rust".

What resolves it: a module linked with `--shared-memory` **is** backed by a
`SharedArrayBuffer` — `memory.buffer` is one. The rings need no buffer of their
own. They live inside the linear memory of one of the two modules, which then
addresses them with ordinary Rust pointers; the other side reaches them from
outside, through `js_sys::Atomics` over typed views. The only question is which
module gets the fast side.

> **Decision: the rings live in the worklet's linear memory, and the worklet
> exports it.**

| Side | Access | Frequency |
|---|---|---|
| Audio (owner) | raw pointers, no JavaScript | every quantum — thousands per second |
| UI | `js_sys::Atomics` over typed views | per frame — tens per second |

The asymmetry is the entire argument: the side that cannot afford JavaScript is
the side that does not have to cross into it. Tens of `Atomics` calls per second
on the UI side cost nothing measurable.

**Rejected — both modules importing one shared memory.** They are separately
linked modules, each with its own static layout and its own allocator. Pointed at
the same memory, their data segments and heaps collide.

✅ Consequence for the build, settled. `--max-memory` cannot be one value for the
whole target: the worklet's memory is also the transport, and §1 wants it fixed
and sized once, with no `memory.grow`. `rustflags` in `.cargo/config.toml` apply
to every crate built for the target and cannot tell the two apart, so the memory
link args live per crate in `crates/*/build.rs` — the worklet fixed at 32 MiB
(`--initial-memory` equal to `--max-memory`), the interface free to grow. CI
checks both, and that shared memory is actually shared: `+atomics` alone links a
*private* memory and fails only in the browser.

### The technique without which meters stutter

> Anything updating at frame rate — meter levels, playhead position, transport
> state — **must not be sent as messages**.
> The engine writes into a fixed region of the SAB; the UI reads it every frame.

Meters at 60 fps through `postMessage` are a guaranteed stall. Messages carry only
infrequent things: user commands and structural changes to the model.

### What lives in that memory

Written once, in `escapement-protocol`, and used by both ends — the worklet
through pointers, the interface through `Atomics` over a typed view. Only the
access differs; the encoding is one piece of code, which is the whole gain from
there being no TypeScript.

The two accesses are **two crates, not two features of one**. The outside one
needs `js-sys`, and a cargo feature is shared by everything in a workspace
build — so a feature here put `js-sys` in the worklet, which cannot have it: a
module with an import section is one `worklet.js` cannot instantiate at all.
`escapement-view` therefore sits beside `escapement-protocol` and depends on it,
and nothing the audio thread links can name JavaScript. This was settled by
measuring rather than arguing; the numbers are in the commit that split it.

Everything is addressed in **32-bit words**, never bytes. `Atomics` index a view
by element, so words remove a class of alignment mistakes on the outside and
remove byte order from the encoding on both.

| Words | What | Written by | Read by |
|---|---|---|---|
| 0–31 | header — magic, version, offsets, capacities | worklet, once before publishing the address | interface, once at the handshake |
| 32–… | command ring | interface | worklet, drained before each quantum |
| …–end | state block | worklet, after each quantum | interface, once a frame |

**Three mechanisms, not one, because the traffic has three shapes.** Treating
them as one thing is the mistake this section exists to prevent:

- a **queue** for commands — ordered, lossless, drained by the reader. Slots are
  fixed and small, so a message can neither straddle the end of the ring nor
  carry a length in front of it. Nothing that is *data* goes through here at all:
  a sample buffer or a graph is published elsewhere and referred to by a command.
  A ring that grows a large slot is a ring being used for the wrong thing.
- a **latest value** for meters, playhead and transport — written every quantum,
  read once a frame, skipped values not a concept. A meter shows the level now,
  not the levels that have been.
- **double buffering** for the project snapshot — slice 2, below, and not built
  yet.

Overflow is deliberately **not** a protocol state. A full ring is refused, and
the interface — which keeps its own queue in its own memory and drains a frame's
worth at a time — answers that with "next frame". The alternative is dropping or
overwriting commands, which is a lost transport change rather than a late one.

#### The header describes itself, and carries a version

Not constants compiled into both halves. **The browser fetches and caches the two
modules separately**, so a fresh interface meeting a stale worklet out of cache
is an ordinary afternoon in development — and a shared constant parts company
silently, as a misread rather than as a message. The version in the header turns
it into one at the handshake.

The handshake is a single `postMessage` at startup: the worklet instantiates,
reads its exports, and sends the memory and the header offset to the main thread.
The ban on `postMessage` is about frame rate, not startup. And since the
worklet's memory is fixed, the views over it are created once and live forever.

The one thing a header cannot describe is the memory holding it, so that is the
one claim checked against something other than the header — the reader compares
the region described against the words it can actually reach. Without that check
a header claiming more memory than exists is well formed by every other measure,
and fails at the first access instead, pointing at the ring rather than at the
handshake.

That comparison happens twice, and the first is before anything has been read: a
memory with no room for a header in it has nothing to be asked, and asking it
anyway is a read outside the region — outside the worklet, not an error but an
exception through whoever called.

#### Frame-rate state is a generation counter, not double buffering

The technique above says *where* those values go; this is *how*. The writer bumps
a counter to odd, writes the payload, bumps it to even. The reader takes the
counter, the payload, and the counter again: odd or changed means take it again.
**The writer never waits** — which is the entire requirement on the audio thread.

Double buffering is worse here. It does not save a slow reader — two frames on
and the writer is back in the same buffer — so honesty needs three, for a payload
of a dozen words. The project snapshot below is the same problem the other way
round, which is why it gets the other mechanism.

⚠️ A race on **non**-atomic access is undefined behaviour in Rust's model even
when the generation counter filters the torn read out afterwards. So on the Rust
side the payload is read and written through relaxed atomics: on wasm that is the
same load instruction with no barrier, free at run time, but in the language it
is no longer a race. On the interface side it is one view copy plus two `Atomics`
on the counter — JavaScript has no undefined behaviour, the divergence is
allowed, and the retry catches it.

#### No engine → interface ring yet

What the engine actually has to report upward — meters, position, transport —
belongs in the latest-value cell; dropouts and "how many commands were applied"
are counters in the same block; acknowledgement of commands is the ring's tail,
which already exists. Real events, meaning notes recorded from a controller,
arrive when recording does, and that is deferred in §2.2.

The primitive is written to work both ways round. An instance in this direction
gets created when there is something to put in it.

> The orderings here are not checked by reasoning. Loom enumerates the
> interleavings, Miri looks for undefined behaviour and data races, and
> cargo-mutants checks that the tests would notice if any of it stopped working.
> `CLAUDE.md` has the commands and the traps.

### A state snapshot for the audio thread

The model thread (where Loro lives) prepares an **immutable snapshot** of whatever
audio rendering needs and publishes it to the audio thread through double buffering
in the SAB. The audio thread always reads a consistent snapshot and never waits.

Design this before the model accumulates code — otherwise the RT thread ends up
reaching into structures that mutate underneath it.

### The split that works

The split is no longer by language but **by thread**:

**RT thread (worklet):**
- audio graph, DSP, mixer
- time-stretch synthesis from a precomputed map
- sample playback

**Model thread:**
- **CRDT project document + undo/redo + serialization** ← the single source of truth
- MIDI sequencer, automation

**Workers:**
- sample streaming from disk, decoding
- waveform peaks
- warp analysis (transient detection, warp map)

**UI thread (Leptos):**
- rendering only

#### ⚠️ Undo in multiplayer is not the same as undo

In multiplayer, undo is **local**: undo *my* last action, not the last action
overall. This is a known hard problem.

**Take the undo manager from Loro**, do not write your own — the line "Rust:
undo/redo" above looks simple right up until a second person appears in the
document.

⚠️ Whether Loro has author-scoped undo at all — **verify in slice 2** (§7). If it
does not, that is a significant amount of work currently accounted for nowhere.

**Across boundaries — commands and events, not objects.**

> The historical reason for the rule: fine-grained Rust objects exposed to JS via
> `wasm-bindgen` used to eat projects alive through call overhead and manual
> lifetime management. With Leptos this no longer applies to the UI, but **between
> threads the rule still holds** — there the boundary is physical, not linguistic.

---

## 4. UI

### ✅ Framework: Leptos

**The entire client is Rust. There is no TypeScript in the project.**

The reason is not Rust fashion but what §3 warns about. The Rust/JS boundary for UI
state is expensive, and the cost is not abstract:

- **the ring buffer protocol has to be implemented twice** — in Rust and in
  TypeScript — and no compiler will check the two implementations against each
  other;
- manual pinning and lifetime juggling across the boundary;
- schema drift between the Rust model and the TypeScript types, caught at runtime.

With Leptos **that boundary disappears for the UI**: the interface reads the model
directly, in the same linear memory. Loro is used as an ordinary Rust library. One
build, one type system, from the engine to the button.

Alternatives rejected: React works but pays the same boundary cost; Svelte and Solid
offer what React does with no additional gain here; egui removes the boundary
entirely, but text input, IME and accessibility become a project of their own.

#### ⚠️ What disappears and what does not

Precision matters here, to avoid illusions:

| Boundary | Fate |
|---|---|
| **Rust ↔ JS** (language) | ✅ Gone for the UI |
| **Audio thread ↔ UI thread** (threads) | ❌ **Remains** |

The ring buffers in SharedArrayBuffer are not going anywhere — the worklet is a
separate wasm instance with its own memory (§3). The gain is different: **the ring
protocol is written once in Rust and used by both ends.** One implementation
instead of two.

#### What the ecosystem will not provide

There are almost no component libraries for Leptos. For a DAW this matters less
than it sounds — nobody takes a mixer strip from a component library anyway. But
the generic pieces will have to be written:

- modals, context menus, tooltips, dropdowns
- focus traps and keyboard handling
- **virtualized lists** ← a sample browser with thousands of files does not work
  without them

#### ⚠️ The risk to test before the UI accumulates code

**Iteration speed.** UI work is inherently cyclical: adjust a padding, look, adjust
again. With Vite that is instantaneous; with Rust it is a wasm rebuild. Leptos has
hot reloading for views, but how much it helps on real UI is something to try by
hand.

With a slow feedback loop the interface simply comes out worse, because you take
fewer passes at it.

**How to test:** build **one real panel** — a sample browser with a virtualized
list, or a mixer strip. Not a hello world, but somewhere with a list, scrolling,
input and state. Slice 1 will not do: its UI is minimal. A couple of days gives the
answer.

### Canvas surfaces

An arranger with hundreds of clips, waveforms and automation lanes **does not
survive in the DOM at 60 fps**.

- **Playlist and piano roll** — a custom WebGL2 renderer (WebGPU as progressive
  enhancement)
- **Panels and chrome** — DOM, via Leptos

#### ⚠️ After §2.6 there are two large canvases, not one

FL's piano roll is widely considered the best in the industry — it is **an
application inside the application**, a subsystem the size of the playlist, not a
feature.

Design the renderer to be **reusable across both** from the start: grid, scrolling,
zoom, rubber-band selection, dragging, snapping — roughly seventy percent is
shared. What differs is what gets drawn inside the cells, not the mechanics around
them.

This makes the "renderer separate from the framework" rule (below) even more
valuable: one module serves both of the product's main surfaces.

A consequence of choosing Leptos: **PixiJS is ruled out.** Pulling a JS library
onto the hottest path would reintroduce exactly the boundary this was all meant to
avoid. So the renderer is Rust — either `wgpu` or raw WebGL2 through `web-sys`.

The earlier warning about `wgpu` ("text, accessibility and input become a project
of their own") applied to rendering the **entire** interface. It does not apply to
a single timeline: there is little text there (clip names, ruler numbers), and
timeline accessibility is a hard problem regardless of how it is drawn.

#### 🔒 Cheap insurance

> **Keep the timeline renderer completely separate from the framework** — a
> self-contained module: state in, mouse events out.

Then, unlike almost every other decision in this document, the framework choice
**does not become a one-way door**: migrating would be annoying but not fatal,
because the bulk of the UI work would stay put.

All the more sensible because the timeline is written once and for a long time,
while the panels will be redone constantly.

---

## 5. What not to write yourself

| Task | Library | Note |
|---|---|---|
| Audio decoding | `symphonia` | Pure Rust, works in wasm. But for common formats the browser's `decodeAudioData` / WebCodecs is faster |
| Resampling | `rubato` | |
| DSP building blocks | `fundsp`, `dasp` | |
| Time-stretch | see below | ⚠️ **Main DSP risk** + a licensing landmine |

### ⚠️ Time-stretch — the main DSP risk

**Correction after the reference product was chosen (§2.6).** This used to say
"core of the product". That was an Ableton-shaped assumption: Ableton is
warp-first, FL is pattern-first. With FL as the reference, the product's identity
is the step sequencer, the piano roll and the playlist, while warping is
**important but supporting**.

It remains the main DSP risk: the algorithm has to be not merely present but
**good** — stretch artifacts are audible instantly. It is simply no longer
existential, and that affects the order of the slices (§7).

#### ✅ Decided: Signalsmith Stretch

| Candidate | License | Verdict |
|---|---|---|
| **Signalsmith Stretch** | MIT | ✅ **Taking it.** C++, builds to wasm cleanly |
| Rubber Band | GPL | ❌ Ruled out — see §5.1 |

Slice 4 (§7) runs straight into this choice, which is why it is settled.

### 5.1. Rights and licensing

**Position: the code is open, the rights are mine.** The sources are published, the
copyright is mine, and I can do whatever I want with the project later — sell it,
close it, license it separately.

Keeping that true requires **two things**:

#### 1. A CLA — before the first external PR

Without a CLA, code sent by an outside contributor belongs to **them**. At which
point "the rights are mine" stops being true: changing the license would mean
tracking down everyone who ever sent a patch.

- Set it up **before the first external PR**; afterwards is too late
- Technically a GitHub bot, template already exists, half an hour of work
- ⚠️ Specifically a **CLA**, not a DCO: a DCO only certifies the origin of the code
  and grants no relicensing rights

#### 2. No GPL dependencies

The GPL requires **the entire product** to become GPL — that is, it takes away
precisely the freedom the rights are being held for.

Important: shipping a wasm bundle to the browser **is distribution of the program**
to the user. Not a "server-side loophole" as with the AGPL: you are literally
handing over the binary.

**In practice this is one line: time-stretch is Signalsmith, not Rubber Band.**

→ The rule for all dependencies: **permissive by default**, GPL never.

> **Decided 2026-08-26.** The rule above splits in two, because copyleft does.
> **Whole-program copyleft — GPL, AGPL, SSPL — never**, for the reason already
> given. **File-level copyleft — MPL, EPL, CDDL — is accepted**, and an
> attribution page is its price.
>
> Forced by Loro, which depends on `im` unconditionally and brings `bitmaps` and
> `sized-chunks` with it, all three under MPL-2.0. Dropping them means forking
> Loro, which is out of proportion to what they cost.
>
> The two kinds differ in the unit of contagion, not in degree. MPL 1.7 defines a
> Larger Work as one combining covered software with other material *"in a
> separate file or files"*, and 3.3 permits distributing that Larger Work *"under
> terms of Your choice"*. So those three crates keep their license and Escapement
> keeps PolyForm. The GPL has no such clause, which is precisely why it stays
> refused — the distinction is the whole reason this is a decision rather than an
> exception.
>
> The price is 3.2(a), with 3.1 behind it: whoever receives the bundle must be
> told, per package, that it is under MPL, where its source is, and where the
> license text is. That is a page inside the product rather than a file in the
> repository — the recipient of the executable form is a person with a browser,
> who has no reason to know the repository exists. Generated from the dependency
> tree at build time rather than written by hand: a hand-written list drifts as
> dependencies change, and it drifts silently.
>
> One point is left open on purpose. MPL 3.2(b) permits sublicensing the
> executable form under other terms *"provided that the license for the Executable
> Form does not attempt to limit or alter the recipients' rights in the Source
> Code Form"*. PolyForm restricts competing use of Escapement, not of `im`, which
> remains available to the recipient under MPL untouched — so on a plain reading
> there is no conflict. It is still a sentence worth a lawyer before the first
> public build, and not one to settle here.
>
> Unlike the rest of this section, the rule no longer rests on remembering it.
> `deny.toml` is the allow-list, and CI refuses a license that is not on it.

#### What can be decided whenever

Which license text actually goes into `LICENSE` — Apache, MIT, GPL, BSL. It blocks
nothing and affects nothing right now.

A leaning: **Apache 2.0 + CLA on the engine, service closed.** The split falls
cleanly — the Rust core (graph, DSP, warp, time model) and the service (sync,
hosting, accounts) are physically separate codebases. But this is a leaning, not a
decision.

> **Decided 2026-08-25.** `LICENSE` is **PolyForm Shield 1.0.0**, not Apache. The
> leaning above rests on an assumption that does not survive inspection: that the
> value sits in the service and the engine can be given away. It is the other way
> round. The engine — graph, DSP, sampler with voice allocation, warp, CRDT model,
> WebGL2 renderer — is years of work; the relay is a websocket server broadcasting
> Loro updates, plus asset storage and accounts, and that is weeks. Apache would
> hand a competitor the expensive half and leave them the cheap half to build.
>
> Shield rather than Noncommercial, and the reason is specific to a DAW.
> Noncommercial permits personal use only "without any anticipated commercial
> application" — which excludes a beatmaker who intends to sell the track. That
> restriction lands on the target user rather than on the threat. Shield permits
> every purpose except providing a competing product, so music made with the DAW
> is unrestricted while the DAW itself cannot be resold or re-hosted.
>
> `LICENSE` carries a `Licensor Line of Business:` line, without which Shield's
> Discontinued Products clause would let a competitor in on anything that stops
> being offered.
>
> The cost is accepted knowingly: this is not open source by the OSI definition,
> and few contributors come to a repository they may not compete with. The CLA
> half of the leaning stands unchanged.

### The sample library — a deceptively hard problem

A beatmaker has thousands of files, and a browser has no filesystem. How do 40 GB
from Splice get into the DAW?

| Path | Problem |
|---|---|
| File System Access API + directory handle | Folder access survives sessions, but **Chrome/Edge only** |
| Drag and drop | Does not scale to a library |
| Copying into OPFS | Duplicates tens of gigabytes |

An architectural question, not a UX detail. Think it through **before** the sample
browser gets built in.

### Other things now counted as core work

- **The sampler as an instrument**: polyphony, key zones, velocity layers,
  round-robin, envelopes, filters — with voice allocation **without a single
  allocation** on the RT thread. A substantial amount of Rust in its own right.
- **Waveform peaks**: a peaks pyramid computed in a worker, with a cache.
- **Transient detection** for slicing loops.

### Storage

**OPFS** with `createSyncAccessHandle` in a worker: synchronous, fast I/O — exactly
what streaming audio "from disk" needs.

After §2.4 OPFS has a second role: **a local asset cache keyed by hash.** The client
pulls bytes from the content-addressed store once and reads locally afterwards.

---

## 6. Browser reality

| Browser | Status |
|---|---|
| **Chrome / Edge** | Everything works |
| **Safari** | Worklet and OPFS are there, **no Web MIDI** |
| **Firefox** | Web MIDI behind a permission; historically worse worklet performance |

**Pragmatically: Chrome-first, the rest best effort.**
Admitting this now is cheaper than cutting functionality for parity later.

After §2.2 this carries more weight: a beatmaker needs a **controller**, and Safari
does not support Web MIDI. Add sample library access through the File System Access
API (§5) — also Chrome/Edge. Chrome-first stops being a pragmatic choice and becomes
**an actual requirement**.

---

## 7. What to build first

**Not the editor.** Four vertical slices, each closing its own principal risk.

### Risk order

| # | Risk | Slice |
|---|---|---|
| 1 | Does Rust + AudioWorklet work at all | Slice 1 |
| 2 | **Does a CRDT hold up under DAW structures** | Slice 2 |
| 3 | **Does the pattern model work** | Slice 3 |
| 4 | Warp quality + licensing | Slice 4 |

Risk 2 appeared after §2.4 and **outranks warping**: it dictates the shape of the
project model on which every other slice stands.

Risk 3 appeared after §2.6 and **also overtook warping**: patterns are the
product's identity, warping is a supporting function (§5).

> **The CRDT library must be chosen before slice 1 writes the project model.**
> The network can come later; the shape of the data cannot.

### Slice 1 — the audio path

```
one audio clip on the timeline
  → playback through a Rust graph in the worklet
    → master bus
      → WAV export
```

Runs the entire risky platform path end to end:

- building wasm for the worklet
- cross-origin isolation
- ring buffer
- preallocation
- offline render through the same engine

Closes risk 1: **does the Rust + AudioWorklet combination work at all.**

### Slice 2 — CRDT on Loro (can run in parallel with slice 1)

```
two browsers, one timeline
  → clips move for both
    → no audio at all
```

It does not overlap with slice 1 by subsystem, so it can run in parallel. The
library is already chosen (§2.4), so this slice does not compare options — it
**tests the bet**.

What it must confirm:

| Check | Why |
|---|---|
| **Movable lists** | Reorder a track from both sides at once without producing a duplicate. This is why Loro was chosen |
| **Author-scoped undo** | Whether it exists at all. If not, that is significant work accounted for nowhere (§3) |
| **Automation curves** | Where a naive CRDT explodes in memory and traffic. Worth prototyping early |
| Bundle size and memory | The remaining criteria from §2.4 |

Additionally in scope — what Loro does not provide out of the box (§2.4):

- sync transport (websocket relay);
- presence protocol for cursors.

> The "one week" estimate referred to comparing libraries. With our own transport
> and presence the slice is bigger — plan realistically.

### Slice 3 — patterns

```
a pattern with notes
  → two instances in the playlist
    → editing the pattern changes both
      → playback
```

This tests **the product's identity** (§2.6), not a subsystem. It forces the
following to be settled:

- a pattern as a reference rather than a copy — including behaviour under
  concurrent edits from two browsers (dovetails with slice 2);
- separating "channel ≠ track ≠ insert" in live code rather than on paper;
- a draft of the graph node interface — which is implicitly the device ABI (§2.3).

### Slice 4 — warp

```
a loop at a tempo different from the project's
  → stretch it to the project tempo
    → hear it in time
```

The sample-based equivalent of the riskiest DSP path. It forces the following to be
settled:

- the choice of stretch algorithm and **its license** (§5);
- the musical time model (§2.5) — this is the slice where it stops being theory;
- warp quality itself.

The recording path (loopback calibration, capture into OPFS) used to be planned as
the second slice. After the §2.2 decision it is **removed** — bring it back if live
recording returns to scope.

If all four skeletons stand, what remains is a lot of work but little uncertainty.

> What kills a DAW is not DSP complexity but the fact that it is five products in
> one, and each one looks like "just another couple of weeks".

---

## 8. Questions

### ✅ Closed

1. ~~**Who is the user?**~~ → **Sample-based production** (loop-based production,
   beatmaking). We do not fight for latency; live recording is deferred. Analysis
   of the consequences in §2.2.

2. ~~**Is multiplayer needed?**~~ → **Yes.** It is the product's axis of
   differentiation, not a feature. The project model is a CRDT from day one. Full
   analysis in §2.4. Price: the project roughly doubles.

3. ~~**Open source or product?**~~ → **The code is open, the rights are mine.** The
   question was framed wrongly: "openness" and "business" are different axes and
   they combine. There are only two consequences, both in §5.1: **a CLA before the
   first external PR** and **no GPL dependencies** (hence Signalsmith). The specific
   license text blocks nothing and can be decided whenever.

4. ~~**Which kind of multiplayer?**~~ → **A ladder of three rungs, with co-editing
   as the v1 target.** Follow mode is not built but designed for; jamming is out of
   scope and contradicts nothing. The single architectural consequence: **the
   transport must be drivable from outside** (§2.4).

### ⛔ No open questions

All four are closed. Of the §2 decisions, only 2.1 (worklet vs worker) and 2.3
(plugins) remain recommendations rather than decisions — but neither blocks any
slice.

Worth keeping in view as deferred rather than settled:

- **Device ABI** (§2.3) — still a recommendation, not a decision. Its weight grew
  after §2.6: the project is long-term, FL's identity is tied to its own
  instruments, and slice 3 will sketch this interface anyway
- **Project file format and migrations** — in three years people will have old
  projects that must still open. A direct consequence of being long-term
- **Sample library: how 40 GB gets into the browser** (§5) — an architectural
  question with no answer, but not on the critical path
- **Tempo changes underneath someone else's playback** (§2.4) — will surface during
  a demo
- **Solo personal / mute shared** (§2.4) — recorded as "debatable"
- **The license text in `LICENSE`** (§5.1) — affects nothing

### A note on the market

The sample-based niche is the most crowded one **on tooling**, but empty **on
collaboration**. Hence decision 2: do not change the niche, change the axis of
differentiation. "Another loop DAW in a browser" loses to BandLab; "the place where
two people make a beat together" competes with nobody.

This also removes the project's main weakness — before §2.4 there was no answer to
"why a browser rather than native" beyond "no installation required".

---

## Appendix: on the name

An *escapement* is the mechanism in a clock that releases the gear train in steps.
A fitting name for a DAW: it is exactly about turning continuous time into discrete
beats.
