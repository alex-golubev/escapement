import type { MessageWriter } from './command-ring'
import { Command, encodeCommand } from './commands'
import { type DeviceEdit, encodeBatch } from './device-edits'
import type { Batch } from './protocol'

/** The marker is the writer's. */
export type LiveCommand = Exclude<Command, { readonly _tag: 'AfterBatch' }>

/** What changes together: device edits go to the build thread as one batch, live edits into the ring behind it. */
export interface Transaction {
  readonly edits?: ReadonlyArray<DeviceEdit>
  readonly commands?: ReadonlyArray<LiveCommand>
}

/** False if the command ring has no room for the transaction; then nothing is sent. */
export type Send = (transaction: Transaction) => boolean

/** The batch to send the build thread, if any; false if nothing was written. */
export type Written = { readonly batch?: Batch } | false

/**
 * Writes a transaction's ring part in one go or not at all: with device edits, the batch's marker and then the live
 * edits, so the batch keeps its place among them. Batches are numbered from 1, a number per batch written.
 */
export const transactionWriter = (write: MessageWriter) => {
  const next = { number: 1 }
  return ({ edits = [], commands = [] }: Transaction): Written => {
    const live = commands.map(encodeCommand)
    if (edits.length === 0) return write(live) ? {} : false
    const number = next.number
    // Before the marker: a marker without its batch would hold the ring forever.
    const bytes = encodeBatch(edits)
    if (!write([encodeCommand(Command.AfterBatch({ batch: number })), ...live])) return false
    next.number = number + 1
    return { batch: { _tag: 'Batch', number, bytes } }
  }
}

export type TransactionWriter = ReturnType<typeof transactionWriter>

/** The ring part first, then the batch to `deliver`; the page and the tests send the same way. */
export const transactionSender =
  (write: TransactionWriter, deliver: (batch: Batch) => void): Send =>
  (transaction) => {
    const written = write(transaction)
    if (written === false) return false
    if (written.batch !== undefined) deliver(written.batch)
    return true
  }

/** In the ring before the first block; its batch goes in the build thread's start. Throws if there's no room. */
export const writeInitial = (write: TransactionWriter, initial: Transaction): Batch | undefined => {
  const written = write(initial)
  if (written === false) throw new RangeError('The initial state does not fit into the command ring')
  return written.batch
}
