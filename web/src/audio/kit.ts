// Fetching a kit and getting it into the shape the audio thread wants.
//
// The cold side of the load, and everything expensive about it lives here: the
// network, the decode, and the one pass that turns planar channels into the
// interleaved run the arena is laid out as. What crosses to the worklet after
// that is data it can `set` in one call — no loop and no arithmetic on the
// thread that must not stall.
//
// `decodeAudioData` is a **temporary dependency and needs replacing**, which is
// easy to forget because it works. It resamples to the rate of whatever device
// the context opened, so the same file decodes to different samples on a 44.1
// and a 48 kHz machine — and that undoes determinism, which is what the golden
// renders on M3 are built on. The WAV decoder that replaces it is Rust, arrives
// with those tests, and changes nothing else here.

import { err, messageOf, ok } from './result'
import type { Result } from './result'
import type { KitSample } from './worklet-messages'

/**
 * The kit, in track order.
 *
 * This list is where a sound is assigned to a row: slot `n` is track `n`, with
 * no table in between — argued at `SLOTS` in `sampler/bank.rs`. The files are
 * built by `scripts/synthesize-kit.mjs` and committed; replacing them with real
 * recordings needs nothing from this file but their names.
 */
export const KIT_URLS = [
  '/kit/kick.wav',
  '/kit/snare.wav',
  '/kit/hat-closed.wav',
  '/kit/hat-open.wav',
  '/kit/clap.wav',
  '/kit/tom.wav',
  '/kit/rim.wav',
  '/kit/cowbell.wav',
] as const

/**
 * What to call each row, in track order.
 *
 * Derived from the list above rather than written out beside it: two lists in
 * the same order are one list and a way for them to stop being in the same
 * order. Here rather than wherever a row is drawn, because the name of a sound
 * belongs with the sound, and the page that draws it is not the only one that
 * will ever want to say which is which.
 */
export const KIT_NAMES: readonly string[] = KIT_URLS.map((url) =>
  url.slice('/kit/'.length, -'.wav'.length),
)

/**
 * The part of `AudioBuffer` this reads.
 *
 * Narrow on purpose, and for the reason `ReadyEndpoint` in host.ts is: a real
 * `AudioBuffer` cannot be built outside a browser, so against the full type
 * every path below would be a path no test can take.
 */
export interface DecodedSample {
  readonly numberOfChannels: number
  readonly length: number
  getChannelData(channel: number): Float32Array
}

/** As much of a `Response` as the load ever asks for. */
export interface KitResponse {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Where the bytes come from and what turns them into samples.
 *
 * Parameters rather than `fetch` and a context reached for directly, for the
 * same reason: under Node there is neither.
 */
export interface KitSource {
  fetch(url: string): Promise<KitResponse>
  decode(bytes: ArrayBuffer): Promise<DecodedSample>
}

export type KitFailure =
  | { readonly kind: 'unreachable'; readonly url: string; readonly detail: string }
  | { readonly kind: 'undecodable'; readonly url: string; readonly message: string }

export function describeKitFailure(failure: KitFailure): string {
  switch (failure.kind) {
    case 'unreachable':
      return `${failure.url} could not be fetched. Build the kit with node scripts/synthesize-kit.mjs — ${failure.detail}`
    case 'undecodable':
      return `${failure.url} was fetched but the browser would not decode it: ${failure.message}`
  }
}

/**
 * Fetch and decode the whole kit, or answer with the first thing that stopped
 * it.
 *
 * All of it or none, and that is not caution: the engine replaces its arena on
 * every load, so a kit is what it takes or nothing is. A page that sent seven
 * samples because the eighth would not decode would be silently choosing a
 * different instrument.
 */
export async function fetchKit(
  source: KitSource,
  urls: readonly string[] = KIT_URLS,
): Promise<Result<readonly KitSample[], KitFailure>> {
  const samples: KitSample[] = []

  // In sequence rather than at once. Eight small files over a warm connection
  // are not worth the parallelism, and in a row the failure that comes back is
  // the first one in the kit rather than whichever lost the race — which is the
  // difference between an answer that is the same every time and one that is
  // not.
  for (const url of urls) {
    const decoded = await fetchSample(source, url)
    if (!decoded.ok) return decoded
    samples.push(decoded.value)
  }

  return ok(samples)
}

async function fetchSample(
  source: KitSource,
  url: string,
): Promise<Result<KitSample, KitFailure>> {
  let bytes: ArrayBuffer
  try {
    const response = await source.fetch(url)
    if (!response.ok) {
      return err({ kind: 'unreachable', url, detail: `the server answered ${response.status}` })
    }
    bytes = await response.arrayBuffer()
  } catch (error) {
    return err({ kind: 'unreachable', url, detail: messageOf(error) })
  }

  try {
    return ok(interleave(await source.decode(bytes)))
  } catch (error) {
    // `decodeAudioData` rejects with a bare `DOMException` on anything it does
    // not recognise, and says nothing about which byte it gave up on.
    return err({ kind: 'undecodable', url, message: messageOf(error) })
  }
}

/**
 * Planar in, interleaved out.
 *
 * `AudioBuffer` keeps a channel per array and the arena keeps a frame at a
 * time, so somebody has to walk it, and it is this side: the page is already
 * the one that copied the file once, while over there the same work would be a
 * per-frame loop in a message handler on the audio thread. Here it costs a pass
 * over a few hundred kilobytes, off any deadline.
 *
 * The array is freshly made and never kept, which is what lets it be
 * transferred to the worklet rather than copied — see `EngineHandle.loadKit`.
 */
export function interleave(decoded: DecodedSample): KitSample {
  const channels = decoded.numberOfChannels
  const data = new Float32Array(decoded.length * channels)

  for (let channel = 0; channel < channels; channel += 1) {
    const source = decoded.getChannelData(channel)
    for (let frame = 0; frame < decoded.length; frame += 1) {
      data[frame * channels + channel] = source[frame]
    }
  }

  return { data, channels }
}

/** Built from the context that will play the samples, which is what decides their rate. */
export function browserKitSource(context: BaseAudioContext): KitSource {
  return {
    fetch: (url) => fetch(url),
    // Bound rather than passed as a method reference: `decodeAudioData` throws
    // an illegal-invocation TypeError if it is called without its context.
    decode: (bytes) => context.decodeAudioData(bytes),
  }
}
