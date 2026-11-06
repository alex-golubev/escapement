import { Brand } from 'effect'

/** A sound's name: the SHA-256 of its file, in lowercase hex. */
export type Sha256 = Brand.Branded<string, 'Sha256'>

/** Throws on anything else. */
export const Sha256 = Brand.make<Sha256>((hex) => /^[0-9a-f]{64}$/.test(hex) || `not a SHA-256 in hex: ${hex}`)
