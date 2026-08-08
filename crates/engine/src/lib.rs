//! The DAW audio engine.
//!
//! The internal modules are written in safe Rust and tested with plain
//! `cargo test` on the native target. All `unsafe` is locked up in this
//! file — the C-ABI layer.
//!
//! # The boundary with the outside world
//!
//! Exports are a raw C ABI with no `wasm-bindgen`: `#[unsafe(no_mangle)]`
//! plus `extern "C"`. From the JS side these are WASM module functions taking
//! numbers and an opaque pointer to [`Instance`]. The layout of `Instance` is
//! not visible outside and is not part of the contract — JS only ever holds
//! the address.
//!
//! # Rules that must not be broken here
//!
//! - **Not a single panic.** Release builds set `panic = "abort"`, so a panic
//!   kills the whole worklet: sound is gone until the page is reloaded. Every
//!   input is untrusted, every index is checked, every pointer is null-checked.
//! - **Hot-path buffers are allocated once** in [`engine_new`] and never move
//!   again. After initialization there is not one allocation here, so WASM
//!   linear memory never grows and the worklet's views never detach. Sample
//!   loading will break that, so the worklet revalidates its views every
//!   quantum rather than trusting this.
//!
//! # Safety contract, shared by every function below
//!
//! `instance` is either `null` or a value obtained from [`engine_new`] and not
//! yet passed to [`engine_free`]. Null is accepted everywhere and does nothing.
//! Pointers handed out stay valid until [`engine_free`]; after it, they dangle.

pub mod commands;
pub mod dsp;
pub mod engine;
pub mod mixer;
pub mod pattern;
pub mod ring;
pub mod transport;

use commands::{COMMAND_SIZE, PROTOCOL_VERSION};
use engine::{Engine, TELEMETRY_WORDS};
use ring::CMD_CAPACITY;

/// Tracks in the drum machine.
///
/// Here rather than in one of the modules that uses it, because more than one
/// does — the mixer keeps a gain and a pan per track, the pattern a row of
/// steps per track — and two modules each declaring "8" would be two numbers
/// that are equal today. A `track` field crossing the ABI is addressed against
/// this one, so they cannot be allowed to disagree.
pub const TRACKS: usize = 8;

/// Upper bound on quantum length. Web Audio asks for 128 frames; the headroom
/// is for the offline renderer, which works in far larger blocks. The limit
/// guards against allocating on a garbage argument.
const MAX_FRAMES_LIMIT: u32 = 65_536;

/// Owner of the memory whose addresses are handed outside.
///
/// It exists for exactly that: [`Engine`] works on slices and owns nothing,
/// while the ABI needs pointers that stay valid from [`engine_new`] to
/// [`engine_free`].
pub struct Instance {
    engine: Engine,
    /// Output per channel. Each is `max_frames` long.
    out: [Vec<f32>; 2],
    /// The exchange area: the worklet copies command records here from the SAB.
    cmd: Vec<u8>,
    /// Telemetry words: the worklet copies these into the SAB under a seqlock.
    telemetry: [u32; TELEMETRY_WORDS],
    max_frames: usize,
}

impl Instance {
    fn new(sample_rate: f64, max_frames: usize) -> Self {
        Self {
            engine: Engine::new(sample_rate),
            out: [vec![0.0; max_frames], vec![0.0; max_frames]],
            cmd: vec![0; CMD_CAPACITY * COMMAND_SIZE],
            telemetry: [0; TELEMETRY_WORDS],
            max_frames,
        }
    }
}

/// The single place where a raw pointer becomes a reference.
///
/// # Safety
///
/// See the module contract.
unsafe fn as_instance<'a>(instance: *mut Instance) -> Option<&'a mut Instance> {
    if instance.is_null() {
        None
    } else {
        Some(unsafe { &mut *instance })
    }
}

/// The command protocol version.
///
/// Exported so that the version check is a real one. The SAB header also
/// carries a version number, but the UI is what writes it — comparing that
/// field against the constant in `protocol.ts` proves nothing, both halves
/// being on the same side. A mismatch with Rust is only caught by comparing
/// against a number that came out of the compiled engine.
#[unsafe(no_mangle)]
pub extern "C" fn engine_protocol_version() -> u32 {
    PROTOCOL_VERSION
}

