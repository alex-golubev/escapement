// Keeping the two build artifacts in step with their sources, from inside the
// dev server.
//
// `web/public/engine.wasm` and `web/public/worklet/processor.js` are produced by
// scripts outside Vite's module graph, and Vite rebuilds neither. That left one
// failure mode sitting in the loop all day: edit, reload, and watch the previous
// version run. Nothing catches it in general — the ring's version word only
// fires when the protocol layout changed, so an edit to the metronome or to the
// render loop produces no mismatch at all, just yesterday's sound.
//
// The two artifacts get different answers here, because they cost different
// amounts to build. The worklet bundle is esbuild, some twelve milliseconds, so
// it is simply rebuilt. The engine is a release build with `lto = true` and
// `codegen-units = 1`; rebuilding that on every keystroke is untenable, and
// building it under the dev profile instead would mean running an engine with
// neither `lto` nor `panic = "abort"` — a different artifact from the shipped
// one, which is the divergence this project avoids everywhere else. So the wasm
// is not rebuilt, only reported on.

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Logger, Plugin } from 'vite'

const execFileAsync = promisify(execFile)

const repoRoot = path.resolve(import.meta.dirname, '../..')
const buildWorkletScript = path.join(repoRoot, 'scripts/build-worklet.sh')
const bundlePath = path.join(repoRoot, 'web/public/worklet/processor.js')
const webSources = path.join(repoRoot, 'web/src')
const engineWasm = path.join(repoRoot, 'web/public/engine.wasm')
const engineSources = path.join(repoRoot, 'crates/engine/src')

// Vitest applies this config too, and neither plugin has anything to do there:
// the suites import TypeScript directly and read `engine.wasm` off disk, so a
// rebuild would only add a way for an unrelated failure to fail the tests.
const underTest = process.env['VITEST'] !== undefined

/** The stderr of a failed child process, or whatever else went wrong. */
function failureText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const { stderr } = error
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Rebuild the worklet bundle whenever anything it could contain changes, and
 * reload the page when the result actually differs.
 *
 * The script is invoked rather than reimplemented. It carries two checks that
 * exist because their failure is silent — a surviving `import`, which loads
 * nowhere in `AudioWorkletGlobalScope`, and a missing `registerProcessor`,
 * which fails later in the `AudioWorkletNode` constructor with a message about
 * an unregistered name. A second copy of the build here would be a second place
 * for those to drift out of.
 *
 * Which files belong to the bundle is not tracked, and deliberately. The
 * dependency set is small today — the worklet plus three files from `audio/` —
 * but it is exactly the kind of list that goes stale silently. Rebuilding on any
 * `.ts` under `src/` and comparing the output bytes gives the same precision
 * without a list: an edit to `host.ts` produces an identical bundle and no
 * reload, an edit to `protocol.ts` produces a different one and reloads.
 *
 * A page reload is the whole of what is achievable. A processor name is
 * registered once per `AudioWorkletGlobalScope`, so a running context cannot be
 * given new code — the context has to be built again, which is what the reload
 * does.
 */
export function workletBundle(): Plugin {
  let previous: Buffer | null = null

  // Returns whether the bundle changed.
  const build = async (): Promise<boolean> => {
    await execFileAsync(buildWorkletScript, [], { cwd: repoRoot })
    const next = await readFile(bundlePath)
    const changed = previous === null || !next.equals(previous)
    previous = next
    return changed
  }

  return {
    name: 'daw:worklet-bundle',

    // Runs for `vite dev` and `vite build` alike, so neither ever starts from a
    // stale bundle. A failing script rejects here and takes the command with it,
    // which is the right outcome for both.
    async buildStart() {
      if (underTest) return
      await build()
    },

    configureServer(server) {
      const rebuild = async (file: string): Promise<void> => {
        if (!file.startsWith(webSources)) return
        if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) return

        try {
          if (!(await build())) return
        } catch (error) {
          const detail = failureText(error)
          server.config.logger.error(detail, { timestamp: true })
          // On the page as well as in the terminal: the terminal is not where
          // you are looking when the sound stops.
          server.hot.send({
            type: 'error',
            err: { message: 'The worklet bundle failed to build', stack: detail },
          })
          return
        }

        server.hot.send({ type: 'full-reload' })
      }

      server.watcher.on('change', (file) => void rebuild(file))
    },
  }
}

/** The newest mtime among the engine's Rust sources, or 0 if there are none. */
async function newestSource(): Promise<number> {
  const entries = await readdir(engineSources, { withFileTypes: true, recursive: true })
  let newest = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.rs')) continue
    const { mtimeMs } = await stat(path.join(entry.parentPath, entry.name))
    if (mtimeMs > newest) newest = mtimeMs
  }
  return newest
}

/** What is wrong with the compiled engine, if anything. */
async function engineProblem(): Promise<string | null> {
  const built = await stat(engineWasm).catch(() => null)
  if (built === null) return 'web/public/engine.wasm does not exist'
  if ((await newestSource()) > built.mtimeMs) {
    return 'web/public/engine.wasm is older than crates/engine/src'
  }
  return null
}

function report(logger: Logger, problem: string): void {
  logger.warn(`${problem} — run ./scripts/build-wasm.sh`, { timestamp: true })
}

/**
 * Say so when the compiled engine is older than the Rust it was compiled from.
 *
 * This is the check that was missing. `engine_protocol_version` refuses a wasm
 * whose *layout* disagrees with the worklet, which is a narrow case: change the
 * metronome and the version still matches, so a stale engine plays on with
 * nothing said. Comparing mtimes catches every edit rather than the ones that
 * moved a field.
 *
 * A warning while serving, an error while building. Editing Rust mid-session is
 * ordinary and stopping the dev server over it would be obnoxious — the page
 * still runs, just on the old engine, and the line says which command fixes it.
 * Shipping a build against a missing or stale engine is not ordinary.
 */
export function engineFreshness(): Plugin {
  let logger: Logger
  let command: 'serve' | 'build' = 'serve'

  return {
    name: 'daw:engine-freshness',

    configResolved(config) {
      logger = config.logger
      command = config.command
    },

    async buildStart() {
      if (underTest) return
      const problem = await engineProblem()
      if (problem === null) return
      if (command === 'build') this.error(`${problem} — run ./scripts/build-wasm.sh`)
      report(logger, problem)
    },

    configureServer(server) {
      // Outside the project root, so Vite is not watching it already.
      server.watcher.add(engineSources)
      server.watcher.on('change', (file) => {
        if (!file.startsWith(engineSources) || !file.endsWith('.rs')) return
        void engineProblem().then((problem) => {
          if (problem !== null) report(logger, problem)
        })
      })
    },
  }
}
