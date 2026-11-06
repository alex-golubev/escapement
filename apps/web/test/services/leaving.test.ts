import { Effect } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { expect, test } from 'vitest'
import { askBeforeLeaving } from '../../src/services/leaving'
import { Page } from '../../src/services/page'
import type { Saving } from '../../src/services/session'

/** Whether the page, going, asks first. */
const asks = (page: EventTarget) => {
  const going = new Event('beforeunload', { cancelable: true })
  page.dispatchEvent(going)
  return going.defaultPrevented
}

test.each<Saving>(['not-loaded', 'missing'])(
  'a page whose project is %s asks before it goes; once it closes, it no longer does',
  (loaded) =>
    Effect.gen(function* () {
      const page = new EventTarget()
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* askBeforeLeaving(Atom.make<Saving>(loaded), () => false).pipe(Effect.provideService(Page, page))
          expect(asks(page)).toBe(true)
        })
      )
      expect(asks(page)).toBe(false)
    }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.runPromise)
)

test('a saved project goes with no asking, until saving stops', () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const saving = Atom.make<Saving>('saved')
    const page = new EventTarget()
    yield* askBeforeLeaving(saving, () => false).pipe(Effect.provideService(Page, page))
    expect(asks(page)).toBe(false)
    registry.set(saving, 'refused')
    expect(asks(page)).toBe(true)
  }).pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.runPromise))

test('a page that goes on its own, to reopen after a hang, asks no one', () =>
  Effect.gen(function* () {
    const page = new EventTarget()
    const reopening = { now: false }
    yield* askBeforeLeaving(Atom.make<Saving>('missing'), () => reopening.now).pipe(Effect.provideService(Page, page))
    expect(asks(page)).toBe(true)
    reopening.now = true
    expect(asks(page)).toBe(false)
  }).pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.runPromise))