/// Create an engine. Returns `null` if the arguments make no sense — the JS
/// side is required to check for that.
#[unsafe(no_mangle)]
pub extern "C" fn engine_new(sample_rate: f64, max_frames: u32) -> *mut Instance {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return core::ptr::null_mut();
    }
    if max_frames == 0 || max_frames > MAX_FRAMES_LIMIT {
        return core::ptr::null_mut();
    }
    Box::into_raw(Box::new(Instance::new(sample_rate, max_frames as usize)))
}

/// Destroy an engine. `null` is accepted and does nothing.
///
/// # Safety
///
/// `instance` came from [`engine_new`] and has not been freed before. After
/// this call every pointer handed out becomes dangling.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_free(instance: *mut Instance) {
    if instance.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(instance) });
}

/// The output buffer of a channel. `null` for an unknown channel.
///
/// # Safety
///
/// No more than the `frames` passed to the last [`engine_process`] may be
/// read from the returned pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_out_ptr(instance: *mut Instance, channel: u32) -> *mut f32 {
    let Some(instance) = (unsafe { as_instance(instance) }) else {
        return core::ptr::null_mut();
    };
    match instance.out.get_mut(channel as usize) {
        Some(out) => out.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

/// The start of the command exchange area.
///
/// # Safety
///
/// No more than [`engine_cmd_capacity`] × 16 bytes may be written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_cmd_ptr(instance: *mut Instance) -> *mut u8 {
    match unsafe { as_instance(instance) } {
        Some(instance) => instance.cmd.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

/// How many command records the engine accepts per quantum.
///
/// # Safety
///
/// See the module contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_cmd_capacity(instance: *mut Instance) -> u32 {
    match unsafe { as_instance(instance) } {
        Some(instance) => (instance.cmd.len() / COMMAND_SIZE) as u32,
        None => 0,
    }
}

/// The start of the telemetry words.
///
/// # Safety
///
/// [`TELEMETRY_WORDS`] words may be read; the values are refreshed by
/// [`engine_process`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_telemetry_ptr(instance: *mut Instance) -> *const u32 {
    match unsafe { as_instance(instance) } {
        Some(instance) => instance.telemetry.as_ptr(),
        None => core::ptr::null(),
    }
}

