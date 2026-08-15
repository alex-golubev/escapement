# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser DAW. All audio is computed by a single Rust engine compiled to WASM and run inside one `AudioWorkletProcessor`. Web Audio's built-in nodes are not used for anything except the final connection to `destination`.

## Commands

Rust, from the repository root:

```sh
cargo test                                   # all tests, native target
cargo test transport::                       # one module
cargo test clicks_land_exactly_on_beats      # one test
cargo check
./scripts/build-wasm.sh                      # release WASM → web/public/engine.wasm
./scripts/build-worklet.sh                   # esbuild bundle → web/public/worklet/processor.js
```

TypeScript, from `web/` (pnpm, not npm):

```sh
pnpm dev                                     # Vite, with the COOP/COEP headers
pnpm test                                    # vitest, one run
pnpm test:watch
pnpm lint                                    # eslint, type-aware
pnpm format                                  # prettier --write
pnpm check                                   # svelte-check + tsc over all three projects
pnpm format:check                            # prettier --check; not part of `check`
pnpm build:worklet                           # alias for ../scripts/build-worklet.sh
```

**`pnpm check` and `pnpm lint` say nothing about formatting**, so run `pnpm format` before committing — nine files had drifted by the time anyone looked. One caveat found doing that: prettier is not idempotent on a method signature returning an inline object type (`fetch(url): Promise<{ … }>`), so `--write` produces output `--check` then rejects. The fix is to name the type rather than to fight the formatter.

`scripts/build-wasm.sh` must be used instead of a bare `cargo build`: it forces the build from the workspace root (see profiles below), checks that the `wasm32-unknown-unknown` target is installed, and verifies via `node` that the compiled module still exports every ABI function plus `memory`. **When adding or renaming an exported ABI function, update the `expected` array in that script** — a lost `#[unsafe(no_mangle)]` otherwise produces a successful build and a silently useless module.

Both build artifacts — `web/public/engine.wasm` and `web/public/worklet/processor.js` — are gitignored and reproduced in full by their scripts. `pnpm test` fails loudly rather than skipping when `engine.wasm` is absent.

Neither is in Vite's module graph, so two plugins in `web/plugins/artifacts.ts` keep them in step with their sources — the reasoning is there, in full:

- **The worklet is rebuilt for you.** `vite dev` and `vite build` both build it first, and while serving, any change to a `.ts` under `src/` rebuilds it and reloads the page — but only when the bundle actually came out different, so page-only edits cost nothing. A page reload is the ceiling: a processor name is registered once per `AudioWorkletGlobalScope`, so new worklet code always means a new `AudioContext`.
- **The engine is not rebuilt, only reported on.** A release build with `lto` on every keystroke is untenable, and a dev-profile build would be a different artifact from the shipped one. Instead the dev server says when `engine.wasm` is older than `crates/engine/src` and names the script; `vite build` fails outright rather than shipping a stale or missing engine. **Rebuilding the engine after a Rust edit is still yours to do.**

## Current state

**The skeleton milestone is closed** (2026-08-08). A metronome computed in Rust reached the speakers, and at that point nothing beyond it existed: no sampler, no pattern, no mixer. Done and verified — the Rust half (transport, command codec, ring decoding, metronome, C-ABI), the Vite host with COOP/COEP headers, the worklet, the ring buffer in both directions, and a page that starts the transport, drags the tempo, and reads position and levels back out. It closed with 70 native tests and 89 in vitest — a count of that moment, not of the repository now, which is why it is not kept up to date here. Run the suites for the current number.

It closed carrying one recorded gap, which is worth knowing before you trust a number: **there is no underrun detector, and `underrun_count` in the telemetry block is a reserved zero.** `currentTime` advances with the render thread rather than with the device, so pairing it against a rendered-frame counter compares that thread with itself and reports a confident 0.0 ms; Chrome 151 has no `AudioRenderCapacity`. Nothing here measures dropouts, so do not read silence in that word as evidence of anything.

The drum machine after it — 16 steps, 8 tracks, a sampler, an editable grid — is written and unmeasured: everything the milestone asked for exists, and what remains is a list of things nobody has run yet. Thirty minutes with the kit reloaded, the CPU in a backgrounded tab, Firefox and Safari, and the two criteria that are ear judgements by nature. `Op` and `Command` stay synchronised by hand — generating them would still leave `Command` and its payloads to write out, so the manual list is the honest one — but the gap that made it risky at eight opcodes is closed: `tests::OPCODES` is the table both directions are checked against. What remains open from the skeleton is that a clamped BPM is corrected in silence, with no channel to say so.

