// Fetching a kit and getting it into the shape the audio thread wants.
//
// The cold side of the load, and everything expensive about it lives here: the
// network, the decode, and the one pass that turns planar channels into the
// interleaved run the arena is laid out as. What crosses to the worklet after
// that is data it can `set` in one call — no loop and no arithmetic on the
// thread that must not stall.
//
// The first module here described as Effects rather than run as promises, and
// what that buys is not the combinators. It is that the two failures are in the
// type: `fetchKit` cannot be used without them being dealt with, where the old
// `Promise<Result<…>>` merely offered an `.ok` to forget. Nothing runs in this
// file — an Effect is a description, and the running happens in `state/`, which
// is the boundary this module sits on the far side of.
//
// `decodeAudioData` is a **temporary dependency and needs replacing**, which is
// easy to forget because it works. It resamples to the rate of whatever device
// the context opened, so the same file decodes to different samples on a 44.1
// and a 48 kHz machine — and that undoes determinism, which is what the golden
// renders on M3 are built on. The WAV decoder that replaces it is Rust, arrives
// with those tests, and changes nothing else here.

import { Context, Data, Effect, Layer } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientResponse,
} from 'effect/unstable/http'
import { messageOf } from './result'
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

/**
 * The two ways a kit does not arrive.
 *
 * `Data.TaggedError` rather than the `Schema.TaggedError` Effect's own guidance
 * reaches for first, and the difference was measured rather than assumed: the
 * schema costs 10 kB gzip on the page, 45.7 against 35.7, because describing
 * two shapes drags in the module that decodes and encodes every shape. Neither
 * of these ever crosses a wire or a file — each is read exactly once, by the
 * function below, and after that it is a sentence on a page. Reach for the
 * schema when a failure has to survive being written down; these do not.
 *
 * The URL is on both because the failure travels alone. Which of eight files
 * stopped the load is the only part of it anybody can act on.
 */
export class KitUnreachable extends Data.TaggedError('KitUnreachable')<{
  readonly url: string
  readonly detail: string
}> {}

export class KitUndecodable extends Data.TaggedError('KitUndecodable')<{
  readonly url: string
  readonly message: string
}> {}

export type KitFailure = KitUnreachable | KitUndecodable

export function describeKitFailure(failure: KitFailure): string {
  switch (failure._tag) {
    case 'KitUnreachable':
      return `${failure.url} could not be fetched. Build the kit with node scripts/synthesize-kit.mjs — ${failure.detail}`
    case 'KitUndecodable':
      return `${failure.url} was fetched but the browser would not decode it: ${failure.message}`
  }
}

/**
 * What turns bytes into samples, as a service rather than a parameter.
 *
 * A service and not an argument because that is the seam Effect already has,
 * and one seam is better than two: the network half arrives as `HttpClient`
 * whether we like it or not, so a hand-rolled parameter beside it would be a
 * second way to say the same thing. A test provides a layer for both.
 *
 * This one has to be injected somehow, and unlike `fetch` the reason is real:
 * `decodeAudioData` hangs off an `AudioContext`, and Node has no such thing.
 * The URL is a parameter only so the failure can name a file — the decoder is
 * the one place that knows the bytes were refused and the only place that does
 * not know which of eight they were.
 */
export class KitDecoder extends Context.Service<
  KitDecoder,
  {
    decode(url: string, bytes: ArrayBuffer): Effect.Effect<DecodedSample, KitUndecodable>
  }
>()('daw/audio/KitDecoder') {
  /**
   * Built from the context that will play the samples, which is what decides
   * their rate.
   *
   * The call stays a method on `context` rather than becoming a reference to
   * it: `decodeAudioData` throws an illegal-invocation TypeError when called
   * without its context.
   */
  static readonly fromAudioContext = (context: BaseAudioContext): Layer.Layer<KitDecoder> =>
    Layer.succeed(
      KitDecoder,
      KitDecoder.of({
        decode: (url, bytes) =>
          Effect.tryPromise({
            try: () => context.decodeAudioData(bytes),
            // `decodeAudioData` rejects with a bare `DOMException` on anything
            // it does not recognise, and says nothing about which byte it gave
            // up on.
            catch: (error) => new KitUndecodable({ url, message: messageOf(error) }),
          }),
      }),
    )
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
export function fetchKit(
  urls: readonly string[] = KIT_URLS,
): Effect.Effect<readonly KitSample[], KitFailure, HttpClient.HttpClient | KitDecoder> {
  // In sequence rather than at once, which is `forEach`'s default and is being
  // relied on rather than merely accepted — a `{ concurrency }` option added
  // here would change the answer, not just the timing. Eight small files over a
  // warm connection are not worth the parallelism, and in a row the failure
  // that comes back is the first one in the kit rather than whichever lost the
  // race, which is the difference between an answer that is the same every time
  // and one that is not.
  return Effect.forEach(urls, fetchSample)
}

const fetchSample = Effect.fn('fetchSample')(function* (url: string) {
  // One pipeline for the whole network half, and one mapping at the end of it.
  // Everything before that step fails the same way as far as this module is
  // concerned — nothing answered, or what answered was not the file — so
  // splitting it would mean writing that conclusion twice.
  //
  // `filterStatusOk` is the step that makes a 404 a failure: a served error
  // page is a request that succeeded, and without it the bytes of that page
  // would go to the decoder.
  const bytes = yield* HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.mapError((error) => new KitUnreachable({ url, detail: detailOf(error) })),
  )

  const decoder = yield* KitDecoder
  return interleave(yield* decoder.decode(url, bytes))
})

/**
 * What to say about a request that did not produce a file.
 *
 * Decided by the reason's tag, not by whether `error.response` is there —
 * asking that answers a different question. Three of the six reasons carry a
 * response, and one of them is the `DecodeError` a body that breaks mid-read
 * produces, with the 200 that was served still sitting on it. Reading the field
 * therefore reported a healthy server about a download that failed, which the
 * spec beside this now holds.
 *
 * The status is pulled out rather than left to the error's own message: that
 * message names the method and the URL as well, and the URL is already on the
 * failure, so `describeKitFailure` would print it twice.
 */
function detailOf(error: HttpClientError.HttpClientError): string {
  const reason = error.reason
  return reason._tag === 'StatusCodeError'
    ? `the server answered ${reason.response.status}`
    : error.message
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
  // Both read once, and the second one is why this is worth saying: on a real
  // `AudioBuffer` these are getters, so `decoded.length` in the loop condition
  // is a call per frame — hundreds of thousands of them across a kit, for a
  // number that cannot change while this runs.
  const channels = decoded.numberOfChannels
  const frames = decoded.length
  const data = new Float32Array(frames * channels)

  for (let channel = 0; channel < channels; channel += 1) {
    const source = decoded.getChannelData(channel)
    for (let frame = 0; frame < frames; frame += 1) {
      data[frame * channels + channel] = source[frame]
    }
  }

  return { data, channels }
}

/**
 * The whole load, wired to the browser it runs in and needing nothing further.
 *
 * Both layers are provided here rather than at the call site so that what
 * `state/` holds is an Effect with no requirements left in it. That keeps the
 * seam between the two halves of the page exactly where it was: the page still
 * hands in a function of a context, and a test still hands in another one,
 * neither of them knowing that services exist.
 */
export function browserKit(
  context: BaseAudioContext,
): Effect.Effect<readonly KitSample[], KitFailure> {
  return fetchKit().pipe(
    Effect.provide([FetchHttpClient.layer, KitDecoder.fromAudioContext(context)]),
  )
}
