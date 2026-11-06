declare const writer: unique symbol

/**
 * Who writes to a document, the origin of its transactions: an editor's history takes back its writer's changes and
 * no one else's. Each `newWriter` is another, whatever its name.
 */
export interface Writer {
  readonly [writer]: true
  /** For whoever reads logs and tests. */
  readonly name: string
}

export const newWriter = (name: string): Writer => ({ name }) as Writer
