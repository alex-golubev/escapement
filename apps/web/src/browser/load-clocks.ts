import { loadClockThread } from '@escapement/engine'
import { Effect, Layer } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { LoadClocks } from '../services/load-clocks'

/** The browser's cores and threads, and the page's visibility followed while the layer lasts. */
export const loadClocksLayer = Layer.effect(
  LoadClocks,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const seenNow = () => document.visibilityState === 'visible'
    const seen = Atom.make(seenNow()).pipe(Atom.keepAlive)
    const follow = () => registry.set(seen, seenNow())
    yield* Effect.acquireRelease(
      Effect.sync(() => document.addEventListener('visibilitychange', follow)),
      () => Effect.sync(() => document.removeEventListener('visibilitychange', follow))
    )
    return { cores: navigator.hardwareConcurrency, thread: loadClockThread, seen } satisfies LoadClocks
  })
)
