//! WebAssembly exports for the build thread and the worklet. Every `build` pointer must come from [`engine_new`] and
//! every `engine` pointer from [`engine_hand_over`]. Sizes and counts cross as `usize`: on wasm32 it is the same 32-bit
//! word as `u32`.
#![expect(
    clippy::missing_safety_doc,
    reason = "one contract for every export, in the crate's doc"
)]

mod audio_thread;
mod panic_text;

use std::ptr;

use engine_core::{
    BLOCK_FRAMES, Builder, CHANNELS, DEFAULT_TEMPO, EVENT_CAPACITY, Engine, HIGHEST_KEY, Hash,
    INPUT_CAPACITY, MAX_MESSAGE, MAX_TEMPO, MAX_VELOCITY, METERS, MIN_TEMPO, MIN_VELOCITY,
    Rejection, SCHEMA_FINGERPRINT, STRIP, TELEMETRY_WORDS, TICKS_PER_QUARTER, Telemetry,
};
use engine_plugins::catalog::CATALOG;
use engine_plugins::{SampleRate, fingerprint};

// Native builds (`cargo test`) have no WebAssembly features.
#[cfg(all(target_arch = "wasm32", not(target_feature = "simd128")))]
compile_error!("engine-wasm must be built with the simd128 target feature");

#[cfg(target_family = "wasm")]
const _: () = assert!(
    usize::BITS == 32,
    "the page reads every size as a 32-bit word"
);

/// What the build thread holds.
pub struct BuildThread {
    builder: Builder,
    /// Until handed over.
    engine: Option<Box<Engine>>,
    /// The page's batch, copied in by the build thread.
    batch: Vec<u8>,
    /// The name of the next sound to store, written by the build thread.
    hash: Hash,
}

/// On the build thread, at the audio context's rate as JavaScript has it.
#[unsafe(no_mangle)]
pub extern "C" fn engine_new(sample_rate: f64) -> *mut BuildThread {
    panic_text::install();
    let sample_rate =
        SampleRate::from_hz(sample_rate).expect("a whole sample rate the engine plays at");
    let (builder, engine) = engine_core::new(sample_rate);
    Box::into_raw(Box::new(BuildThread {
        builder,
        engine: Some(Box::new(engine)),
        batch: Vec::new(),
        hash: [0; 32],
    }))
}

/// Once: the audio thread's part, which the build thread never touches again; null after.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_hand_over(build: *mut BuildThread) -> *mut Engine {
    let engine = unsafe { (*build).engine.take() };
    engine.map_or(ptr::null_mut(), Box::into_raw)
}

/// Room for a batch of `len` bytes, valid until the next call; the build thread copies the whole batch there.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_batch_bytes(build: *mut BuildThread, len: usize) -> *mut u8 {
    let batch = unsafe { &mut (*build).batch };
    // Zeroes only what it adds: the copy overwrites every byte.
    batch.resize(len, 0);
    batch.as_mut_ptr()
}

/// Makes a parcel of the batch in its room and sends it to the audio thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_build(build: *mut BuildThread, batch: u32) {
    let BuildThread {
        builder,
        batch: bytes,
        ..
    } = unsafe { &mut *build };
    builder.build(batch, bytes);
}

/// Room for the SHA-256 of the next sound to store or evict; the build thread writes it there before
/// [`engine_sample_begin`] or [`engine_sample_evict`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_hash(build: *mut BuildThread) -> *mut u8 {
    unsafe { (*build).hash.as_mut_ptr() }
}

/// Starts storing a sound of `channels` × `frames` numbers under the hash in its room. Returns how many numbers to
/// copy, part by part, through [`engine_sample_place`], 0 once the sound is in; or, below 0, why it was refused: the
/// `Rejection` is −1 − the answer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_begin(
    build: *mut BuildThread,
    sample_rate: f64,
    channels: usize,
    frames: usize,
) -> i32 {
    let build = unsafe { &mut *build };
    let hash = build.hash;
    answer(
        build
            .builder
            .samples()
            .begin(hash, sample_rate, channels, frames),
    )
}

/// Room for the next `count` numbers of the sound; valid until the next call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_place(build: *mut BuildThread, count: usize) -> *mut f32 {
    unsafe { (*build).builder.samples().place(count) }
        .as_mut_ptr()
        .cast()
}

