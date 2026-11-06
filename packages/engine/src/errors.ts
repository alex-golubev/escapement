import { Data } from 'effect'

export class EngineLoadError extends Data.TaggedError('EngineLoadError')<{ readonly cause: unknown }> {}

export class EngineStartError extends Data.TaggedError('EngineStartError')<{ readonly cause: unknown }> {}

/** The processor threw and went silent; the message is the browser's. */
export class ProcessorError extends Data.TaggedError('ProcessorError')<{ readonly message: string }> {}

/** The build thread threw or didn't load, or a message between it and the page couldn't be read. */
export class BuildThreadError extends Data.TaggedError('BuildThreadError')<{ readonly message: string }> {}

/** The engine lost its command stream: it plays on, but takes no more commands. */
export class CommandStreamError extends Data.TaggedError('CommandStreamError')<{ readonly message: string }> {}
