import { Boolean, Option, Record } from 'effect'
import type { RefObject } from 'preact'
import { type Inputs, useLayoutEffect } from 'preact/hooks'
import type { Size } from './fit'

/** The canvas's context, the canvas as big as `size` in the screen's pixels and cleared; none where none draws. */
export const cleared = (canvas: HTMLCanvasElement, size: Size) =>
  Option.map(Option.fromNullishOr(canvas.getContext('2d')), (g) => {
    const scale = devicePixelRatio
    const width = Math.round(size.width * scale)
    const height = Math.round(size.height * scale)
    // Resizing a canvas clears it, so only a change of size does.
    Boolean.match(canvas.width === width && canvas.height === height, {
      onTrue: () => {},
      onFalse: () => {
        canvas.width = width
        canvas.height = height
      }
    })
    g.setTransform(scale, 0, 0, scale, 0, 0)
    g.clearRect(0, 0, size.width, size.height)
    return g
  })

/**
 * Draws on the canvas what `draw` draws of `drawn`, cleared to its view's size first, again each time `inputs` change:
 * a layer of a view drawn on canvases, each drawn again only when what it shows changes.
 */
export const useLayer = <A extends { readonly view: Size }>(
  canvas: RefObject<HTMLCanvasElement | null>,
  drawn: Option.Option<A>,
  draw: (g: CanvasRenderingContext2D, drawn: A) => void,
  inputs: Inputs
) =>
  useLayoutEffect(() => {
    Option.map(Option.all({ drawn, canvas: Option.fromNullishOr(canvas.current) }), ({ drawn, canvas }) =>
      Option.map(cleared(canvas, drawn.view), (g) => draw(g, drawn))
    )
  }, inputs)

/** The values of the custom properties named, as an element's style gives them: what a canvas draws with. */
export const paletteOf =
  <K extends string>(tokens: Readonly<Record<K, string>>) =>
  (element: Element): Record<K, string> => {
    const style = getComputedStyle(element)
    return Record.map(tokens, (name) => style.getPropertyValue(name).trim())
  }