/// The build thread wrote the `count` numbers it got the place for. Answers as [`engine_sample_begin`] does.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_copied(build: *mut BuildThread, count: usize) -> i32 {
    answer(unsafe { (*build).builder.samples().copied(count) })
}

/// The page no longer keeps the sound under the hash in its room: it is freed once no node refers to it. Never while a
/// sound is coming in.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_evict(build: *mut BuildThread) {
    let build = unsafe { &mut *build };
    let hash = build.hash;
    build.builder.samples().evict(&hash);
}

/// The engine's memory holds less than 2³¹ numbers, so a count fits.
fn answer(left: Result<usize, Rejection>) -> i32 {
    match left {
        Ok(left) => i32::try_from(left).expect("a count below 2³¹"),
        Err(reason) => -1 - i32::from(reason.0),
    }
}

/// Frees the parcels that came back; returns how many aren't back yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_collect(build: *mut BuildThread) -> usize {
    unsafe { (*build).builder.collect() }
}

/// Must match the page's.
#[unsafe(no_mangle)]
pub extern "C" fn engine_schema_fingerprint() -> u32 {
    SCHEMA_FINGERPRINT
}

/// Of every plugin description and the strip's; must match the page's copy.
#[unsafe(no_mangle)]
pub extern "C" fn engine_plugins_fingerprint() -> u32 {
    fingerprint(CATALOG, STRIP)
}

/// The render quantum must match.
#[unsafe(no_mangle)]
pub extern "C" fn engine_block_frames() -> usize {
    BLOCK_FRAMES
}

/// Output channels; the worklet's must match.
#[unsafe(no_mangle)]
pub extern "C" fn engine_channels() -> usize {
    CHANNELS
}

/// Size prefix included.
#[unsafe(no_mangle)]
pub extern "C" fn engine_max_message() -> usize {
    MAX_MESSAGE
}

/// The page's pattern notes and loops are in these.
#[unsafe(no_mangle)]
pub extern "C" fn engine_ticks_per_quarter() -> u32 {
    TICKS_PER_QUARTER
}

/// The page's tempo control must not go past what the engine plays.
#[unsafe(no_mangle)]
pub extern "C" fn engine_min_tempo() -> u32 {
    MIN_TEMPO
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_max_tempo() -> u32 {
    MAX_TEMPO
}

/// What a new engine plays at until the page sends a tempo.
#[unsafe(no_mangle)]
pub extern "C" fn engine_default_tempo() -> u32 {
    DEFAULT_TEMPO
}

/// The page's notes must not go past what the engine plays.
#[unsafe(no_mangle)]
pub extern "C" fn engine_highest_key() -> u32 {
    u32::from(HIGHEST_KEY)
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_min_velocity() -> f32 {
    MIN_VELOCITY
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_max_velocity() -> f32 {
    MAX_VELOCITY
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_input_capacity() -> usize {
    INPUT_CAPACITY
}

/// Never moves.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_input(engine: *mut Engine) -> *mut u8 {
    unsafe { (*engine).input().as_mut_ptr() }
}

/// New bytes go right after these.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_input_len(engine: *mut Engine) -> usize {
    unsafe { (*engine).input().len() }
}

/// Counts `received` new input bytes and runs a block; see [`Engine::audio_block`]. Returns the size of the events
/// that fit into `event_room`; they lie at [`engine_events`] until the next call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_process(
    engine: *mut Engine,
    frames: usize,
    received: usize,
    event_room: usize,
) -> usize {
    let engine = unsafe { &mut *engine };
    engine.input().received(received);
    engine.audio_block(frames, event_room)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_output(engine: *const Engine, channel: usize) -> *const f32 {
    unsafe { (*engine).output(channel).as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_event_capacity() -> usize {
    EVENT_CAPACITY
}

/// Never moves.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_events(engine: *const Engine) -> *const u8 {
    unsafe { (*engine).events().as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_telemetry_words() -> usize {
    TELEMETRY_WORDS
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_meters() -> usize {
    METERS
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_panic_text_bytes() -> usize {
    panic_text::PANIC_TEXT_BYTES
}

/// Never moves; updated every block.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_telemetry(engine: *const Engine) -> *const Telemetry {
    unsafe { (*engine).telemetry() }
}
