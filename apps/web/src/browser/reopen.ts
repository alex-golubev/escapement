import { Effect, Layer, MutableRef, Schema } from 'effect'
import { CannotReopen, PageReopen, Taken } from '../services/reopen'
import { backKey, reopenPage } from './reopen-page'

/** What the page takes along, for its tab only. */
const takenKey = 'escapement.reopened'

/** What the reopened page couldn't read back is not taken along. */
const takenJson = Schema.fromJsonString(Taken)

/** Read once, so a reload later isn't a reopening; a browser that keeps nothing for the tab has nothing to read. */
const takeAlong = Effect.try(() => {
  const taken = sessionStorage.getItem(takenKey)
  sessionStorage.removeItem(takenKey)
  return taken
}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(takenJson)), Effect.option)

/** A page that stays after all must not leave what it took along for a reload to read. */
const forget = Effect.try(() => sessionStorage.removeItem(takenKey)).pipe(
  // Then nothing was kept either.
  Effect.ignore
)

/** The browser's: `sessionStorage` lives with the tab, across the trip. */
export const pageReopenLayer = Layer.effect(
  PageReopen,
  Effect.map(takeAlong, (taken) => {
    const leaving = MutableRef.make(false)
    return {
      taken,
      reopen: (taken: Taken) =>
        Schema.encodeEffect(takenJson)(taken).pipe(
          Effect.flatMap((json) =>
            Effect.try({
              try: () => {
                sessionStorage.setItem(backKey, location.href)
                sessionStorage.setItem(takenKey, json)
                MutableRef.set(leaving, true)
                location.replace(`${import.meta.env.BASE_URL}${reopenPage}`)
              },
              catch: (cause) => new CannotReopen({ cause })
            })
          ),
          Effect.catchTag('SchemaError', (cause) => Effect.fail(new CannotReopen({ cause }))),
          Effect.tapError(() =>
            Effect.andThen(
              Effect.sync(() => MutableRef.set(leaving, false)),
              forget
            )
          )
        ),
      reopening: () => MutableRef.get(leaving)
    }
  })
)
