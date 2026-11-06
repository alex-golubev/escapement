import * as Wire from './schema/engine'

/** Why the engine refused a command, an edit or a sound. */
export type Rejection = keyof typeof Wire.Rejection

/** The build thread checks the schema at start, so a code it doesn't know is a bug. */
export const rejectionOf = (code: Wire.Rejection): Rejection => {
  const name = Wire.Rejection[code] as Rejection | undefined
  if (name === undefined) throw new Error(`Unknown rejection reason ${code} from the engine`)
  return name
}
