import type { Sha256 } from '@escapement/engine-description'

/** The 32 bytes the hex spells. */
export const sha256Bytes = (hash: Sha256): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16))
