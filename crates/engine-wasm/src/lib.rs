//! WebAssembly exports for the build thread and the worklet. Every `build` pointer must come from [`engine_new`] and
//! every `engine` pointer from [`engine_hand_over`].
#![expect(
    clippy::missing_safety_doc,
    reason = "one contract for every export, in the crate's doc"
)]

mod audio_thread;
mod panic_text;

use std::ptr;

use engine_core::build::Builder;
use engine_core::commands::INPUT_CAPACITY;
use engine_core::events::EVENT_CAPACITY;
use engine_core::framing::MAX_MESSAGE;
use engine_core::notes::{HIGHEST_KEY, MAX_VELOCITY, MIN_VELOCITY};
use engine_core::pool::Hash;
use engine_core::schema::{Rejection, SCHEMA_FINGERPRINT};
use engine_core::strip::STRIP;
use engine_core::telemetry::{METERS, TELEMETRY_WORDS, Telemetry};
use engine_core::transport::{DEFAULT_TEMPO, MAX_TEMPO, MIN_TEMPO, TICKS_PER_QUARTER};
use engine_core::{BLOCK_FRAMES, CHANNELS, Engine};
use engine_plugins::catalog::CATALOG;
use engine_plugins::fingerprint;

// Native builds (`cargo test`) have no WebAssembly features.
#[cfg(all(target_arch = "wasm32", not(target_feature = "simd128")))]
compile_error!("engine-wasm must be built with the simd128 target feature");

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

/// On the build thread.
#[unsafe(no_mangle)]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut BuildThread {
    panic_text::install();
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
pub unsafe extern "C" fn engine_batch_bytes(build: *mut BuildThread, len: u32) -> *mut u8 {
    let batch = unsafe { &mut (*build).batch };
    // Zeroes only what it adds: the copy overwrites every byte.
    batch.resize(len as usize, 0);
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
    sample_rate: f32,
    channels: u32,
    frames: u32,
) -> i32 {
    let build = unsafe { &mut *build };
    let hash = build.hash;
    answer(
        build
            .builder
            .samples()
            .begin(hash, sample_rate, channels as usize, frames as usize),
    )
}

/// Room for the next `count` numbers of the sound; valid until the next call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_place(build: *mut BuildThread, count: u32) -> *mut f32 {
    unsafe { (*build).builder.samples().place(count as usize) }
        .as_mut_ptr()
        .cast()
}

/// The build thread wrote the `count` numbers it got the place for. Answers as [`engine_sample_begin`] does.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_copied(build: *mut BuildThread, count: u32) -> i32 {
    answer(unsafe { (*build).builder.samples().copied(count as usize) })
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
pub unsafe extern "C" fn engine_collect(build: *mut BuildThread) -> u32 {
    unsafe { (*build).builder.collect() as u32 }
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
pub extern "C" fn engine_block_frames() -> u32 {
    BLOCK_FRAMES as u32
}

/// Output channels; the worklet's must match.
#[unsafe(no_mangle)]
pub extern "C" fn engine_channels() -> u32 {
    CHANNELS as u32
}

/// Size prefix included.
#[unsafe(no_mangle)]
pub extern "C" fn engine_max_message() -> u32 {
    MAX_MESSAGE as u32
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
pub extern "C" fn engine_input_capacity() -> u32 {
    INPUT_CAPACITY as u32
}

/// Never moves.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_input(engine: *mut Engine) -> *mut u8 {
    unsafe { (*engine).input().as_mut_ptr() }
}

/// New bytes go right after these.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_input_len(engine: *mut Engine) -> u32 {
    unsafe { (*engine).input().len() as u32 }
}

/// Counts `received` new input bytes and runs a block; see [`Engine::audio_block`]. Returns the size of the events
/// that fit into `event_room`; they lie at [`engine_events`] until the next call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_process(
    engine: *mut Engine,
    frames: u32,
    received: u32,
    event_room: u32,
) -> u32 {
    let engine = unsafe { &mut *engine };
    engine.input().received(received as usize);
    engine.audio_block(frames as usize, event_room as usize) as u32
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_output(engine: *const Engine, channel: u32) -> *const f32 {
    unsafe { (*engine).output(channel as usize).as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_event_capacity() -> u32 {
    EVENT_CAPACITY as u32
}

/// Never moves.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_events(engine: *const Engine) -> *const u8 {
    unsafe { (*engine).events().as_ptr() }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_telemetry_words() -> u32 {
    TELEMETRY_WORDS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_meters() -> u32 {
    METERS as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_panic_text_bytes() -> u32 {
    panic_text::PANIC_TEXT_BYTES as u32
}

/// Never moves; updated every block.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_telemetry(engine: *const Engine) -> *const Telemetry {
    unsafe { (*engine).telemetry() }
}