**In progress.** The command protocol is at ten opcodes and `PROTOCOL_VERSION` 5: transport, the mixer's three, `SetStep` / `ClearPattern`, `SetMetronome`, and `TriggerTrack`. `sampler.rs` holds the bank and the voice pool, `sequencer.rs` turns a sample position into a step, `mixer.rs` a gain and a pan per track plus a master, `pattern.rs` a velocity per track per step, and `dsp.rs` the primitives they need. The grid strikes, voices reach the output, and every knob now multiplies something: a track's gain and pan become a pair of smoothed channel gains through a constant-power pan law, and the summed bus goes through a soft limiter in `dsp.rs`. **The sum is hot by decision** — eight tracks at unity reach 5.66, so the limiter works on any full pattern rather than waiting for a peak, and faders are what the level is set with. **The peak meter reads the bus before the limiter**, so `peak_l` / `peak_r` are no longer bounded by 1; that is a change of meaning without a change of layout, which neither the version nor the pins can catch, and `telemetry.ts` says so where the page reads it.

The telemetry block is five words: the position in two, the two peaks, and **the sequencer's position within the pattern**, in steps and fractional, wrapped into `[0, STEPS)`. It travels because the page cannot derive it — samples become musical position only through the tempo anchor, and the anchor is in the engine — and it is what the playhead will be drawn from. `sequencer::position_in_steps` computes it and argues its shape, including the one thing a reader will look for in the wrong place: `floor` of the word and `step_at` can name different cells on a boundary sample, by a tenth of a sample, and that is left alone rather than fixed.

The kit reaches the speakers: eight samples synthesised by `scripts/synthesize-kit.mjs` and committed under `web/public/kit`, fetched and decoded on the main thread, interleaved there, transferred to the worklet on the port and laid into the arena by `worklet/kit.ts`. Two things about that path are easy to get wrong. **The refusal codes are numbers on both sides and named on neither but Rust's**, for the reason given under the ABI contract below. And **the two ABI functions are the pair bring-up never calls**, so a lost export on either survives every check that runs before the first quantum — which is why `kit.ts` answers a throw with a value rather than letting it out of the message handler, where the page would wait for a reply forever. Also worth knowing: **`decodeAudioData` resamples to the device rate**, so the same file decodes differently on a 44.1 and a 48 kHz machine. That is a temporary dependency with a date on it — the Rust WAV decoder on M3, arriving with the golden renders it would otherwise make worthless. And **an opcode arrives with its receiver, but that is necessary rather than sufficient**: `SetMetronome`'s receiver was written on M0 and the opcode was not, because nothing needed the click off. The onset tests do — a strike is a non-zero frame, and a click at any level reads as one — and the single write path (no `&mut` getters, no public fields) means a test can only reach the switch through a command. So an opcode also arrives with the test that needs its effect.

**The page is an instrument now**, and there is a milestone's worth of decision in how it is put together. The pattern is held on the page as one boolean a cell, deep `$state` and deliberately not the `$state.raw` the engine handle is — there the proxy buys nothing, here it is the whole point, because a click has to invalidate one cell rather than 128. It leaves `session.svelte.ts` as a **question and not an array**: an array handed out is an array a component can write to, and that write would be a second road reaching no engine at all, which is the one divergence nothing here could notice. **A cell is on or off** because this milestone has no velocity editor; remembering that a struck-out cell was at 0.7 is the document's job and the document is M2.

Two more things about the page are worth knowing before touching it. **The pattern is installed on every start**, `ClearPattern` and then a record per live cell, including the start with nothing to install — a path taken only by the restart button is a path that rots, and this is the M2 rehydration in miniature. And **the playhead never touches the reactive graph**: one frame loop reads the telemetry once and hands that reading both to the canvas painters, every frame, and to the runes, fifteen times a second. The split is measured rather than tasteful — the cost is per update of anything, not per unit of work — and the two frequencies mean the numbers lag the line by up to an interval.

**`ui/` divides by what a test can reach, exactly as `worklet/` does.** Nothing in this package can execute a `.svelte` file: the suite runs under Node with no DOM and no component runner. So arithmetic lives in plain modules with specs beside them — `ui/paint.ts` for where the playhead and the meters go, `ui/format.ts` for the transport clock — and the components keep the element, its size and the subscription. The line is not tidiness: of the four defects the UI step produced, **none was found by reading** — three by looking at the running page and one by moving arithmetic out of a component into a module with a spec beside it.

