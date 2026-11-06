import { type Editor, editorOf } from '@escapement/model'
import { Context, Effect, Layer } from 'effect'
import { ProjectSession } from './session'

/** The page's edits of its project, and their undo. */
export type DomainOps = Editor

export const DomainOps = Context.Service<DomainOps>('DomainOps')

export const domainOpsLayer = Layer.effect(
  DomainOps,
  Effect.flatMap(ProjectSession, ({ doc, writer }) => editorOf(doc, writer))
)
