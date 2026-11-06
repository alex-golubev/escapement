/** Room for the text, as `PANIC_TEXT_BYTES` in the engine: the build thread checks they agree. */
export const panicTextBytes = 512

/**
 * Takes the text the engine's panic hook kept for this thread, at the address its `engine_panic_text` gave: none until
 * the thread panics, and none once taken, so a later trap that isn't a panic doesn't wear it. Calls nothing, so it
 * works after a trap.
 */
export const panicTextTaker = (memory: WebAssembly.Memory, at: number) => () => {
  // Its length in bytes, then printable ASCII only: the worklet has no `TextDecoder`.
  const length = new Uint32Array(memory.buffer, at, 1)
  const [size] = length
  // A longer one is memory the failure wrote over.
  if (size === 0 || size > panicTextBytes) return undefined
  length[0] = 0
  return String.fromCharCode(...new Uint8Array(memory.buffer, at + length.BYTES_PER_ELEMENT, size))
}

/** In place of a trap, an error with what the panic said, the trap its cause; anything else as it is. */
export const withPanicText = (error: unknown, take: () => string | undefined): unknown => {
  const text = error instanceof WebAssembly.RuntimeError ? take() : undefined
  return text === undefined ? error : new Error(text, { cause: error })
}