## Architecture

### Memory: two buffers that are not the same buffer

The `SharedArrayBuffer` and the WASM linear memory are distinct. The ring buffers live in the SAB and the engine never sees them; `engine_cmd_ptr` / `engine_telemetry_ptr` address WASM linear memory and are *exchange points*, not the rings themselves. Per quantum the worklet copies command bytes SAB → linear memory, calls `engine_process`, then copies telemetry back linear memory → SAB under a seqlock.

Two consequences that shape the Rust code:

- Every hot-path buffer is allocated once in `engine_new` and never moves again. `memory.grow` detaches every JS view over linear memory, and the growth could happen inside `port.onmessage` between two `process()` calls. `lib.rs::buffers_never_move` is the test that pins this.
- `CMD_CAPACITY` (256 records) is the size of the exchange area, not of the SAB ring (1024 records). Overflow is not an error: the remainder waits one quantum.

### Ownership split

`Instance` (in `lib.rs`) owns the memory whose addresses are handed out. `Engine` (in `engine.rs`) owns nothing and takes slices:

```rust
pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], commands: &[u8], cmd_count: u32)
pub fn write_telemetry(&self, words: &mut [u32])
```

This is not stylistic. Rendering proceeds in segments *between* commands, so a quantum must read the command block while mutating transport state — if both were fields of `self`, the borrows would conflict. It also makes `Engine` allocation-free and able to render into an arbitrary buffer, which is what the offline renderer will need.

**All `unsafe` lives in `lib.rs`.** Everything else is safe Rust tested with plain `cargo test` on the native target.

### The ABI contract is mirrored, in both directions

Two shapes cross the ABI, each described twice — once per language — and each pair edited together. A mismatch produces silently wrong behavior that is very expensive to diagnose.

- **UI → audio, the 16-byte little-endian record:** `crates/engine/src/commands.rs` and `web/src/audio/protocol.ts`.
- **audio → UI, the telemetry block in linear memory:** the constants at the top of `crates/engine/src/engine.rs` and `web/src/worklet/telemetry-block.ts`.

A third thing crosses with them and is not a layout: **the grid the record's address fields index** — `TRACKS` in `lib.rs` and `STEPS` in `pattern.rs`, mirrored by both names in `protocol.ts`. No byte moves when it changes (`arg_a` is a byte at 8 tracks and at 12), and its failure is unlike either shape above: an index past the end of the grid is *dropped*, which is the correct guard, so a page built for twelve tracks against an engine holding eight gets four tracks that accept every command and do nothing, with no counter anywhere to show it. Ranges — gains, pan, velocity — are deliberately **not** mirrored: a value outside its limits is clamped and still sounds, so keeping the UI inside it is the UI's business; only the addressing has to agree.

**The refusal codes `engine_sample_commit` answers with are not mirrored either, and that is the whole of why they are numbers.** The far side reports the code beside the context it already holds — which slot, at what offset, how much was reserved — and never names the cause. A table of names over there would be a third correspondence of exactly the opcode-table kind, failing the same way: the page names a cause that did not fire and the reader fixes the wrong thing. The general rule is **pin whatever you interpret; the way out of a pin is to interpret less, not to skip it.** The condition for changing this is written at the codes in `lib.rs`: a kit the page did not lay out itself.

The guards:

