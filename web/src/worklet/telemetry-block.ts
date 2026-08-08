// The block the engine writes on its way out of `engine_process`, mirroring
// the constants at the top of engine.rs. The second half of the ABI contract,
// audio → UI, where protocol.ts is the first half going the other way.
//
// Here in `worklet/` rather than in `audio/` because of which memory it
// describes. That is the line the three contracts in this codebase divide on,
// and it decides where a fourth one would go too:
//
//   record format    — audio/protocol.ts  — both threads encode or decode it
//   ring layout      — audio/ring.ts      — the SharedArrayBuffer, both threads
//   telemetry block  — here               — WASM linear memory, audio thread only
//
// Nothing on the page addresses these indices: the page reads the ring, whose
// own word indices live in ring.ts. Two index spaces, and the single place they
// meet is `publishTelemetry`, which copies one into the other.
//
// `PROTOCOL_VERSION` governs this layout as well as the record format — see the
// note beside it in protocol.ts. A change here is therefore a version bump, and
// what fails first if it is not is `telemetry-block.spec.ts` on this side and
// `engine::tests::telemetry_layout_is_pinned` on the other.

/** Mirror of `TELEMETRY_WORDS` in engine.rs. */
export const TELEMETRY_WORDS = 4

export const TELEMETRY_TRANSPORT_LO = 0
export const TELEMETRY_TRANSPORT_HI = 1
/**
 * Peaks travel as `f32` bits, put there by `f32::to_bits`. Reading them as
 * numbers means reading the same bytes through a `Float32Array` — converting
 * by hand would be a second, disagreeing definition of what an f32 is.
 */
export const TELEMETRY_PEAK_L = 2
export const TELEMETRY_PEAK_R = 3
