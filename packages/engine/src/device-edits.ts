import type { MidiKey, Sha256, Tick } from '@escapement/engine-description'
import { Data } from 'effect'
import { Builder } from 'flatbuffers'
import type { NodeHandle, PatternHandle } from './handles'
import { sha256Bytes } from './hash-bytes'
import * as Wire from './schema/engine'

type SchemaEdit = Exclude<keyof typeof Wire.DeviceEdit, 'NONE'>

/** Set before the node's first block; the rest start at their defaults. */
type InitialValues = ReadonlyArray<{ readonly param: number; readonly value: number }>

interface EditFields {
  /** Starts a new session: every node, pattern and clip is removed. */
  readonly Reset: { readonly epoch: number }
  readonly CreateNode: {
    readonly node: NodeHandle
    readonly plugin: number
    readonly version: number
    readonly params: InitialValues
    /** A sound the engine doesn't have yet is silent until it is stored; samples left out have none. */
    readonly samples: ReadonlyArray<{ readonly sample: number; readonly hash: Sha256 }>
    /** Numbered by their place in `strip`. */
    readonly strip: InitialValues
  }
  readonly SetOutput: { readonly node: NodeHandle }
  /** `to` hears `from`. */
  readonly Connect: { readonly from: NodeHandle; readonly to: NodeHandle }
  /** The node and its connections fade out; its cell is free at once. */
  readonly DestroyNode: { readonly node: NodeHandle }
  /** A node of the engine's core that passes on the sum it hears; metered, the telemetry names its meter by handle. */
  readonly CreateInsert: {
    readonly node: NodeHandle
    readonly strip: InitialValues
    readonly metered: boolean
  }
  /** `to` stops hearing `from`: the connection fades out. */
  readonly Disconnect: { readonly from: NodeHandle; readonly to: NodeHandle }
  /**
   * Every note of the pattern the node holds is let go of, at the start of the block the batch comes in: once the node
   * is no longer heard, a note held on would come back if it were heard again before its end.
   */
  readonly LetGoOfNotes: { readonly node: NodeHandle }
  /** The build thread panics, as `PanicAudio` does the audio thread. */
  readonly PanicBuild: { readonly code: number }
  /** The build thread loops for ever, as `HangAudio` does the audio thread. */
  readonly HangBuild: { readonly code: number }
  /**
   * The pattern under the handle, made or in place of the one before; only clips play it. Its notes in any order; after
   * every batch they must name only live nodes. A note is let go of once its length has played, or its clip's or the
   * loop's end comes, whatever the pattern by then; stopping lets go of every note at once.
   */
  readonly SetPattern: {
    readonly pattern: PatternHandle
    readonly notes: ReadonlyArray<{
      /** From the pattern's start; past its clip's length, never heard. */
      readonly tick: Tick
      readonly node: NodeHandle
      readonly key: MidiKey
      /** From 0 to 1. */
      readonly velocity: number
      /** Ticks, from 1. */
      readonly length: number
    }>
  }
  /** The pattern is gone, and its cell free at once; a note it pressed plays to its end. */
  readonly DestroyPattern: { readonly pattern: PatternHandle }
  /**
   * What the transport plays, in place of the clips before: each a pattern from a tick of the loop, for its length,
   * round and round its period from its offset. In any order, overlapping or not; after every batch they must name only
   * live patterns.
   */
  readonly SetClips: {
    readonly clips: ReadonlyArray<{
      readonly tick: Tick
      /** Ticks, from 1. */
      readonly length: number
      /** Ticks, from 1: the pattern starts again every so many ticks of the clip, its notes from then on unheard. */
      readonly period: number
      /** Ticks into a round of its pattern it starts at, taken round its period. */
      readonly offset: number
      readonly pattern: PatternHandle
    }>
  }
}

/** Edits come from the schema: one added there doesn't compile until it has fields here. */
export type DeviceEdit = Data.TaggedEnum<Pick<EditFields, SchemaEdit>>

export const DeviceEdit = Data.taggedEnum<DeviceEdit>()

/** `start` is the generated start of the vector; the builder fills its buffer from the end. */
const writeValues = (
  builder: Builder,
  values: InitialValues,
  start: (builder: Builder, length: number) => void
): number => {
  start(builder, values.length)
  values.toReversed().forEach(({ param, value }) => Wire.ParamValue.createParamValue(builder, param, value))
  return builder.endVector()
}

const writeEdit = (builder: Builder, edit: DeviceEdit): number =>
  DeviceEdit.$match(edit, {
    Reset: ({ epoch }) => Wire.Reset.createReset(builder, epoch),
    CreateNode: ({ node, plugin, version, params, samples, strip }) => {
      const paramsVector = writeValues(builder, params, Wire.CreateNode.startParamsVector)
      const stripVector = writeValues(builder, strip, Wire.CreateNode.startStripVector)
      Wire.CreateNode.startSamplesVector(builder, samples.length)
      samples
        .toReversed()
        .forEach(({ sample, hash }) =>
          Wire.SampleSound.createSampleSound(builder, sample, Array.from(sha256Bytes(hash)))
        )
      const samplesVector = builder.endVector()
      return Wire.CreateNode.createCreateNode(builder, node, plugin, version, paramsVector, samplesVector, stripVector)
    },
    SetOutput: ({ node }) => Wire.SetOutput.createSetOutput(builder, node),
    Connect: ({ from, to }) => Wire.Connect.createConnect(builder, from, to),
    DestroyNode: ({ node }) => Wire.DestroyNode.createDestroyNode(builder, node),
    CreateInsert: ({ node, strip, metered }) =>
      Wire.CreateInsert.createCreateInsert(
        builder,
        node,
        writeValues(builder, strip, Wire.CreateInsert.startStripVector),
        metered
      ),
    Disconnect: ({ from, to }) => Wire.Disconnect.createDisconnect(builder, from, to),
    LetGoOfNotes: ({ node }) => Wire.LetGoOfNotes.createLetGoOfNotes(builder, node),
    PanicBuild: ({ code }) => Wire.PanicBuild.createPanicBuild(builder, code),
    HangBuild: ({ code }) => Wire.HangBuild.createHangBuild(builder, code),
    SetPattern: ({ pattern, notes }) => {
      Wire.SetPattern.startNotesVector(builder, notes.length)
      notes
        .toReversed()
        .forEach(({ tick, node, key, velocity, length }) =>
          Wire.PatternNote.createPatternNote(builder, tick, node, key, velocity, length)
        )
      return Wire.SetPattern.createSetPattern(builder, pattern, builder.endVector())
    },
    DestroyPattern: ({ pattern }) => Wire.DestroyPattern.createDestroyPattern(builder, pattern),
    SetClips: ({ clips }) => {
      Wire.SetClips.startClipsVector(builder, clips.length)
      clips
        .toReversed()
        .forEach(({ tick, length, period, offset, pattern }) =>
          Wire.Clip.createClip(builder, tick, length, period, offset, pattern)
        )
      return Wire.SetClips.createSetClips(builder, builder.endVector())
    }
  })

/** A `DeviceBatch` in a buffer of its own, so it can be transferred. */
export const encodeBatch = (edits: ReadonlyArray<DeviceEdit>): Uint8Array => {
  const builder = new Builder(64)
  const offsets = edits.map((edit) =>
    Wire.Edit.createEdit(builder, Wire.DeviceEdit[edit._tag], writeEdit(builder, edit))
  )
  builder.finish(Wire.DeviceBatch.createDeviceBatch(builder, Wire.DeviceBatch.createEditsVector(builder, offsets)))
  return builder.asUint8Array().slice()
}
