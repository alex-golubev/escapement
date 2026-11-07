import type { SoundLibrary, SoundStatus } from '@escapement/compiler'
import { type SamplePcm, SampleUnavailable } from '@escapement/engine'
import { Sha256 } from '@escapement/engine-description'
import { Context, Data, Effect, Match, Option } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpClient, HttpClientResponse } from 'effect/http'
// Built in, so TypeScript knows its fields: a field renamed by `pnpm samples` breaks this page's build.
import manifest from '../../../../samples/manifest.json'

// Vite finds every sample and gives each its URL, by its path from here.
const found = import.meta.glob<string>('../../../../samples/*.wav', { query: '?url', import: 'default', eager: true })

/** Each sample's URL, by its file's name: its path from here is written only in the glob, which a test checks. */
export const sampleUrls: ReadonlyMap<string, string> = new Map(
  Object.entries(found).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url])
)

/** A file from the manifest, decoded. */
export interface Decoded {
  readonly seconds: number
  /** Of the bytes the page got. */
  readonly sha256: string
}

/** How far the page got with a sample on its way into the engine. */
export type LoadStatus = Data.TaggedEnum<{
  NotLoaded: {}
  Loading: {}
  /** Loaded and checked, and on its way into the engine. */
  Storing: { readonly decoded?: Decoded }
}>

export const LoadStatus = Data.taggedEnum<LoadStatus>()

/** Where a sample has got to: the page's own steps, then what became of it. */
export type SampleStatus = LoadStatus | SoundStatus

export const statusText = Match.type<SampleStatus>().pipe(
  Match.tagsExhaustive({
    NotLoaded: () => 'not in the engine',
    Loading: () => 'loading…',
    Storing: () => 'storing in the engine…',
    Stored: () => 'in the engine ✓',
    Refused: ({ reason }) => `not stored: ${reason}`,
    Unavailable: ({ message }) => `✗ ${message}`,
    Missing: () => 'no such sound',
    Evicted: () => 'evicted'
  })
)

/** Whether a sound with this status won't get into the engine without another try. */
export const isLost = Match.type<SampleStatus>().pipe(
  Match.tagsExhaustive({
    NotLoaded: () => false,
    Loading: () => false,
    Storing: () => false,
    Stored: () => false,
    Refused: () => true,
    Unavailable: () => true,
    Missing: () => true,
    Evicted: () => true
  })
)

/** Shows a sample's status by its name. */
export type ShowSample = (name: string, status: SampleStatus) => Effect.Effect<void>

/** A sound the page can store: its name, and its load, which shows how far it got. */
export interface PageSample {
  readonly name: string
  readonly hash: Sha256
  readonly load: Effect.Effect<SamplePcm, SampleUnavailable>
}

/** What loading a sample takes from the page: the network, and a hash. */
export type SampleLoading = HttpClient.HttpClient | Digest.Digest

/** Those two alone, taken where the loads are made. */
export const sampleLoading = Effect.map(
  Effect.context<SampleLoading>(),
  Context.pick(HttpClient.HttpClient, Digest.Digest)
)

/** What a client's error says went wrong underneath, if anything. */
const causeOf = (reason: object) =>
  Option.flatMap(
    Option.liftPredicate(reason, (reason) => 'cause' in reason),
    ({ cause }) => Option.fromNullishOr(cause)
  )

/** A step that fails as the sample's error rather than stopping the page. */
const couldNot = (what: string) => (cause: unknown) =>
  new SampleUnavailable({ message: `could not ${what}: ${String(cause)}` })

/** The start of a hash: enough to tell samples apart. */
export const shortHash = (sha256: string) => `${sha256.slice(0, 12)}…`

/** The decoded channels themselves, handed over without a copy: the buffer is empty after. */
const pcmOf = (audio: AudioBuffer): SamplePcm => ({
  sampleRate: audio.sampleRate,
  channels: Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel))
})

type ManifestEntry = (typeof manifest.samples)[number]

