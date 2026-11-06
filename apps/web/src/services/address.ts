import type { Id } from '@escapement/model'
import { Data, Option, String } from 'effect'

/** What the page's address opens: the list of projects, or one of them. */
export type Address = Data.TaggedEnum<{
  Projects: {}
  /** By the ID the address names, which this browser may not keep. */
  Project: { readonly id: string }
}>

export const Address = Data.taggedEnum<Address>()

/** Where the app is served: the list of projects is at this address, and each project's page under it. */
export const appBase: string = import.meta.env.BASE_URL

const projectPath = /^project\/([^/]+)$/

/** The address of the page at `path`, under the app's `base`: any but a project's opens the list. */
export const addressOf = (path: string, base: string): Address =>
  Option.match(
    Option.flatMap(Option.liftPredicate(path, String.startsWith(base)), (path) =>
      Option.fromNullishOr(path.slice(base.length).match(projectPath))
    ),
    { onNone: () => Address.Projects(), onSome: ([, id]) => Address.Project({ id }) }
  )

export const projectHref = (id: Id) => `${appBase}project/${id}`