- `PROTOCOL_VERSION` — **its scope is all three**, and that is what makes it useful: anything left outside its scope is where neither check below fires and the symptom is wrong values rather than silence. Bump on any change to any of them.
- `engine_protocol_version()` is exported so the check compares against a number that came out of the *compiled engine*. The version field in the SAB header is written by the UI, so comparing it against `protocol.ts` compares JS with itself and proves nothing — what that one does catch is a worklet bundle that was not rebuilt.
- Four pinning tests, one per shape per language: `commands::tests::wire_format_is_pinned` and `protocol.spec.ts` for the record, `engine::tests::telemetry_layout_is_pinned` and `telemetry-block.spec.ts` for the block. Each asserts against literals rather than against the constants the code reads — a test that reads them agrees with whatever they say, which is why swapping two telemetry indices once left all sixty-nine Rust tests green. Any of the four failing is the signal to update both sides and bump the version.
- **The opcode set is pinned apart from the byte layout**, by a table in each language — `commands::tests::OPCODES` and the one at the top of `protocol.spec.ts`. The four pins above fix where a field sits, not which opcodes exist, and the two are different failures. Both tables are literals for the same reason as the pins, and both are the first thing to extend when an opcode is added: on the Rust side `Op::from_byte` ends in `_ => None`, so a variant missing from it compiles cleanly and decodes to nothing at all; on the TS side the table is keyed by the `Command` union, so a variant missing an entry does not compile.
- **The grid is pinned in each language too** — `commands::tests::grid_dimensions_are_pinned` and its mirror in `protocol.spec.ts`, plus one test per side asserting the grid still fits the fields that address it (`TRACKS` ≤ 2⁸, `STEPS` ≤ 2¹⁶ — the only statement anywhere tying a field's width to the grid's size, and `setUint8` wraps silently). Note what these two pins can and cannot do: a literal agrees with its own language by construction, so **neither can catch a grid that differs between the languages** — only the version check does that. What the pins buy is that bumping the version stops being optional.
- `tests/engine-abi.spec.ts` is the only place either shape is checked against the *compiled* artifact, in both directions. The grid is not among what it can see: it reaches no sample and `Pattern` is not on the C ABI, so that half waits for the sampler.

There is deliberately no `engine_telemetry_words()`: the version check already refuses a mismatched build, and refuses it before the first quantum rather than after the field counts disagree. **The same argument refuses `engine_tracks()` and `engine_steps()`** — worth knowing before reaching for them, because "let the engine say how big its grid is" is the obvious move and it buys a second, later check of what the version already refuses.

Transport position is `u64` end to end, carried as two `u32` words (lo/hi) in both the protocol and the telemetry. On the JS side it stays a plain `number` (exact to 2^53); `BigInt` is not used anywhere.

### The TypeScript half splits by what a test can reach

`AudioWorkletProcessor` cannot be constructed outside a browser, and `registerProcessor` runs on import — so anything left inside `processor.ts` is code no test will ever run, and nothing can import out of it either. The split follows from that, not from taste:

- `worklet/processor.ts` — only what needs a browser: the class shape, the port, the render loop.
- `worklet/engine.ts` — bring-up as decisions. `openEngine` takes `EngineExports` rather than a `WebAssembly.Module` precisely so a fake can report the wrong version or refuse the arguments; the real artifact never will on demand.
- `worklet/render.ts` — the hot path, under different rules from everything around it.
- `worklet/kit.ts` — the other moment: what arrives on the port, between quanta. The only code in the worklet that grows linear memory, which is what makes the revalidation in `render.ts` load-bearing rather than precautionary. Out of `processor.ts` for the same reason bring-up is — a failure path inside the class is one no test has ever taken — and out of `engine.ts` because bring-up happens once and this happens whenever the page loads a kit.
- `audio/host.ts` — main-thread bring-up: compile, load, connect, and the check that the context actually reached `running`.
- `audio/kit.ts` — the cold half of a load: the network, the decode, and the pass that turns planar channels into the interleaved run the arena is. Interleaving happens here rather than over there because this side has already copied the data once and the other side would be doing it in a message handler on the audio thread.
- `audio/protocol.ts` — the record format, the JS half of the first contract above. In `audio/` because both threads use it: the page encodes, the worklet copies.
- `worklet/telemetry-block.ts` — the block layout, the JS half of the second. In `worklet/` because the three contracts here divide by which memory each describes, and this one describes WASM linear memory, which only the audio thread ever addresses. By the same rule `audio/ring.ts` describes the SAB and is shared, and anything added later lands by asking the same question.
- `state/session.svelte.ts` — the page's whole relationship with a live engine: the readings, the verbs, and the only `send` there is. A module and not a few `let`s in a component because a `send` living in a component is a `send` every later component has to be handed, and the first one that is not handed it reaches for the handle instead.
- `ui/*.svelte` — the same rule as `processor.ts`, one level up: nothing here can run a `.svelte` file, so what stays in one is the markup, the styles, the element and the subscription.
- `ui/paint.ts`, `ui/format.ts` — and therefore everything those files would otherwise have contained that a test could call. Both take contexts and values narrowed to what they touch, so the fakes beside them are honest rather than cast.

