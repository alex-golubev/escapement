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

    // memory.buffer is a SharedArrayBuffer — this is the memory the rings live
    // in (§3). Viewed once; per-quantum would allocate on the RT thread.
    const ptr = this.wasm.escapement_output_ptr();
    const len = this.wasm.escapement_output_len();
    this.out = new Float32Array(this.wasm.memory.buffer, ptr, len);

    // The handshake (§3). One message, at startup: the ban on postMessage is
    // about frame rate, not about this. Sent after escapement_init, which is
    // what writes the header `region` points at.
    //
    // Three fields and no diagnostics. Whether the memory is really shared and
    // how large it is are questions about the build, and the build answers them
    // on every run — tools/check-shared-memory.py, before this file is copied
    // anywhere.
    this.port.postMessage({
      buffer: this.wasm.memory.buffer,
      region: this.wasm.escapement_region_ptr(),
      quantum: len,
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
