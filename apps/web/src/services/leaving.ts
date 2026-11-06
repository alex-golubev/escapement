import { Boolean, Effect, Layer } from 'effect'
import { type Atom, AtomRegistry } from 'effect/reactivity'
import { Page } from './page'
import { PageReopen } from './reopen'
import { ProjectSession, type Saving } from './session'

/**
 * While the project isn't saved, leaving the page asks first, as what the page holds goes with it: to the list, by a
 * reload, or with the tab. Only then: a page that may ask is kept out of some browsers' cache. Not when the page goes
 * on its own, `reopening` after a hang: staying, its sound couldn't go on.
 */
export const askBeforeLeaving = Effect.fnUntraced(function* (saving: Atom.Atom<Saving>, reopening: () => boolean) {
  const registry = yield* AtomRegistry.AtomRegistry
  const page = yield* Page
  const ask = (event: Event) => Boolean.match(reopening(), { onTrue: () => {}, onFalse: () => event.preventDefault() })
  const follow = (now: Saving) =>
    Boolean.match(now === 'saved', {
      onTrue: () => page.removeEventListener('beforeunload', ask),
      onFalse: () => page.addEventListener('beforeunload', ask)
    })
  yield* Effect.acquireRelease(
    Effect.sync(() => registry.subscribe(saving, follow, { immediate: true })),
    (unsubscribe) =>
      Effect.sync(() => {
        unsubscribe()
        page.removeEventListener('beforeunload', ask)
      })
  )
})

export const leavingLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { saving } = yield* ProjectSession
    const { reopening } = yield* PageReopen
    yield* askBeforeLeaving(saving, reopening)
  })
)
