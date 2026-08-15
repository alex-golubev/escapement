// Diagnostics posted from the worklet to the main thread. This is not the
// command protocol — commands travel through shared memory and are a separate,
// versioned contract. These messages only carry what the audio thread learns
// about its environment and cannot report any other way.
//
// The file is imported by both sides on purpose: the worklet is bundled
// standalone, so a shared type is the only thing keeping the two ends from
// drifting apart silently.

// `readonly` throughout, like both failure unions: these arrive from another
// thread through structured clone, so they are readings of what happened there
// and there is nothing here for anyone to write back into.

/**
 * Frames in a render quantum. Web Audio renders blocks of exactly this size and
 * offers no way to ask for another.
 *
 * Here, beside the message that reports the real one, because the two ends of
 * that check are what the number is for: the worklet allocates the engine for
 * it, the page holds the reported count against it, and a page comparing the
 * report against a literal of its own would be comparing it against a number
 * nothing was built with. A spec that gives itself the right to change this —
 * or a host that already has — then shows up as a failed check rather than as
 * an engine rendering into buffers of the wrong length.
 */
export const QUANTUM = 128

/** The processor constructed and instantiated the engine. */
export interface ReadyMessage {
  readonly type: 'ready'
  /** As seen inside the worklet, which is the authority — not what the page assumed. */
  readonly sampleRate: number
  /** Reported by the compiled engine, not by this side of the code. */
  readonly protocolVersion: number
}

/**
 * Construction failed. The processor cannot render and will end itself; without
 * this message the failure would reach the page as a bare `processorerror`
 * event carrying no reason at all.
 */
export interface FailedMessage {
  readonly type: 'failed'
  readonly message: string
}

/**
 * The frame count of the first rendered quantum, as the host actually rendered
 * it. Reported because no test in either suite can observe it: what the browser
 * hands `process` is visible from inside a worklet and nowhere else.
 */
export interface FirstQuantumMessage {
  readonly type: 'first-quantum'
  readonly frames: number
}

export type WorkletMessage = ReadyMessage | FailedMessage | FirstQuantumMessage