**Failures are values, not exceptions.** Forced, not stylistic: the processor constructor cannot let an exception escape — it would reach the page as a bare `processorerror` event carrying no reason at all — and on the page every failure presents identically, as silence, so the case has to survive to somewhere it can be described. Each failure that has to reach a person has a tagged union and a `describe*` function whose `switch` has no `default` — three of them now: bring-up and kit loading on the audio side, starting on the page's. `@typescript-eslint/switch-exhaustiveness-check` is on, and each union is pinned again by a test keyed on `Record<Kind, …>`, so adding a case fails to compile in two places at once.

`worklet/engine.ts` and `audio/result.ts` each declare their own `Result` rather than sharing one. They never exchange these values — different threads, neither calls the other — so a shared type would link them by name without linking anything real. The tests unwrap both through one structural helper, which is the only identity that has to hold. The page's went into a file of its own the moment a second page module needed it; the worklet's has not, because bring-up is still where a reader would look for it.

**Nothing allocates in `renderQuantum`.** At 48 kHz that path runs 375 times a second on the one thread that must not collect garbage. `subarray` builds a new view object per call, which is why the whole-view copy is a separate branch and not a micro-optimisation; `render.spec.ts` spies on `Float32Array.prototype.subarray` to keep it that way.

**Tests are `*.spec.ts` and sit next to the module they cover. `src/` holds nothing else that is test-only** — support and fakes live in `web/tests/support/`, so what ships and what does not is visible from the path rather than inferred from a filename. `web/tests/` holds the specs with no single module to sit beside, and there are two. `engine-abi.spec.ts` instantiates the compiled wasm and checks it against the TypeScript mirrors in both directions — records written by the shipping encoder and read by the shipping decoder, and the telemetry block read back where `telemetry-block.ts` says it is. That is the part of the contract neither side can verify alone. `ring-concurrency.spec.ts` runs both ends of the ring at once on a real `worker_threads` worker — the page's writer and reader against the worklet's drain and publish — because the two orderings that make the ring correct are invisible to a single thread: there is no moment between the two lines for anyone to look in. Its worker is bundled by esbuild from the shipping modules at test time and started from the string, so nothing about it is a second implementation and it leaves no artifact behind.

**A concurrency test is worth exactly what its mutations say it is.** This one is checked against five, and the result is recorded in its header because it divides the ring's guards in two rather than adding to them: three defects only the two threads can see, two only substitution can, and neither kind covers the other. One of those three also needed the drain sized to the whole ring before it became observable at all — at the exchange area the engine actually reports, the cushion behind a drain hides it in ten runs out of ten. Reach for the same measurement before trusting any test written here for a race: the failure mode of such a test is passing.

### Everything crossing the ABI is untrusted

Another thread writes the command bytes and supplies the record count, so every index is checked, every pointer is null-checked, `frames` is clamped to `max_frames`, and `cmd_count` is clamped to the actual slice. Unknown opcodes decode to `None` rather than panicking. Release builds set `panic = "abort"`, so a single panic kills the worklet and sound is gone until the page reloads — there is no recoverable failure mode here. Both `ring.rs` and `lib.rs` carry fuzz-style tests that feed xorshift garbage through the decoder.

### Rules for any module that touches samples

Checked at review alongside "no allocations". These defects surface far from where they were introduced:

1. **Flush denormals explicitly.** WASM has no FPU flush-to-zero, and the symptom is CPU climbing *during silence*. Any module with feedback state (filters, delays, envelopes, meter ballistics) runs its state through `fz()` in `dsp.rs` — threshold `1e-20`. What decides is feedback, not the category: `Smoothed` is a parameter smoother with no state fed back into itself, so it needs no flush, and its doc comment says why rather than leaving the omission to be read as an oversight.

   **There is a second door, and it is not feedback: values arriving from across the ABI are flushed where they are clamped** (`mixer::clamped`, `Pattern::set_step`). A gain of `1e-40` is finite and inside every range, so it survives the NaN check and the clamp, and then multiplies every frame — same symptom, no feedback anywhere. A slider cannot produce such a value; a project file, an automation curve and a MIDI controller can, and everything crossing the thread boundary is input.
