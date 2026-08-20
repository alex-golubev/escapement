// What the two threads say to each other outside the command protocol.
//
// Commands travel through shared memory and are a separate, versioned
// contract; these are not that. Back from the worklet come the things the audio
// thread learns about its environment and can report no other way. Forward to
// it goes one thing, and only one: a kit. A command record is sixteen bytes and
// a kit is megabytes, so sample data was never going to fit down that road —
// and why taking this one is not a second way into the engine is argued at
// `Engine::reserve_bank`, which is the pair of calls it ends in.
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
 * Construction failed. The processor cannot render and will end itself.
 *
 * This message is the only way the reason crosses, and that is what shapes the
 * whole of the worklet's bring-up: an exception escaping the processor
 * constructor arrives on the page as a bare `processorerror` event, which
 * carries no message, no stack and no field to put either in. So nothing over
 * there throws — every failure is a value, and it comes back here.
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

/** The kit went in. Every number is a reading, not a promise anything sounds. */
export interface KitLoadedMessage {
  readonly type: 'kit-loaded'
  readonly slots: number
  readonly floats: number
  /**
   * WASM linear memory in bytes, after the load — what the page watches across
   * repeated loads to see whether the arena is being reused or the memory is
   * only ever growing. Why it rides on this message rather than being polled is
   * argued at `LoadedKit`, which is where it is read.
   */
  readonly bytes: number
}

/**
 * The kit did not go in, and the engine holds none.
 *
 * A sentence rather than a case, unlike every other failure that crosses here.
 * The reasons live on the audio side as a tagged union and are turned into text
 * there — see `describeKitError`. What decides it is that the page has one thing
 * to do with any of them, which is show it: the kit it loads is one it built
 * itself, so every refusal but memory is a bug on this side rather than a
 * condition to recover from.
 */
export interface KitRefusedMessage {
  readonly type: 'kit-refused'
  readonly message: string
}

export type WorkletMessage =
  ReadyMessage | FailedMessage | FirstQuantumMessage | KitLoadedMessage | KitRefusedMessage

/**
 * One sample, interleaved, as the page decoded it.
 *
 * Interleaved on the main thread and not here, though `AudioBuffer` is planar
 * and the arena is not: the page is the cold side and has already copied the
 * data once, while the worklet's whole job with it is then one `set` per sample
 * — no loop and no arithmetic on the thread that must not stall.
 *
 * The frame count is absent because it is `data.length / channels`, and a
 * number sent alongside is a number that can disagree.
 */
export interface KitSample {
  readonly data: Float32Array
  /** One or two. Anything else is refused by the engine, which is the guard. */
  readonly channels: number
}

/**
 * Load a whole kit, replacing whatever is loaded now.
 *
 * A kit and not a sample: the reservation replaces the arena, so laying eight
 * samples out takes all eight lengths at once. The position in this list is the
 * slot, and the slot is the track — the identity is argued in `sampler/bank.rs`
 * and there is nothing here to carry it.
 */
export interface LoadKitMessage {
  readonly type: 'load-kit'
  readonly samples: readonly KitSample[]
}

/** Everything the page sends the other way. */
export type PageMessage = LoadKitMessage
