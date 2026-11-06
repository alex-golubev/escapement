import { Data } from 'effect'
import { ByteBuffer } from 'flatbuffers'
import { decodeMessage } from './framing'
import { type Rejection, rejectionOf } from './rejections'
import { CommandRejected, CommandStreamLost, EditRejected, EventKind } from './schema/engine'

type SchemaEvent = keyof typeof EventKind

interface EventFields {
  readonly CommandRejected: { readonly reason: Rejection }
  readonly CommandStreamLost: {}
  /** The build thread refused an edit of the batch. */
  readonly EditRejected: { readonly batch: number; readonly reason: Rejection }
}

/** Events come from the schema: one added there doesn't compile until it has fields and a decoder here. */
export type EngineEvent = Data.TaggedEnum<{
  readonly [K in SchemaEvent]: EventFields[K] & { readonly epoch: number }
}>

export const EngineEvent = Data.taggedEnum<EngineEvent>()

// The build thread checks the schema at start, so bytes that don't decode are a bug.

interface Decoder {
  readonly size: number
  readonly decode: (record: ByteBuffer) => EngineEvent
}

const decoders: { readonly [K in SchemaEvent]: Decoder } = {
  CommandRejected: {
    size: CommandRejected.sizeOf(),
    decode: (record) => {
      const event = new CommandRejected().__init(0, record)
      return EngineEvent.CommandRejected({ epoch: event.epoch(), reason: rejectionOf(event.reason()) })
    }
  },
  CommandStreamLost: {
    size: CommandStreamLost.sizeOf(),
    decode: (record) => EngineEvent.CommandStreamLost({ epoch: new CommandStreamLost().__init(0, record).epoch() })
  },
  EditRejected: {
    size: EditRejected.sizeOf(),
    decode: (record) => {
      const event = new EditRejected().__init(0, record)
      return EngineEvent.EditRejected({
        epoch: event.epoch(),
        batch: event.batch(),
        reason: rejectionOf(event.reason())
      })
    }
  }
}

/** One whole message. */
export const decodeEvent = (message: Uint8Array): EngineEvent => {
  const { kind, record } = decodeMessage(message)
  const name = EventKind[kind] as SchemaEvent | undefined
  // biome-ignore lint/plugin/control-flow: the protocol's decoder, plain JS
  if (name === undefined) throw new Error(`Unknown event kind ${kind} from the engine`)
  const { size, decode } = decoders[name]
  // biome-ignore lint/plugin/control-flow: the protocol's decoder, plain JS
  if (record.length !== size) throw new Error(`A ${name} record of ${record.length} bytes, expected ${size}`)
  return decode(new ByteBuffer(record))
}
