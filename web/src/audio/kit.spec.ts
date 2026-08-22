// Fetching and reshaping a kit, against services that are not a browser's.
//
// Both halves of the load arrive as Effect services, so a test provides layers
// rather than threading fakes through a parameter: a fake `fetch` behind
// `FetchHttpClient.Fetch`, and a `KitDecoder` that answers without a decoder.
// That is why every failure below is one a test can cause on demand rather
// than one nobody has ever seen.
//
// One shim, and it is not a convenience. `HttpClient` resolves every request
// through `new URL(url, baseUrl())`, and Effect's `baseUrl()` reads
// `location.origin + location.pathname` — a browser-only value that is
// `undefined` under Node. Without a `location` the kit's own relative paths
// throw `Invalid URL` before any fetch happens, and this file's mapping turns
// that into `KitUnreachable`: a failure that looks exactly like a server that
// would not answer. Stubbing `location` is what keeps these tests exercising
// the paths the page actually ships instead of absolute ones it never uses.

import { describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import type { HttpClient } from 'effect/unstable/http'
import { beforeAll, expect } from 'vitest'

import {
  KIT_NAMES,
  KIT_URLS,
  KitDecoder,
  KitUndecodable,
  KitUnreachable,
  describeKitFailure,
  fetchKit,
  interleave,
} from './kit'
import { TRACKS } from './protocol'
import type { DecodedSample, KitFailure } from './kit'

const ORIGIN = 'https://daw.test'

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: ORIGIN, pathname: '/' },
    configurable: true,
  })
})

describe('interleave', () => {
  it('lays a stereo sample out a frame at a time', () => {
    // The arena is interleaved and an `AudioBuffer` is not, so this pass is the
    // only place the two layouts meet. Written channel-first, the stereo image
    // comes out as the left channel followed by the right — which the engine
    // reads as one sample of nonsense rather than as a mistake.
    const sample = interleave(
      decoded([new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])]),
    )

    expect(sample.channels).toBe(2)
    expect(Array.from(sample.data)).toEqual([1, 4, 2, 5, 3, 6])
  })

  it('copies a mono sample through as it is', () => {
    const sample = interleave(decoded([new Float32Array([1, 2, 3])]))

    expect(sample.channels).toBe(1)
    expect(Array.from(sample.data)).toEqual([1, 2, 3])
  })

  it('owns the array it hands back', () => {
    // The load transfers these to the audio thread, which detaches them here. A
    // view over the decoded buffer rather than a copy of it would take the
    // browser's own audio data with it.
    const source = new Float32Array([1, 2, 3])
    const sample = interleave(decoded([source]))

    expect(sample.data.buffer, "the sample shares the decoder's buffer").not.toBe(source.buffer)
  })
})

