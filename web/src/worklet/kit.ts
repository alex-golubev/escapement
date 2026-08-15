// The one thing the page sends the audio thread, and what the audio thread does
// with it.
//
// Apart from processor.ts for the reason everything is: that file cannot be
// constructed outside a browser, so a failure path left in it is a failure path
// no test has ever taken. Apart from engine.ts because the two are different
// moments — bring-up runs once, before the first quantum, while this runs
// between quanta for as long as the page keeps loading kits.
//
// **It is the only code in the worklet that grows linear memory**, and so the
// only reason `refreshViews` is load-bearing rather than precautionary. Nothing
// here is on the render path; the render path only has to survive it.

import { describeValue, err, messageOf, ok } from './engine'
import type { EngineState, Result } from './engine'
import type { KitSample, WorkletMessage } from '../audio/worklet-messages'

/** What went in. Readings for the page to show, not a promise that it sounds. */
export interface LoadedKit {
  readonly slots: number
  readonly floats: number
}

/**
 * Why a kit did not go in.
 *
 * Tagged like the other two unions here so a test can assert on the case rather
 * than on prose, and so a case added to it fails to compile in
 * `describeKitError` instead of falling through to nothing.
 *
 * Two of these are refusals from the engine and two never reach it. The
 * difference matters to a reader: `malformed` means the page sent something
 * that is not a kit, and no memory was touched at all, so nothing that was
 * loaded before it has changed.
 */
export type KitError =
  | { readonly kind: 'no-engine' }
  | { readonly kind: 'malformed'; readonly received: string }
  /**
   * The engine has the two functions declared and one of them could not be
   * called. **This is the only place a lost export of that pair can show up**,
   * and the reason is worth knowing: bring-up proves the ABI by calling it, and
   * neither of these is called there — so an engine built before they existed
   * comes up, renders, and fails only when a kit arrives. `build-wasm.sh` and
   * the staleness check guard that at build time; this guards it at the one
   * moment neither of them is running.
   *
   * It exists at all because the answer has to be total. A load that throws its
   * way out of the message handler leaves the page waiting for a reply that
   * will never come, which is a state it has no way out of.
   */
  | { readonly kind: 'abi-unusable'; readonly message: string }
  | { readonly kind: 'refused-arena'; readonly floats: number }
  | {
      readonly kind: 'refused-sample'
      /**
       * The engine's number for the cause, carried and not translated. The
       * decision is argued beside the codes in `lib.rs`; what follows for this
       * file is that every other field here exists because *this* side knows it
       * and the number alone would not say it.
       */
      readonly code: number
      readonly slot: number
      readonly offset: number
      readonly frames: number
      readonly channels: number
      readonly floats: number
    }

export function describeKitError(error: KitError): string {
  switch (error.kind) {
    case 'no-engine':
      return 'There is no engine to load a kit into: this processor never came up'
    case 'malformed':
      return `The message is not a list of samples this build can load (${error.received})`
    case 'abi-unusable':
      return `The engine is loaded but its sample ABI could not be called: ${error.message}`
    case 'refused-arena':
      return `The engine would not reserve ${error.floats} values for the kit — there is not that much memory`
    case 'refused-sample':
      return (
        `The engine refused slot ${error.slot} with code ${error.code}. It was declared at ` +
        `offset ${error.offset}, ${error.frames} frames of ${error.channels} channels, in an ` +
        `arena of ${error.floats}. The code is named in crates/engine/src/lib.rs; the kit was ` +
        `dropped, so nothing is loaded`
      )
  }
}

/**
 * Narrow what arrived into a kit.
 *
 * Checked and not cast, for the reason `readModule` gives: this crosses a
 * thread boundary through structured clone, so the declared type of
 * `LoadKitMessage` describes what the page meant to send and not what arrived.
 *
 * What is checked here is only what this side is about to *use*: that there are
 * samples, that each carries data, and that the channel count divides the data
 * it is declared over. The last is this module's own — the frame count is
 * computed from it below, and a count that is not a whole number arrives at the
 * ABI truncated, declaring a sample shorter than the one that was written. What
 * is deliberately not checked is the range of the channel count or how many
 * slots there are: the engine refuses both by name, and a second guard in front
 * of it would be a second opinion.
 */
