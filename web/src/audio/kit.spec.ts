// Fetching and reshaping a kit, against a source that is not a browser.
//
// Neither `fetch` nor `decodeAudioData` exists under Node, which is why both
// arrive as parameters — and why every failure below is one a test can cause on
// demand rather than one nobody has ever seen.

import { describe, expect, it } from 'vitest'

import { KIT_NAMES, KIT_URLS, describeKitFailure, fetchKit, interleave } from './kit'
import { TRACKS } from './protocol'
import type { DecodedSample, KitFailure, KitSource } from './kit'
import { unwrapError, unwrapValue } from '../../tests/support/unwrap'

describe('interleave', () => {
  it('lays a stereo sample out a frame at a time', () => {
    // The arena is interleaved and an `AudioBuffer` is not, so this pass is the
    // only place the two layouts meet. Written channel-first, the stereo image
    // comes out as the left channel followed by the right — which the engine
    // reads as one sample of nonsense rather than as a mistake.
    const sample = interleave(decoded([new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])]))

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
  it('fetches the kit in the order the tracks are in', async () => {
    const asked: string[] = []
    const samples = unwrapValue(await fetchKit(source({ asked }), ['/one.wav', '/two.wav']))

    expect(asked).toEqual(['/one.wav', '/two.wav'])
    expect(samples).toHaveLength(2)
  })

  it('names the file the server would not give it', async () => {
    const error = unwrapError(
      await fetchKit(source({ status: 404 }), ['/kit/kick.wav', '/kit/snare.wav']),
    )

    expect(error).toEqual({
      kind: 'unreachable',
      url: '/kit/kick.wav',
      detail: 'the server answered 404',
    })
  })

  it('names the file the network never reached', async () => {
    const error = unwrapError(await fetchKit(source({ throwOnFetch: 'offline' }), ['/kit/kick.wav']))

    expect(error.kind).toBe('unreachable')
  })

  it('names the file the browser would not decode', async () => {
    const error = unwrapError(
      await fetchKit(source({ throwOnDecode: 'Unable to decode audio data' }), ['/kit/rim.wav']),
    )

    expect(error).toEqual({
      kind: 'undecodable',
      url: '/kit/rim.wav',
      message: 'Unable to decode audio data',
    })
  })

  it('stops at the first file that fails rather than fetching the rest', async () => {
    // All of it or none: the engine replaces its arena on every load, so seven
    // samples out of eight is a different instrument rather than a partial one.
    const asked: string[] = []
    unwrapError(await fetchKit(source({ asked, status: 500 }), ['/one.wav', '/two.wav']))

    expect(asked).toEqual(['/one.wav'])
  })

  it('loads the kit this page actually ships, one sample to a track', async () => {
    // The list is what assigns a sound to a row, so its length is the number of
    // tracks: short, it leaves a row that strikes nothing and that the grid
    // labels `undefined`. The order below says nothing about that — it holds for
    // a list of any length — so the length is asserted on its own, against the
    // engine's own count rather than against eight written out here.
    const asked: string[] = []
    unwrapValue(await fetchKit(source({ asked })))

    expect(asked).toEqual([...KIT_URLS])
    expect(KIT_URLS).toHaveLength(TRACKS)
    expect(KIT_NAMES).toHaveLength(TRACKS)
  })
})

describe('describeKitFailure', () => {
  it('has a distinct, non-empty message for every failure that exists', () => {
    const samples: Record<KitFailure['kind'], KitFailure> = {
      unreachable: { kind: 'unreachable', url: '/kit/kick.wav', detail: 'the server answered 404' },
      undecodable: { kind: 'undecodable', url: '/kit/kick.wav', message: 'DOMException' },
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
      { kind: 'unreachable', url: '/kit/kick.wav', detail: thrown },
      { kind: 'undecodable', url: '/kit/kick.wav', message: thrown },
    ] as const) {
      expect(describeKitFailure(failure).endsWith(thrown), failure.kind).toBe(true)
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

interface SourceOptions {
  readonly asked?: string[]
  readonly status?: number
  readonly throwOnFetch?: string
  readonly throwOnDecode?: string
}

function source(options: SourceOptions = {}): KitSource {
  return {
    fetch: (url) => {
      options.asked?.push(url)
      if (options.throwOnFetch !== undefined) throw new Error(options.throwOnFetch)
      const status = options.status ?? 200
      return Promise.resolve({
        ok: status < 400,
        status,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      })
    },
    decode: () => {
      if (options.throwOnDecode !== undefined) throw new Error(options.throwOnDecode)
      return Promise.resolve(decoded([new Float32Array([0.5, -0.5])]))
    },
  }
}