2. **Interpolate parameters per frame** — a stepped gain/cutoff/pan change is zipper noise. `dsp::Smoothed` is what does it, and it is a **linear ramp rather than a one-pole**, for a reason worth knowing before writing another smoother: a one-pole does not arrive in `f32`. As the remaining distance shrinks its per-frame increment falls below half an ulp of the current value and rounds away, so the parameter stalls short of the target — measured at 0.5000143 when gliding to 0.5. Gliding to *zero* converges fine, which is what makes it easy to ship: the failure hides wherever the target is not zero, and only an exact comparison finds it.
3. **No NaN or Inf on the output.** One NaN poisons feedback permanently. Debug builds assert at module boundaries.
4. **Deterministic.** No wall-clock time, no ambient randomness; noise only from an explicitly seeded generator. The golden render tests compare bit for bit.
5. **Explicit `reset()`** returning the module to its as-constructed state, or the offline render compares a warmed-up instance against a cold one.

### Timing

`Transport` keeps `sample_pos: u64` and is the single source of truth. Musical position is *computed* from the sample position, never accumulated frame by frame — accumulation drifts, and the drift only shows up ten minutes into a track. A tempo change drops an anchor (`epoch_sample` + `epoch_beat`) and counts from it, so the musical grid stays continuous and error cannot pile up across changes. `transport::tests::no_drift_over_long_run` exists to catch anyone rewriting `sample_of_beat` as accumulation.

## Cargo layout gotchas

- `[profile.*]` is read **only** from the root `Cargo.toml`. In a workspace member it is silently ignored, and you get a build with no `lto` and no `panic = "abort"` that looks entirely successful.
- `panic = "abort"` is in `[profile.release]` only — in dev/test it breaks the test harness, which needs unwind.
- `crate-type = ["cdylib", "rlib"]`. Without `rlib`, integration tests under `tests/` and benchmarks do not link at all.

## Dependencies and license

The project is proprietary — all rights reserved, `LICENSE` at the root — and the repository is public only so the code can be read. Being public grants nothing: a license is a permission, and none is given.

That fixes what may be depended on. **Permissive licenses (MIT, Apache-2.0, BSD, ISC) and MPL-2.0 are fine. GPL, AGPL and LGPL are not.** The page ships its JavaScript and WASM to every visitor, and that is distribution — copyleft would then oblige us to hand each of them the source. LGPL's escape hatch, that the user be able to swap the library out, means nothing for a statically linked WASM module, so it goes with the rest.

Check the license before adding a dependency, not after; removing one later costs more than writing the thing did. Today the engine has zero dependencies and `web/` has none outside devDependencies, all of them permissive.

The one place this will bite is time-stretching on M7: Rubber Band is GPL-3.0 or a paid commercial license, SoundTouch is LGPL. That algorithm gets written here or bought — it is the only point on the roadmap where the license choice costs anything.

## Comment style

A comment argues for itself, in front of whoever is reading the repository. Planning for this project happens in a document that is not in git, and **a reference to it does not belong in code**: a pointer to a file the reader cannot open explains nothing, and the reasoning it stands in for is exactly what the comment was supposed to carry. Write the argument out. This has been cleaned out of the code twice already — the second time from comments written a day after the first.

That rule says what to write instead of a pointer. It does not say how much, and read alone it has been taken as licence for volume — so the bar it implies is written out here too, because the density it produced was defended by pointing at the density already in the repository, which is an argument that goes in a circle.

**A comment carries what the code cannot. Everything else is restatement, however well written** — and restatement is what teaches a reader to skip the comments that matter. The check is mechanical: delete it, and ask what is lost. If the answer is anything recoverable by reading the next few lines, it was restatement.

Three things are not recoverable that way, and they are the whole of the licence:

- **the alternative that lost.** Code shows what was chosen and never what was not, so a decision with a live alternative is invisible without a comment — one arena against eight fixed slots, a linear ramp against a one-pole.
- **the failure that follows.** What breaks if this line changes, when the break is silent, remote or late: `f32::clamp` passing NaN straight through, a release that never quite reaches zero and holds its voice in the pool forever.
- **a fact from outside the file.** An allocation WASM cannot serve aborting rather than returning null, linear memory never shrinking, `decodeAudioData` resampling to the device rate.

**One argument, one home.** The same reasoning in two places is not emphasis, it is two copies that will disagree. Put it where the reader arrives at it — at the call, at the guard, at the declaration — and leave the other sites saying only what is theirs. A delegating method inherits the argument of what it delegates to and needs none of its own.

## Test style

Tests here are documentation of *why*, not just coverage. Test names are sentences and comments explain the failure being guarded against — match that style when adding to them.