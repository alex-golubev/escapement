import { Effect } from 'effect'
import { Digest } from 'effect/crypto'

/** Lowercase hex. */
export const sha256Hex = (bytes: Uint8Array) => Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, bytes))

/** First 32 bits of the schema's SHA-256; CRLF line endings give the same value. */
export const fingerprintOf = (schema: string) =>
  sha256Hex(new TextEncoder().encode(schema.replaceAll('\r\n', '\n'))).pipe(
    Effect.map((hex) => Number.parseInt(hex.slice(0, 8), 16))
  )
