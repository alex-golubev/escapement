import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { DateTime, Effect, FileSystem, Option } from 'effect'
import { changedRust } from '../src/changes.ts'
import { run } from '../src/script.ts'

// Away from this machine's git settings, and from the repository of a hook, should the tests run inside one.
const isolated = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined
}

const git = (repo: string, ...args: ReadonlyArray<string>) => run('git', ['-C', repo, ...args], { env: isolated })

const write = (path: string, text: string) => FileSystem.FileSystem.use((fs) => fs.writeFileString(path, text))

const lines = (...names: ReadonlyArray<string>) => names.map((name) => `fn ${name}() {}\n`).join('')

/** The patch of the Rust the repository changes since `base`; none fails the test. */
const patchSince = (repo: string, base: string) =>
  changedRust(repo, base).pipe(
    Effect.map(Option.getOrThrow),
    Effect.flatMap((patch) => FileSystem.FileSystem.use((fs) => fs.readFileString(patch)))
  )

/** The files a patch changes, by their paths after, with git's usual prefix. */
const changedIn = (patch: string) =>
  patch
    .split('\n')
    .filter((line) => line.startsWith('+++ b/'))
    .map((line) => line.slice('+++ b/'.length))

/**
 * A repository whose branch has left `main`, which has gone on since, and git settings that would change what
 * porcelain prints.
 */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: 'escapement-changes-' })
  yield* git(repo, 'init', '--quiet', '--initial-branch=main')
  const settings = [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['color.ui', 'always'],
    ['diff.noprefix', 'true'],
    ['diff.external', 'false']
  ]
  yield* Effect.forEach(settings, ([name, value]) => git(repo, 'config', name, value), { discard: true })
  const files = {
    'committed.rs': lines('a'),
    'edited.rs': lines('a'),
    'touched.rs': lines('a'),
    'moved.rs': lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    'main.rs': lines('a'),
    'notes.md': 'notes\n',
    '.gitignore': 'ignored.rs\n'
  }
  yield* Effect.forEach(Object.entries(files), ([name, text]) => write(`${repo}/${name}`, text), { discard: true })
  yield* git(repo, 'add', '--all')
  yield* git(repo, 'commit', '--quiet', '--message=Start')
  yield* git(repo, 'switch', '--quiet', '--create', 'branch')
  yield* write(`${repo}/committed.rs`, lines('a', 'committed'))
  yield* git(repo, 'commit', '--quiet', '--all', '--message=Branch')
  yield* git(repo, 'switch', '--quiet', 'main')
  yield* write(`${repo}/main.rs`, lines('a', 'on main'))
  yield* git(repo, 'commit', '--quiet', '--all', '--message=Main')
  yield* git(repo, 'switch', '--quiet', 'branch')
  return repo
})

layer(NodeServices.layer)('the Rust a branch changes', (it) => {
  it.effect(
    'is its commits, its edits and its new files, whatever git settings say, and leaves the index as it was',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* repository
        yield* write(`${repo}/edited.rs`, lines('a', 'edited'))
        yield* write(`${repo}/new.rs`, lines('new'))
        yield* write(`${repo}/ignored.rs`, lines('ignored'))
        yield* write(`${repo}/notes.md`, 'more notes\n')
        const later = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'))
        yield* fs.utimes(`${repo}/touched.rs`, later, later)
        yield* git(repo, 'mv', 'moved.rs', 'renamed.rs')
        yield* write(`${repo}/renamed.rs`, lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'renamed'))
        const status = yield* git(repo, 'status', '--porcelain')

        const patch = yield* patchSince(repo, 'main')

        expect(changedIn(patch)).toEqual(['committed.rs', 'edited.rs', 'new.rs', 'renamed.rs'])
        expect(patch).toContain('rename from moved.rs')
        expect(patch).not.toContain('\u001b')
        expect(yield* git(repo, 'status', '--porcelain')).toBe(status)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "merged onto main, as CI checks a pull request, is the branch's alone against the merge's first parent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* repository
        yield* git(repo, 'switch', '--quiet', '--create', 'merged', 'main')
        yield* git(repo, 'merge', '--quiet', '--no-ff', '--message=Merge', 'branch')
        // As CI checks it out: the merge and its parents, nothing further back.
        const clone = yield* fs.makeTempDirectoryScoped({ prefix: 'escapement-clone-' })
        yield* run('git', ['clone', '--quiet', '--depth=2', '--branch=merged', `file://${repo}`, clone], {
          env: isolated
        })

        expect(changedIn(yield* patchSince(clone, 'HEAD^'))).toEqual(['committed.rs'])
      }).pipe(Effect.scoped)
  )

  it.effect('is none when only other files changed', () =>
    Effect.gen(function* () {
      const repo = yield* repository
      yield* write(`${repo}/notes.md`, 'more notes\n')
      yield* write(`${repo}/new.md`, 'new\n')

      expect(yield* changedRust(repo, 'HEAD')).toEqual(Option.none())
    }).pipe(Effect.scoped)
  )
})