describe('fetchKit', () => {
  it.effect('fetches the kit in the order the tracks are in', () => {
    const asked: string[] = []

    return Effect.gen(function* () {
      const samples = yield* fetchKit(['/one.wav', '/two.wav'])

      expect(asked).toEqual([`${ORIGIN}/one.wav`, `${ORIGIN}/two.wav`])
      expect(samples).toHaveLength(2)
    }).pipe(Effect.provide(wiring({ asked })))
  })

  it.effect('names the file the server would not give it', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fetchKit(['/kit/kick.wav', '/kit/snare.wav']))

      expect(error).toEqual(
        new KitUnreachable({ url: '/kit/kick.wav', detail: 'the server answered 404' }),
      )
    }).pipe(Effect.provide(wiring({ status: 404 }))),
  )

  it.effect('names the file the network never reached', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fetchKit(['/kit/kick.wav']))

      expect(error._tag).toBe('KitUnreachable')
      expect(error.url).toBe('/kit/kick.wav')
    }).pipe(Effect.provide(wiring({ refuseFetch: 'offline' }))),
  )

  it.effect('names the file the browser would not decode', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fetchKit(['/kit/rim.wav']))

      expect(error).toEqual(
        new KitUndecodable({ url: '/kit/rim.wav', message: 'Unable to decode audio data' }),
      )
    }).pipe(Effect.provide(wiring({ refuseDecode: 'Unable to decode audio data' }))),
  )

  it.effect('does not report a body that broke mid-read as a server that answered', () => {
    // Three of the six reasons an `HttpClientError` carries hold a response,
    // not one: a body that fails while being read has a status of 200 sitting
    // on it. Asking whether a response exists therefore answers a different
    // question than the one being asked, and the sentence it produced said the
    // server answered fine about a download that broke.
    const broken = new ReadableStream({
      start: (controller) => {
        controller.error(new Error('connection reset'))
      },
    })

    return Effect.gen(function* () {
      const error = yield* Effect.flip(fetchKit(['/kit/kick.wav']))

      expect(error._tag).toBe('KitUnreachable')
      expect(describeKitFailure(error)).not.toContain('the server answered')
    }).pipe(Effect.provide(wiring({ body: broken })))
  })

  it.effect('stops at the first file that fails rather than fetching the rest', () => {
    // All of it or none: the engine replaces its arena on every load, so seven
    // samples out of eight is a different instrument rather than a partial one.
    const asked: string[] = []

    return Effect.gen(function* () {
      yield* Effect.flip(fetchKit(['/one.wav', '/two.wav']))

      expect(asked).toEqual([`${ORIGIN}/one.wav`])
    }).pipe(Effect.provide(wiring({ asked, status: 500 })))
  })

  it.effect('loads the kit this page actually ships, one sample to a track', () => {
    // The list is what assigns a sound to a row, so its length is the number of
    // tracks: short, it leaves a row that strikes nothing and that the grid
    // labels `undefined`. The order below says nothing about that — it holds for
    // a list of any length — so the length is asserted on its own, against the
    // engine's own count rather than against eight written out here.
    const asked: string[] = []

    return Effect.gen(function* () {
      yield* fetchKit()

      expect(asked).toEqual(KIT_URLS.map((url) => `${ORIGIN}${url}`))
      expect(KIT_URLS).toHaveLength(TRACKS)
      expect(KIT_NAMES).toHaveLength(TRACKS)
    }).pipe(Effect.provide(wiring({ asked })))
  })
})

describe('describeKitFailure', () => {
  it('has a distinct, non-empty message for every failure that exists', () => {
    const samples: Record<KitFailure['_tag'], KitFailure> = {
      KitUnreachable: new KitUnreachable({
        url: '/kit/kick.wav',
        detail: 'the server answered 404',
      }),
      KitUndecodable: new KitUndecodable({ url: '/kit/kick.wav', message: 'DOMException' }),
    }

    const messages = Object.values(samples).map(describeKitFailure)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('never continues a sentence after text that came from elsewhere', () => {
    // The rule the other two unions keep, and both cases here end in text from
    // the browser: a `DOMException` brings its own full stop as often as not.
    const thrown = 'Unable to decode audio data.'

    for (const failure of [
      new KitUnreachable({ url: '/kit/kick.wav', detail: thrown }),
      new KitUndecodable({ url: '/kit/kick.wav', message: thrown }),
    ]) {
      expect(describeKitFailure(failure).endsWith(thrown), failure._tag).toBe(true)
    }
  })
})

/** An `AudioBuffer` as far as this module ever looks at one. */
function decoded(channels: readonly Float32Array[]): DecodedSample {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData: (channel) => channels[channel],
  }
}

interface Wiring {
  /** Every URL the client actually asked for, absolute by the time it gets here. */
  readonly asked?: string[]
  readonly status?: number
  readonly refuseFetch?: string
  readonly refuseDecode?: string
  /** A body that answers, then fails partway — which is not the same as no answer. */
  readonly body?: ReadableStream
}

/** Both services the load needs, answering however a test wants them to. */
function wiring(options: Wiring = {}): Layer.Layer<HttpClient.HttpClient | KitDecoder> {
  const stub: typeof globalThis.fetch = (input) => {
    options.asked?.push(String(input))
    if (options.refuseFetch !== undefined) {
      return Promise.reject(new Error(options.refuseFetch))
    }
    return Promise.resolve(
      new Response(options.body ?? new ArrayBuffer(8), { status: options.status ?? 200 }),
    )
  }

  return Layer.mergeAll(
    Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, stub)),
    Layer.succeed(
      KitDecoder,
      KitDecoder.of({
        decode: (url) =>
          options.refuseDecode === undefined
            ? Effect.succeed(decoded([new Float32Array([0.5, -0.5])]))
            : Effect.fail(new KitUndecodable({ url, message: options.refuseDecode })),
      }),
    ),
  )
}
