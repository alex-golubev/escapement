import type { Heard } from '@escapement/engine'
import { defaultTempo } from '@escapement/engine-description'
import { Boolean, Option } from 'effect'
import { createContext } from 'preact'
import { useContext, useEffect, useMemo, useRef } from 'preact/hooks'
import type { Frame } from '../../services/engine-host'

/** Draws straight into the DOM, past Preact: only into elements Preact draws once and leaves alone. */
export type Draw = (frame: Frame | undefined) => void

export const FramesContext = createContext<Set<Draw>>(new Set())

/**
 * While `running`, reads a frame on every animation frame and hands it to each `useFrame` below; otherwise hands them
 * none once.
 */
export const useFrameLoop = (readFrame: () => Frame | undefined, running: boolean) => {
  const draws = useMemo(() => new Set<Draw>(), [])
  useEffect(() => {
    if (!running) {
      draws.forEach((drawn) => drawn(undefined))
      return
    }
    const frame = { id: 0 }
    const draw = () => {
      // Scheduled first, so a failure in one frame doesn't stop the next.
      frame.id = requestAnimationFrame(draw)
      const read = readFrame()
      draws.forEach((drawn) => drawn(read))
    }
    frame.id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame.id)
  }, [readFrame, running, draws])
  return draws
}

/** Calls the latest `draw` on every frame while mounted. */
export const useFrame = (draw: Draw) => {
  const draws = useContext(FramesContext)
  const latest = useRef(draw)
  latest.current = draw
  useEffect(() => {
    const drawn: Draw = (frame) => latest.current(frame)
    draws.add(drawn)
    return () => {
      draws.delete(drawn)
    }
  }, [draws])
}

/** As a new engine stands: at the start, at its own tempo, stopped. */
const standing: Heard = { tick: 0, loop: 0, tempo: defaultTempo, playing: false }

/** Where a frame hears the arrangement, stopped or playing; with none heard yet, where a new engine stands. */
export const heardOf = (frame: Frame | undefined): Heard =>
  Option.getOrElse(Option.fromUndefinedOr(frame?.heard), () => standing)

/** Writes only a change, into the text there: a new node would change the page's tree, which the hint line watches. */
export const setText = (element: HTMLElement | null, text: string) =>
  Option.map(
    Option.filter(Option.fromNullishOr(element), (drawn) => drawn.textContent !== text),
    (drawn) =>
      Option.match(
        Option.filter(
          Option.fromNullishOr(drawn.firstChild),
          (child): child is Text => child instanceof Text && child === drawn.lastChild
        ),
        {
          onNone: () => {
            drawn.textContent = text
          },
          onSome: (written) => {
            written.data = text
          }
        }
      )
  )

/** A custom property of the element's style, written only on a change, as `setText` writes text. */
export const setStyleVar = (element: HTMLElement | null, name: string, value: string) =>
  Option.match(
    Option.filter(Option.fromNullishOr(element), (drawn) => drawn.style.getPropertyValue(name) !== value),
    { onNone: () => {}, onSome: (drawn) => drawn.style.setProperty(name, value) }
  )

/** A `data-` flag of the element, "true" or absent, written only on a change, as `setText` writes text. */
export const setFlag = (element: HTMLElement | null, name: string, on: boolean) =>
  Option.match(
    Option.filter(Option.fromNullishOr(element), (drawn) => drawn.hasAttribute(name) !== on),
    {
      onNone: () => {},
      onSome: (drawn) =>
        Boolean.match(on, {
          onTrue: () => drawn.setAttribute(name, 'true'),
          onFalse: () => drawn.removeAttribute(name)
        })
    }
  )
