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
pub mod sampler;
pub mod sequencer;
pub mod transport;

/// Support shared by tests across the crate. Gated here rather than kept out of
/// `src/`, for the reason the module itself gives.
#[cfg(test)]
mod testing;

use commands::{COMMAND_SIZE, PROTOCOL_VERSION};
use engine::{Engine, TELEMETRY_WORDS};
use ring::CMD_CAPACITY;
use sampler::Refusal;

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

// There is deliberately no upper bound on the sample rate, and it is worth
// saying so where the other bound is declared: one existed, and what it
// guarded is gone. It was there because every sample slot held a fixed number
// of *seconds*, which made this argument decide how much memory the engine
// asked for — and an allocation WASM cannot serve does not fail, it aborts.
// The sample bank is now sized by the caller rather than by the rate, and
// nothing else here is proportional to it: what the rate still decides are
// counters and ramp lengths. A bound with nothing behind it is worse than
// none, because the next reader has to work out what it protects.

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

/// Make room for a whole kit, and hand back where to write it.
///
/// `null` on refusal, which the caller is required to check. Two things produce
/// it and they are the same answer: a null instance, and memory the host would
/// not give. Nothing else can — [`Bank::reserve`](sampler) has exactly one
/// refusal — so `null` here means "there is not that much memory" without a
/// number beside it, and the number it would carry is the one the caller just
/// passed in.
///
/// **The address is valid for `floats` values, until the next call to this
/// function or to [`engine_free`].** A second reservation is what invalidates
/// the first: there is one arena, it is built from empty each time, and no two
/// of them exist at once. Why the size comes from out here, why the refusal
/// exists at all, and what growing this does to the views the worklet holds are
/// argued at `Bank::reserve`, which is what does all three.
///
/// A reservation of zero is granted and is not a refusal: it declares the kit
/// gone, which is a thing a caller may want and which `null` must not be
/// confused with.
///
/// # Safety
///
/// See the module contract. Exactly `floats` values may be written through the
/// returned pointer, and nothing beyond them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_bank_reserve(instance: *mut Instance, floats: u32) -> *mut f32 {
    let Some(instance) = (unsafe { as_instance(instance) }) else {
        return core::ptr::null_mut();
    };
    match instance.engine.reserve_bank(floats as usize) {
        Ok(arena) => arena.as_mut_ptr(),
        Err(_) => core::ptr::null_mut(),
    }
}

/// Declare what was written into the arena, and let it sound.
///
/// Answers with [`COMMIT_ACCEPTED`] or with the code of the refusal — see
/// there for why a code and not a name.
///
/// # Safety
///
/// See the module contract. Every argument is checked; none of them is trusted
/// to describe anything that was actually written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_sample_commit(
    instance: *mut Instance,
    slot: u32,
    offset: u32,
    frames: u32,
    channels: u32,
) -> u32 {
    let Some(instance) = (unsafe { as_instance(instance) }) else {
        return COMMIT_NO_INSTANCE;
    };

    // Narrowed by a check, where every other argument here widens. `as u8`
    // would turn 257 into 1, and the slot would then declare a mono sample over
    // data laid out for 257 channels — accepted, because the bounds check reads
    // the declaration rather than the data, and audible as a sound at a
    // fraction of its rate. It is refused for the reason 3 is refused.
    let Ok(channels) = u8::try_from(channels) else {
        return COMMIT_CHANNELS;
    };

    let refusal =
        instance.engine.commit_sample(slot as usize, offset as usize, frames as usize, channels);
    match refusal {
        Ok(()) => COMMIT_ACCEPTED,
        Err(refusal) => refusal_code(refusal),
    }
}

/// [`engine_sample_commit`] took the sample.
pub const COMMIT_ACCEPTED: u32 = 0;

