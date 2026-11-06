/** In 64 KiB pages: `initial` matches the linker's `--initial-memory`, `maximum` is wasm32's 4 GiB. */
export const memoryPages = { initial: 32, maximum: 65536 } as const

/** The engine's memory, shared by the threads that run it. */
export const createEngineMemory = (): WebAssembly.Memory => new WebAssembly.Memory({ ...memoryPages, shared: true })
