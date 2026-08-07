// The TypeScript half of the two-file contract with commands.rs, edited
// together with it. Here rather than in the worklet because `processor.ts`
// calls `registerProcessor` on load, so nothing can import out of it — and a
// number no test can reach is a number that drifts.

/** Mirror of `PROTOCOL_VERSION` in commands.rs. Bump on any layout change. */
export const PROTOCOL_VERSION = 1

/** Mirror of `TELEMETRY_WORDS` in engine.rs. */
export const TELEMETRY_WORDS = 4
