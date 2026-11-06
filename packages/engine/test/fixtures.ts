import { Array, pipe } from 'effect'

// Fixtures pin the bytes crossing the seam. Rewrite them with `pnpm --filter @escapement/engine test -u`.

/** For `toMatchFileSnapshot` in this directory. */
export const fixturePath = (name: string) => `../../../schema/fixtures/${name}`

/** 16 bytes per line in groups of 4. */
const hexDump = (bytes: Uint8Array): string =>
  pipe(
    Array.fromIterable(bytes),
    Array.map((byte) => byte.toString(16).padStart(2, '0')),
    Array.chunksOf(4),
    Array.map(Array.join('')),
    Array.chunksOf(4),
    Array.map(Array.join(' ')),
    Array.join('\n')
  )

/** A `#` line naming the message, then its bytes. */
export const fixtureEntry = ({ _tag, ...fields }: { readonly _tag: string }, bytes: Uint8Array) =>
  `# ${_tag} ${JSON.stringify(fields)}\n${hexDump(bytes)}\n`
