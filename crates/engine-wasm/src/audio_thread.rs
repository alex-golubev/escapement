//! The audio thread's stack and thread-local data. The linker reserves them only for the first thread, the build
//! thread; the audio thread may not take them from the heap, so they are reserved here.

/// Going past it traps: `wasm-opt --stack-check` checks every move of the stack pointer against the thread's bounds.
const STACK_BYTES: usize = 256 * 1024;
/// More than the module has; the worklet refuses to start otherwise.
const TLS_BYTES: usize = 1024;

/// WebAssembly stacks are 16-byte aligned, and so is anything thread-local.
#[repr(C, align(16))]
struct Reserved<const N: usize>([u8; N]);

static mut STACK: Reserved<STACK_BYTES> = Reserved([0; STACK_BYTES]);
static mut TLS: Reserved<TLS_BYTES> = Reserved([0; TLS_BYTES]);

/// Read by the worklet before its first call into the engine: a call before it takes its stack would run on the
/// build thread's.
#[repr(C)]
pub(crate) struct AudioThread {
    stack_top: *mut u8,
    stack_bottom: *mut u8,
    tls: *mut u8,
    tls_capacity: usize,
}

// Safety: the fields never change; only the audio thread uses the memory they point to.
unsafe impl Sync for AudioThread {}

/// Exported as a global holding its address.
#[unsafe(no_mangle)]
pub(crate) static ENGINE_AUDIO_THREAD: AudioThread = AudioThread {
    // Safety: one past the end of the stack, where it starts growing down.
    stack_top: unsafe { (&raw mut STACK).cast::<u8>().add(STACK_BYTES) },
    stack_bottom: (&raw mut STACK).cast(),
    tls: (&raw mut TLS).cast(),
    tls_capacity: TLS_BYTES,
};