/** Fetched, checked against the manifest and decoded at the context's rate, anew each time. */
const manifestLoad = (context: BaseAudioContext, show: ShowSample, { name, file, sha256: expected }: ManifestEntry) =>
  Effect.gen(function* () {
    yield* show(name, LoadStatus.Loading())
    const url = yield* Effect.fromOption(
      Option.fromNullishOr(sampleUrls.get(file)),
      () => new SampleUnavailable({ message: `${file} is not in samples/` })
    )
    const bytes = yield* HttpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      // The browser's own words are under the client's.
      Effect.mapError((error) => couldNot(`load ${file}`)([error, ...Option.toArray(causeOf(error.reason))].join(': ')))
    )
    const digest = yield* Digest.Digest
    // A sound is known by its hash: under another file it would be another sound.
    const sha256 = yield* digest.digestHex(Digest.sha256, new Uint8Array(bytes)).pipe(
      // A browser that won't hash fails the sound, not the page.
      Effect.catchDefect((cause) => Effect.fail(couldNot(`hash ${file}`)(cause))),
      Effect.filterOrFail(
        (sha256) => sha256 === expected,
        (sha256) =>
          new SampleUnavailable({ message: `${file} is ${shortHash(sha256)}, the manifest has ${shortHash(expected)}` })
      )
    )
    // Decoding takes the bytes over, so it comes after the hash.
    const audio = yield* Effect.tryPromise({
      try: () => context.decodeAudioData(bytes),
      catch: couldNot(`decode ${file}`)
    })
    yield* show(name, LoadStatus.Storing({ decoded: { seconds: audio.duration, sha256 } }))
    return pcmOf(audio)
  })

/** Each sample of the manifest and the hash the engine knows it by. */
export const manifestSamples = manifest.samples.map(({ name, sha256 }) => ({ name, hash: Sha256(sha256) }))

/** The manifest's samples by their hashes, each loaded by the context. */
export const manifestLoads = (
  context: BaseAudioContext,
  show: ShowSample,
  loading: Context.Context<SampleLoading>
): ReadonlyMap<Sha256, PageSample> =>
  new Map(
    manifest.samples.map((entry) => {
      const hash = Sha256(entry.sha256)
      return [hash, { name: entry.name, hash, load: Effect.provide(manifestLoad(context, show, entry), loading) }]
    })
  )

/** A sound the engine must refuse: a number in it isn't one. Made anew by each load, since it goes over. */
export const badSample = (name: string, sampleRate: number, show: ShowSample): PageSample => ({
  name,
  hash: Sha256('ba'.repeat(32)),
  load: show(name, LoadStatus.Loading()).pipe(
    Effect.andThen(show(name, LoadStatus.Storing({}))),
    Effect.andThen(Effect.sync(() => ({ sampleRate, channels: [Float32Array.of(0, Number.NaN, 0)] })))
  )
})

/** The manifest's samples as the compiler takes them; one it doesn't have shows under its hash. */
export const manifestLibrary = (
  context: BaseAudioContext,
  show: ShowSample,
  loading: Context.Context<SampleLoading>
): SoundLibrary => {
  const samples = manifestLoads(context, show, loading)
  const sample = (hash: Sha256) => Option.fromUndefinedOr(samples.get(hash))
  return {
    load: (hash) => Option.map(sample(hash), ({ load }) => load),
    show: (hash, status) =>
      show(Option.match(sample(hash), { onNone: () => shortHash(hash), onSome: ({ name }) => name }), status)
  }
}

/** What the page shows of a sample: the last status given, and what came with the ones before. */
export interface SampleLine {
  readonly name: string
  /** The manifest's, until the file is checked. */
  readonly hash?: Sha256
  readonly decoded?: Decoded
  /** Each load shows Loading once, whether it finishes or its eviction stops it. */
  readonly loads: number
  readonly status: SampleStatus
}

/** The manifest's samples in its order, none in the engine yet. */
export const manifestLines: ReadonlyArray<SampleLine> = manifestSamples.map(({ name, hash }) => ({
  name,
  hash,
  loads: 0,
  status: LoadStatus.NotLoaded()
}))

/** The lines with the sample's new status: one not among them comes last. */
export const withStatus = (
  lines: ReadonlyArray<SampleLine>,
  name: string,
  status: SampleStatus
): ReadonlyArray<SampleLine> => {
  const at = Option.liftPredicate(
    lines.findIndex((line) => line.name === name),
    (at) => at >= 0
  )
  const line = Option.match(at, { onNone: (): SampleLine => ({ name, loads: 0, status }), onSome: (at) => lines[at] })
  const next: SampleLine = {
    ...line,
    status,
    ...Match.value(status).pipe(
      Match.tag('Loading', () => ({ loads: line.loads + 1 })),
      Match.tag('Storing', ({ decoded }) => ({ decoded: decoded ?? line.decoded })),
      Match.orElse(() => ({}))
    )
  }
  return Option.match(at, { onNone: () => [...lines, next], onSome: (at) => lines.with(at, next) })
}
