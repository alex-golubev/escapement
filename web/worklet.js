// The one piece of JavaScript the design cannot remove: registering a processor
// is only possible from a script the worklet loads itself. Keep it a shim — it
// moves bytes and never touches a sample.

class EscapementProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Already compiled, not bytes: instantiating a compiled module is
    // synchronous, so process() is ready on its first call rather than after a
    // promise. There is no fetch() in here to compile with (§1).
    const { module } = options.processorOptions;
    this.wasm = new WebAssembly.Instance(module).exports;

    this.wasm.escapement_init(sampleRate);

    // memory.buffer is a SharedArrayBuffer — this is the memory the rings will
    // live in (§3). Viewed once; per-quantum would allocate on the RT thread.
    const ptr = this.wasm.escapement_output_ptr();
    const len = this.wasm.escapement_output_len();
    this.out = new Float32Array(this.wasm.memory.buffer, ptr, len);

    // Confirms the §3 premise from inside the worklet, rather than by assertion.
    this.port.postMessage({
      quantum: len,
      sharedMemory: this.wasm.memory.buffer instanceof SharedArrayBuffer,
      memoryBytes: this.wasm.memory.buffer.byteLength,
    });
  }

  process(_inputs, outputs) {
    this.wasm.escapement_process();
    for (const channel of outputs[0]) {
      channel.set(this.out);
    }
    return true;
  }
}

registerProcessor("escapement", EscapementProcessor);
