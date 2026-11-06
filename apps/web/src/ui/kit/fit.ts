export interface Size {
  readonly width: number
  readonly height: number
}

/**
 * The size of a window that shows all of what is in its body with the body's padding on every side: as much bigger
 * or smaller as the body is than its content, up to `room`.
 */
export const fittedSize = ({
  window,
  body,
  padding,
  content,
  room
}: {
  readonly window: Size
  /** The body's size inside, padding included. */
  readonly body: Size
  readonly padding: number
  readonly content: Size
  readonly room: Size
}): Size => ({
  width: Math.min(room.width, window.width - body.width + content.width + 2 * padding),
  height: Math.min(room.height, window.height - body.height + content.height + 2 * padding)
})

/** The sides of a window to act along. */
export interface Axes {
  readonly width: boolean
  readonly height: boolean
}

export const bothAxes: Axes = { width: true, height: true }

/**
 * The sides a window should grow along to what is in it now: those along which it showed all of what was in it, and no
 * longer does. Along a side left bigger than what is in it, or smaller, it stays as it is.
 */
export const outgrown = ({
  body,
  padding,
  was,
  now
}: {
  /** The body's size, padding included; it has no border. */
  readonly body: Size
  readonly padding: number
  readonly was: Size
  readonly now: Size
}): Axes => ({
  width: was.width + 2 * padding <= body.width && now.width + 2 * padding > body.width,
  height: was.height + 2 * padding <= body.height && now.height + 2 * padding > body.height
})