function readKit(samples: unknown): Result<readonly KitSample[], KitError> {
  if (!Array.isArray(samples)) {
    return err({ kind: 'malformed', received: describeValue(samples) })
  }

  const list = samples as readonly unknown[]
  const kit: KitSample[] = []
  for (let index = 0; index < list.length; index += 1) {
    const sample = list[index] as { data?: unknown; channels?: unknown } | null | undefined
    const data = sample?.data
    const channels = sample?.channels

    if (!(data instanceof Float32Array)) {
      return err({
        kind: 'malformed',
        received: `sample ${index} carries ${describeValue(data)}`,
      })
    }
    if (typeof channels !== 'number' || !Number.isInteger(channels) || channels < 1) {
      return err({
        kind: 'malformed',
        received: `sample ${index} declares ${String(channels)} channels`,
      })
    }
    if (data.length % channels !== 0) {
      return err({
        kind: 'malformed',
        received: `sample ${index} has ${data.length} values in ${channels} channels`,
      })
    }

    kit.push({ data, channels })
  }
  return ok(kit)
}

/**
 * Put a kit into the engine, replacing whatever is in it.
 *
 * The whole kit at once, because the reservation replaces the arena: laying
 * eight samples out takes all eight lengths, and everything loaded before is
 * gone whether or not this succeeds. Every voice stops with it — argued at
 * `Sampler::reserve`, which is what does it.
 */
export function loadKit(
  state: EngineState | null,
  samples: unknown,
): Result<LoadedKit, KitError> {
  if (state === null) return err({ kind: 'no-engine' })

  const kit = readKit(samples)
  if (!kit.ok) return kit

  const { exports, instance } = state
  const floats = kit.value.reduce((sum, sample) => sum + sample.data.length, 0)

  // Everything that touches the ABI is inside, and the catch is deliberately
  // wide: from where the page stands there is one thing to do about any throw
  // from here, which is read it. What it is really for is the missing export —
  // see `abi-unusable`.
  try {
    const arena = exports.engine_bank_reserve(instance, floats)
    if (arena === 0) return err({ kind: 'refused-arena', floats })

    // Built after the reservation and dropped at the end of this call. Both
    // halves matter: the reservation may have grown linear memory, which
    // detaches every view older than this line, and the next one replaces the
    // address this sits on — so a view kept in `EngineState` would be rebuilt
    // by `refreshViews` onto an arena the engine has already given up.
    const arenaView = new Float32Array(exports.memory.buffer, arena, floats)

    let offset = 0
    for (let slot = 0; slot < kit.value.length; slot += 1) {
      const { data, channels } = kit.value[slot]
      arenaView.set(data, offset)

      // Written first, then declared: declaring is what makes the engine sweep
      // the region for values it will not play, so a slot declared ahead of its
      // data is a slot swept over what was there before it.
      const frames = data.length / channels
      const code = exports.engine_sample_commit(instance, slot, offset, frames, channels)
      if (code !== 0) {
        // The whole kit goes, not the slot that was refused. What the page
        // asked for is a kit, and half of one is a state nobody named: the page
        // would hold a failure while the engine sounded part of it, which is
        // the projection drifting from what plays. Reserving nothing is how
        // this side says the bank is empty, and it costs nothing — the arena
        // keeps the memory it was given either way.
        exports.engine_bank_reserve(instance, 0)
        return err({ kind: 'refused-sample', code, slot, offset, frames, channels, floats })
      }
      offset += data.length
    }
  } catch (error) {
    return err({ kind: 'abi-unusable', message: messageOf(error) })
  }

  return ok({ slots: kit.value.length, floats })
}

/**
 * Answer one message from the page, or `null` for one this build does not know.
 *
 * Silence for the unknown case, and it is covered rather than ignored: the page
 * and the worklet are separate build artifacts, and a page speaking a language
 * this bundle does not is exactly what the version word in the ring header
 * refuses before the first quantum. A message arriving here that is not a kit
 * means that check was passed by two artifacts that agree, so there is nothing
 * left for this line to report.
 */
export function answerKitMessage(
  state: EngineState | null,
  data: unknown,
): WorkletMessage | null {
  const message = data as { type?: unknown; samples?: unknown } | null | undefined
  if (message?.type !== 'load-kit') return null

  const loaded = loadKit(state, message.samples)
  return loaded.ok
    ? { type: 'kit-loaded', ...loaded.value }
    : { type: 'kit-refused', message: describeKitError(loaded.error) }
}
