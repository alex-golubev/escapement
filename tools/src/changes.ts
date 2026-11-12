/** The Rust a branch changes, as a patch for `cargo mutants --in-diff`. */
import { Effect, FileSystem } from 'effect'
import { run, step } from './script.ts'

/**
 * From where `base` and HEAD part to the working tree: commits, edits not yet committed, and new files git doesn't
 * track yet. Returns the patch's path, in a folder that goes with the scope. Plumbing, so how someone has git show
 * diffs (colors, prefixes, an external diff) doesn't change it; new files come in through a copy of the index, and
 * the real one stays as it is.
 */
export const changedRust = Effect.fn('changedRust')(function* (repo: string, base: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs
    .makeTempDirectoryScoped({ prefix: 'escapement-changes-' })
    .pipe(step('Creating a temporary folder'))
  const index = `${dir}/index`
  const patch = `${dir}/rust.diff`
  const real = yield* run('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index'])
  yield* fs.copyFile(real, index).pipe(step(`Copying ${real}`))
  const git = (args: ReadonlyArray<string>) => run('git', ['-C', repo, ...args], { env: { GIT_INDEX_FILE: index } })
  yield* git(['add', '--intent-to-add', '--', '*.rs'])
  // A file moved keeps only its changed lines while it is still at least half the same.
  yield* git(['diff-index', '--patch', '--find-renames', `--output=${patch}`, '--merge-base', base, '--', '*.rs'])
  return patch
})