// The refusal codes, and the decision they carry: **the far side does not
// interpret them.** The worklet reports the number together with the context it
// already holds — which slot, at what offset, how many frames, how much it
// reserved — and the name of the cause stays on this side.
//
// That is a decision rather than an omission. A table of names over there would
// be a second description of this list, the same kind of thing as the opcode
// tables and with the same failure when the two disagree: the page names a
// cause that is not the one that fired, and whoever reads it goes to fix the
// wrong thing. Neither compiler can see across. Interpreting nothing cannot
// disagree with anything, and costs one grep for the number — which is why the
// numbers are pinned as literals in `refusals_are_the_numbers_the_page_prints`,
// so that grep lands on the variant that produced it.
//
// The condition for revisiting is written where it will be met: when a kit
// arrives that the page did not lay out itself, the causes become different
// things for a user to do, and then they earn a table on both sides and a place
// under `PROTOCOL_VERSION`.
const COMMIT_NO_INSTANCE: u32 = 1;
const COMMIT_OUT_OF_MEMORY: u32 = 2;
const COMMIT_NO_SUCH_SLOT: u32 = 3;
const COMMIT_CHANNELS: u32 = 4;
const COMMIT_EMPTY: u32 = 5;
const COMMIT_DOES_NOT_FIT: u32 = 6;