/// The hot path: exactly one call per quantum.
///
/// `frames` is clamped to `max_frames`, `cmd_count` to the capacity of the
/// exchange area — both arrive from another thread.
///
/// # Safety
///
/// See the module contract.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_process(instance: *mut Instance, frames: u32, cmd_count: u32) {
    let Some(instance) = (unsafe { as_instance(instance) }) else {
        return;
    };

    // Destructured because the engine needs three of these slices at once.
    let Instance { engine, out, cmd, telemetry, max_frames } = instance;
    let frames = (frames as usize).min(*max_frames);
    let [out_l, out_r] = out;

    engine.process(&mut out_l[..frames], &mut out_r[..frames], cmd, cmd_count);
    engine.write_telemetry(telemetry);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{Command, Record};

    const SR: f64 = 48_000.0;
    const Q: u32 = 128;

    /// A wrapper that guarantees the instance is freed even if a test panics.
    struct Owned(*mut Instance);

    impl Owned {
        fn new(sample_rate: f64, max_frames: u32) -> Self {
            let raw = engine_new(sample_rate, max_frames);
            assert!(!raw.is_null(), "the engine was not created");
            Self(raw)
        }

        fn raw(&self) -> *mut Instance {
            self.0
        }

        /// Write commands into the exchange area — exactly what the worklet does.
        fn write_commands(&self, records: &[Record]) {
            let bytes: Vec<u8> = records.iter().flat_map(|r| r.encode()).collect();
            let capacity = unsafe { engine_cmd_capacity(self.0) } as usize * COMMAND_SIZE;
            assert!(bytes.len() <= capacity);
            unsafe {
                core::ptr::copy_nonoverlapping(bytes.as_ptr(), engine_cmd_ptr(self.0), bytes.len());
            }
        }

        fn output(&self, channel: u32, frames: usize) -> Vec<f32> {
            unsafe { core::slice::from_raw_parts(engine_out_ptr(self.0, channel), frames) }.to_vec()
        }

        fn telemetry(&self) -> [u32; TELEMETRY_WORDS] {
            let ptr = unsafe { engine_telemetry_ptr(self.0) };
            let mut words = [0u32; TELEMETRY_WORDS];
            words.copy_from_slice(unsafe { core::slice::from_raw_parts(ptr, TELEMETRY_WORDS) });
            words
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { engine_free(self.0) };
        }
    }

    #[test]
    fn rejects_nonsense_arguments() {
        // Null rather than a panic: the call comes from JS, and there is no
        // stack to unwind into.
        for rate in [0.0, -48_000.0, f64::NAN, f64::INFINITY] {
            assert!(engine_new(rate, Q).is_null(), "sample_rate={rate}");
        }
        for frames in [0, MAX_FRAMES_LIMIT + 1, u32::MAX] {
            assert!(engine_new(SR, frames).is_null(), "max_frames={frames}");
        }
    }

    #[test]
    fn null_instance_is_tolerated_everywhere() {
        let null = core::ptr::null_mut();
        unsafe {
            engine_free(null);
            assert!(engine_out_ptr(null, 0).is_null());
            assert!(engine_cmd_ptr(null).is_null());
            assert_eq!(engine_cmd_capacity(null), 0);
            assert!(engine_telemetry_ptr(null).is_null());
            engine_process(null, Q, 4);
        }
    }

    #[test]
    fn out_ptr_rejects_unknown_channel() {
        let owned = Owned::new(SR, Q);
        unsafe {
            assert!(!engine_out_ptr(owned.raw(), 0).is_null());
            assert!(!engine_out_ptr(owned.raw(), 1).is_null());
            for channel in [2, 3, u32::MAX] {
                assert!(engine_out_ptr(owned.raw(), channel).is_null(), "channel {channel}");
            }
        }
    }

    #[test]
    fn buffers_never_move() {
        // The worklet caches views over this memory. If an address moves,
        // those views end up looking at somebody else's data.
        fn addresses(owned: &Owned) -> (*mut f32, *mut f32, *mut u8, *const u32) {
            unsafe {
                (
                    engine_out_ptr(owned.raw(), 0),
                    engine_out_ptr(owned.raw(), 1),
                    engine_cmd_ptr(owned.raw()),
                    engine_telemetry_ptr(owned.raw()),
                )
            }
        }

        let owned = Owned::new(SR, 1024);
        let before = addresses(&owned);

        owned.write_commands(&[Record::immediate(Command::Play)]);
        unsafe { engine_process(owned.raw(), Q, 1) };
        for _ in 0..1_000 {
            unsafe { engine_process(owned.raw(), Q, 0) };
        }

        assert_eq!(before, addresses(&owned), "hot-path addresses must not move");
    }

    #[test]
    fn abi_renders_the_same_as_the_engine() {
        let records = [
            Record::immediate(Command::SetBpm { bpm: 127.0 }),
            Record::immediate(Command::Play),
        ];

        let owned = Owned::new(SR, Q);
        owned.write_commands(&records);
        unsafe { engine_process(owned.raw(), Q, records.len() as u32) };
        let mut through_abi = owned.output(0, Q as usize);
        for _ in 0..200 {
            unsafe { engine_process(owned.raw(), Q, 0) };
            through_abi.extend(owned.output(0, Q as usize));
        }

        let mut direct = Engine::new(SR);
        let bytes: Vec<u8> = records.iter().flat_map(|r| r.encode()).collect();
        let mut left = vec![0.0f32; Q as usize];
        let mut right = vec![0.0f32; Q as usize];
        direct.process(&mut left, &mut right, &bytes, records.len() as u32);
        let mut expected = left.clone();
        for _ in 0..200 {
            direct.process(&mut left, &mut right, &[], 0);
            expected.extend_from_slice(&left);
        }

        assert_eq!(through_abi, expected);
    }

    #[test]
    fn both_channels_are_written() {
        let owned = Owned::new(SR, Q);
        owned.write_commands(&[Record::immediate(Command::Play)]);
        unsafe { engine_process(owned.raw(), Q, 1) };

        let left = owned.output(0, Q as usize);
        assert_eq!(left, owned.output(1, Q as usize));
        assert!(left.iter().any(|&s| s != 0.0), "sound must start after Play");
    }

    #[test]
    fn frames_are_clamped_to_max_frames() {
        // Under panic = "abort" out-of-bounds access kills the worklet.
        let owned = Owned::new(SR, Q);
        owned.write_commands(&[Record::immediate(Command::Play)]);
        unsafe {
            engine_process(owned.raw(), u32::MAX, 1);
        }
        assert_eq!(
            owned.telemetry()[engine::TELEMETRY_TRANSPORT_LO],
            Q,
            "the transport advanced further than the buffer allows"
        );
    }

    #[test]
    fn command_count_is_clamped_to_capacity() {
        let owned = Owned::new(SR, Q);
        owned.write_commands(&[Record::immediate(Command::Play)]);
        // A claim of records the exchange area does not hold. Nothing may be
        // read past the buffer, and the one real command must still apply.
        unsafe { engine_process(owned.raw(), Q, u32::MAX) };
        assert!(owned.output(0, Q as usize).iter().any(|&s| s != 0.0));
    }

    #[test]
    fn telemetry_follows_the_transport() {
        let owned = Owned::new(SR, Q);
        assert_eq!(owned.telemetry(), [0; TELEMETRY_WORDS], "zeros before the first call");

        owned.write_commands(&[Record::immediate(Command::Play)]);
        unsafe { engine_process(owned.raw(), Q, 1) };
        for _ in 0..9 {
            unsafe { engine_process(owned.raw(), Q, 0) };
        }

        let words = owned.telemetry();
        let position = u64::from(words[engine::TELEMETRY_TRANSPORT_HI]) << 32
            | u64::from(words[engine::TELEMETRY_TRANSPORT_LO]);
        assert_eq!(position, u64::from(Q) * 10);
        assert!(
            f32::from_bits(words[engine::TELEMETRY_PEAK_L]) > 0.0,
            "the click must show up on the meter"
        );
    }

    #[test]
    fn capacity_matches_the_exchange_area() {
        let owned = Owned::new(SR, Q);
        assert_eq!(unsafe { engine_cmd_capacity(owned.raw()) }, CMD_CAPACITY as u32);
    }

    #[test]
    fn protocol_version_comes_from_the_codec() {
        assert_eq!(engine_protocol_version(), PROTOCOL_VERSION);
    }

    #[test]
    fn instances_are_independent() {
        let first = Owned::new(SR, Q);
        let second = Owned::new(SR, Q);
        first.write_commands(&[Record::immediate(Command::Play)]);
        unsafe { engine_process(first.raw(), Q, 1) };
        unsafe { engine_process(second.raw(), Q, 0) };

        assert!(first.output(0, Q as usize).iter().any(|&s| s != 0.0));
        assert!(
            second.output(0, Q as usize).iter().all(|&s| s == 0.0),
            "engines must not see each other's commands"
        );
    }

    #[test]
    fn garbage_in_the_exchange_area_does_not_break_rendering() {
        let owned = Owned::new(SR, Q);
        let capacity = unsafe { engine_cmd_capacity(owned.raw()) } as usize * COMMAND_SIZE;
        let mut state = 0xD1B5_4A32_D192_ED03u64;
        let mut bytes = vec![0u8; capacity];

        for _ in 0..100 {
            for byte in bytes.iter_mut() {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *byte = state as u8;
            }
            unsafe {
                core::ptr::copy_nonoverlapping(
                    bytes.as_ptr(),
                    engine_cmd_ptr(owned.raw()),
                    bytes.len(),
                );
                engine_process(owned.raw(), Q, u32::MAX);
            }
            assert!(owned.output(0, Q as usize).iter().all(|s| s.is_finite()));
        }
    }
}
