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
 * The frame count of the first rendered quantum. Web Audio specifies 128 and
 * nothing else, but the native test suite cannot observe the real value, so it
 * is reported once and checked here.
 */
export interface FirstQuantumMessage {
  readonly type: 'first-quantum'
  readonly frames: number
}

export type WorkletMessage = ReadyMessage | FailedMessage | FirstQuantumMessage
