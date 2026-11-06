import { RingBuffer } from 'ringbuf.js'
import { expect, test } from 'vitest'
import { createCommandRing, messageWriter } from '../src/command-ring'
import { encodeCommand } from '../src/commands'
import { maxMessageBytes } from '../src/protocol'
import { setVolume } from './harness'

const readAll = (storage: SharedArrayBuffer) => {
  const ring = new RingBuffer(storage, Uint8Array)
  const bytes = new Uint8Array(ring.availableRead())
  ring.pop(bytes)
  return bytes
}

const volumeMessage = (value: number) => encodeCommand(setVolume(value))

test('messages arrive one after another', () => {
  const storage = createCommandRing()
  const messages = [volumeMessage(0.5), volumeMessage(0.25)]
  expect(messageWriter(storage)(messages)).toBe(true)
  expect(readAll(storage)).toEqual(new Uint8Array(Buffer.concat(messages)))
})

test('messages that do not fit are not written at all', () => {
  const storage = createCommandRing(2 * volumeMessage(0.1).length)
  const write = messageWriter(storage)
  expect(write([volumeMessage(0.1)])).toBe(true)
  expect(write([volumeMessage(0.2), volumeMessage(0.3)])).toBe(false)
  expect(readAll(storage)).toEqual(volumeMessage(0.1))
})

test('a message over the size limit is a bug: it throws and nothing is written', () => {
  const storage = createCommandRing()
  const write = messageWriter(storage)
  expect(() => write([new Uint8Array(4), new Uint8Array(maxMessageBytes + 1)])).toThrow(RangeError)
  expect(readAll(storage).length).toBe(0)
  expect(write([new Uint8Array(maxMessageBytes)])).toBe(true)
})
