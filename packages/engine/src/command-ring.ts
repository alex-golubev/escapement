import { RingBuffer } from 'ringbuf.js'
import { sizePrefixBytes } from './framing'
import { maxMessageBytes } from './protocol'

/** Room for many full rebuilds. */
const defaultCapacity = 1024 * 1024

export const createCommandRing = (capacity = defaultCapacity): SharedArrayBuffer =>
  RingBuffer.getStorageForCapacity(capacity, Uint8Array)

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((offset, part) => {
    whole.set(part, offset)
    return offset + part.length
  }, 0)
  return whole
}

/** False if the ring has no room for all of them; then nothing is written. */
export type MessageWriter = (messages: ReadonlyArray<Uint8Array>) => boolean

/**
 * Writes messages in one go or not at all: the ring never waits. A message over {@link maxMessageBytes}
 * is a bug and throws. The ring's only writer.
 */
export const messageWriter = (storage: SharedArrayBuffer): MessageWriter => {
  const ring = new RingBuffer(storage, Uint8Array)
  return (messages) => {
    const tooLarge = messages.find((message) => message.length > maxMessageBytes)
    if (tooLarge !== undefined) {
      throw new RangeError(
        `A ${tooLarge.length}-byte message exceeds ${maxMessageBytes} bytes; send it as a device edit`
      )
    }
    const bytes = concat(messages)
    if (ring.availableWrite() < bytes.length) return false
    ring.push(bytes)
    return true
  }
}

/**
 * Writes the size prefix of a message just over {@link maxMessageBytes}, and nothing after: the engine loses the
 * messages' bounds for good. False if the ring has no room.
 */
export const breakStream = (write: MessageWriter): boolean => {
  const prefix = new Uint8Array(sizePrefixBytes)
  new DataView(prefix.buffer).setUint32(0, maxMessageBytes + 1 - sizePrefixBytes, true)
  return write([prefix])
}