/// No `_` arm: a refusal added to the enum has to be given a number here, and
/// the compiler is the only thing that would say so. Under a catch-all it would
/// reach the page as whatever that arm chose, which is a wrong cause rather
/// than a missing one.
fn refusal_code(refusal: Refusal) -> u32 {
    match refusal {
        Refusal::OutOfMemory { .. } => COMMIT_OUT_OF_MEMORY,
        Refusal::NoSuchSlot => COMMIT_NO_SUCH_SLOT,
        Refusal::Channels(_) => COMMIT_CHANNELS,
        Refusal::Empty => COMMIT_EMPTY,
        Refusal::DoesNotFit { .. } => COMMIT_DOES_NOT_FIT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{Command, Record};
    use crate::sampler::SLOTS;
    use crate::testing::Xorshift64;

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
        //
        // What is refused about the rate is only what is meaningless — zero,
        // negative, not a number. There is no upper bound, and its absence is
        // asserted rather than left to be noticed: an absurdly high rate once
        // allocated an absurd amount of sample memory, and now allocates
        // nothing at all, so refusing it would be a rule with nothing behind
        // it. Through `Owned` so the instance is freed rather than leaked.
        for rate in [0.0, -48_000.0, f64::NAN, f64::INFINITY] {
            assert!(engine_new(rate, Q).is_null(), "sample_rate={rate}");
        }
        let _absurd_but_harmless = Owned::new(1e12, Q);
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
            assert!(engine_bank_reserve(null, 8).is_null());
            // Anything but acceptance, which is what this test is about; the
            // number itself is pinned where the other codes are.
            assert_ne!(engine_sample_commit(null, 0, 0, 8, 1), COMMIT_ACCEPTED);
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

        // The one allocation that happens after `engine_new`, and so the only
        // event that could move any of the four. It does not: a growing arena
        // is a new allocation beside them, and on wasm growth appends pages
        // rather than relocating anything.
        //
        // What a native test cannot see is the other half — that the same growth
        // detaches every JS view over that memory, which is why the worklet
        // rebuilds them rather than trusting these addresses. That half is
        // argued at `Bank::reserve` and covered in the browser.
        assert!(!unsafe { engine_bank_reserve(owned.raw(), 1 << 20) }.is_null());

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
        // Asked of each channel separately rather than by comparing them. The
        // comparison was the shorter way to catch a second buffer nobody wrote
        // — it would be zeros against a sounding first — but it also asserts
        // the two are alike, which is a fact about today's engine rather than
        // about the ABI, and pan will end it. What this is named for outlives
        // that.
        let owned = Owned::new(SR, Q);
        owned.write_commands(&[Record::immediate(Command::Play)]);
        unsafe { engine_process(owned.raw(), Q, 1) };

        for channel in 0..2 {
            assert!(
                owned.output(channel, Q as usize).iter().any(|&s| s != 0.0),
                "channel {channel} was left silent after Play"
            );
        }
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
        let mut rng = Xorshift64::new(0xD1B5_4A32_D192_ED03);
        let mut bytes = vec![0u8; capacity];

        for _ in 0..100 {
            rng.fill(&mut bytes);
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

    /// Lay a kit out the way the far side will: one reservation, one write
    /// through the pointer it hands back, one declaration per sample.
    ///
    /// Through the raw pointer rather than through `Engine::reserve_bank`,
    /// which is what the sampler's own tests use. The two calls in between are
    /// the whole of what this file adds, and a test taking the safe path would
    /// exercise neither of them.
    fn load(owned: &Owned, samples: &[f32]) {
        let arena = unsafe { engine_bank_reserve(owned.raw(), samples.len() as u32) };
        assert!(!arena.is_null(), "the arena was refused");
        unsafe { core::slice::from_raw_parts_mut(arena, samples.len()) }.copy_from_slice(samples);
        let frames = samples.len() as u32;
        assert_eq!(
            unsafe { engine_sample_commit(owned.raw(), 0, 0, frames, 1) },
            COMMIT_ACCEPTED,
        );
    }

    #[test]
    fn a_track_strikes_what_was_written_through_the_arena_pointer() {
        // The first test here that reaches a sample, and the one that says the
        // two new calls are wired to each other: what comes out is the values
        // written through the pointer the first call handed back, in the order
        // they were written, for as long as the second call declared and no
        // longer.
        //
        // Asserted as ratios rather than as levels. What scales a sample on its
        // way out is the gain chain — velocity, the pan law, the master, the
        // limiter — and none of that is this file's subject; a level here would
        // be an assertion about the mixer that goes red when the mixer changes,
        // which is the mistake `quantum` made about `left == right`. Ratios of
        // powers of two are exact and say only what is asked: these samples and
        // not some others.
        const KIT: [f32; 4] = [1.0, 0.5, 0.25, 0.125];

        let owned = Owned::new(SR, Q);
        load(&owned, &KIT);

        // No `Play`: the pad sounds against a stopped transport, which is what
        // makes this the sample rather than the grid — and leaves the metronome
        // silent without having to be switched off.
        owned.write_commands(&[Record::immediate(Command::TriggerTrack {
            track: 0,
            velocity: 1.0,
        })]);
        unsafe { engine_process(owned.raw(), Q, 1) };

        let out = owned.output(0, Q as usize);
        assert!(out[0] > 0.0, "the sample did not sound at all");
        for (frame, value) in KIT.iter().enumerate() {
            assert_eq!(out[frame], out[0] * value, "frame {frame} is not the sample");
        }
        assert!(
            out[KIT.len()..].iter().all(|&s| s == 0.0),
            "the voice read past what was declared"
        );
    }

    #[test]
    fn a_slot_sounds_from_the_offset_it_was_declared_at() {
        // The one argument of `engine_sample_commit` that a single-sample kit
        // cannot pin: with everything written at the start of the arena, an
        // offset dropped on the way through reads exactly the same. Two samples
        // in one arena is the smallest fixture that tells them apart — found by
        // mutating the argument away, which left every test here green and only
        // the compiled-engine suite red.
        const ARENA: [f32; 4] = [1.0, 1.0, 0.25, 0.25];

        let owned = Owned::new(SR, Q);
        let arena = unsafe { engine_bank_reserve(owned.raw(), ARENA.len() as u32) };
        assert!(!arena.is_null(), "the arena was refused");
        unsafe { core::slice::from_raw_parts_mut(arena, ARENA.len()) }.copy_from_slice(&ARENA);
        unsafe {
            assert_eq!(engine_sample_commit(owned.raw(), 0, 0, 2, 1), COMMIT_ACCEPTED);
            assert_eq!(engine_sample_commit(owned.raw(), 1, 2, 2, 1), COMMIT_ACCEPTED);
        }

        // Half velocity, so the product stays under the limiter's threshold and
        // the ratio below is arithmetic rather than a reading off a curve.
        let struck = |track: u8| {
            owned.write_commands(&[Record::immediate(Command::TriggerTrack {
                track,
                velocity: 0.5,
            })]);
            unsafe { engine_process(owned.raw(), Q, 1) };
            owned.output(0, Q as usize)[0]
        };

        let first = struck(0);
        assert!(first > 0.0, "the first slot did not sound at all");
        assert_eq!(struck(1), first / 4.0, "the second slot did not sound from its own offset");
    }

    #[test]
    fn refusals_are_the_numbers_the_page_prints() {
        // Literals, not the constants the code returns: a test reading those
        // agrees with any renumbering, and the number is exactly what a reader
        // has in hand after seeing it on screen — the whole reason no table of
        // names exists on the other side.
        //
        // The first is not a `Refusal` and shares the code space anyway: from
        // where the number is read it is one more answer this call can give.
        assert_eq!(unsafe { engine_sample_commit(core::ptr::null_mut(), 0, 0, 8, 1) }, 1);
        assert_eq!(refusal_code(Refusal::OutOfMemory { floats: 1 }), 2);
        assert_eq!(refusal_code(Refusal::NoSuchSlot), 3);
        assert_eq!(refusal_code(Refusal::Channels(3)), 4);
        assert_eq!(refusal_code(Refusal::Empty), 5);
        assert_eq!(refusal_code(Refusal::DoesNotFit { end: 1, reserved: 0 }), 6);

        // And each of them arriving through the call that produces it, so the
        // mapping above is not a table checked against itself. Out of memory is
        // absent on purpose: `commit` cannot answer with it, and asking
        // `reserve` for an amount no host would grant means naming one through
        // a `u32` — sixteen gigabytes, which a 64-bit host may well hand over.
        // That branch is covered where it is cheap, at `Bank::reserve`.
        let owned = Owned::new(SR, Q);
        assert!(!unsafe { engine_bank_reserve(owned.raw(), 8) }.is_null());
        unsafe {
            assert_eq!(engine_sample_commit(owned.raw(), SLOTS as u32, 0, 4, 1), 3);
            assert_eq!(engine_sample_commit(owned.raw(), 0, 0, 4, 3), 4);
            assert_eq!(engine_sample_commit(owned.raw(), 0, 0, 0, 1), 5);
            assert_eq!(engine_sample_commit(owned.raw(), 0, 0, 9, 1), 6);
            assert_eq!(engine_sample_commit(owned.raw(), 0, 0, 8, 1), COMMIT_ACCEPTED);
        }
    }

    #[test]
    fn a_channel_count_too_large_for_a_byte_is_refused_rather_than_truncated() {
        // The one argument here that narrows. Truncated, 257 becomes 1 and is
        // accepted: the slot would declare a mono sample over data laid out for
        // 257 channels, and the bounds check would pass, because what it checks
        // is the declaration and not the data.
        let owned = Owned::new(SR, Q);
        assert!(!unsafe { engine_bank_reserve(owned.raw(), 8) }.is_null());

        for channels in [256, 257, 512, u32::MAX] {
            assert_eq!(
                unsafe { engine_sample_commit(owned.raw(), 0, 0, 4, channels) },
                COMMIT_CHANNELS,
                "channels {channels}"
            );
        }
    }

    #[test]
    fn an_empty_reservation_is_granted_rather_than_refused() {
        // Asking for nothing is how a caller says the kit is gone, and the
        // answer has to be told apart from the one refusal this call has. A
        // `Vec` never hands back a null pointer, so what comes back is an
        // address with nothing behind it — legal to build a zero-length view
        // over, and the far side writes nothing through it.
        let owned = Owned::new(SR, Q);
        load(&owned, &[1.0, 1.0, 1.0, 1.0]);

        assert!(!unsafe { engine_bank_reserve(owned.raw(), 0) }.is_null());

        // And nothing is left declared: the old kit is gone rather than
        // pointing into an arena that no longer holds it.
        assert_eq!(unsafe { engine_sample_commit(owned.raw(), 0, 0, 1, 1) }, COMMIT_DOES_NOT_FIT);
        owned.write_commands(&[Record::immediate(Command::TriggerTrack {
            track: 0,
            velocity: 1.0,
        })]);
        unsafe { engine_process(owned.raw(), Q, 1) };
        assert!(
            owned.output(0, Q as usize).iter().all(|&s| s == 0.0),
            "a slot survived the kit being dropped"
        );
    }
}
