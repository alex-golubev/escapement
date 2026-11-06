// Ring messages: a little-endian u32 size of the rest, a one-byte kind, then that kind's record. Mirrors `framing.rs`.

export const sizePrefixBytes = 4
const kindBytes = 1

export const encodeMessage = (kind: number, record: Uint8Array): Uint8Array => {
  const message = new Uint8Array(sizePrefixBytes + kindBytes + record.length)
  new DataView(message.buffer).setUint32(0, kindBytes + record.length, true)
  message[sizePrefixBytes] = kind
  message.set(record, sizePrefixBytes + kindBytes)
  return message
}

/** One whole message; anything else is a bug and throws. */
export const decodeMessage = (message: Uint8Array): { readonly kind: number; readonly record: Uint8Array } => {
  if (message.length < sizePrefixBytes + kindBytes) {
    throw new Error(`A message of ${message.length} bytes is shorter than a size prefix and a kind`)
  }
  const size = sizePrefixBytes + new DataView(message.buffer, message.byteOffset).getUint32(0, true)
  if (size !== message.length) {
    throw new Error(`A message of ${message.length} bytes, while its size prefix says ${size}`)
  }
  return { kind: message[sizePrefixBytes], record: message.subarray(sizePrefixBytes + kindBytes) }
}
