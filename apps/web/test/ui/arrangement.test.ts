import { lastTick } from '@escapement/engine-description'
import { barTicks, Id } from '@escapement/model'
import { Option } from 'effect'
import { expect, test } from 'vitest'
import { edgeWidth } from '../../src/ui/kit/edge'
import { cursorAt, cursorOf, draggedClips, draggedTo, Grab, grabAt } from '../../src/ui/views/arrangement/drag'
import {
  barsAcross,
  clipAt,
  clipsAlong,
  endOf,
  inDrawingOrder,
  type Shown,
  startAt,
  barsInSight,
  tracksDown,
  tracksInSight,
  type View,
  xOf,
  yOf
} from '../../src/ui/views/arrangement/geometry'
import { layoutOf } from '../../src/ui/views/arrangement/layout'

/** The sizes at a rem of 16 px, the least the window gives. */
const layout = layoutOf(16)

const { barWidth, headsWidth, rulerHeight, trackHeight } = layout

/** The tracks of the arrangement the tests draw. */
const trackCount = 20

/** Eight bars wide and ten tracks high, of twenty tracks, scrolled down two tracks and right a bar. */
const view: View = {
  ...layout,
  width: headsWidth + 8 * barWidth,
  height: rulerHeight + 10 * trackHeight,
  top: 2 * trackHeight,
  left: barWidth,
  tracks: trackCount
}

/** As long as its pattern, unless `bars` says longer or shorter than `periodBars`. */
const clip = (id: string, place: number, bar: number, bars = 1, periodBars = bars, offsetBars = 0): Shown => ({
  id: Id(id),
  place,
  tick: bar * barTicks,
  length: bars * barTicks,
  period: periodBars * barTicks,
  offset: offsetBars * barTicks
})

/** In the middle of the track's row, at the tick. */
const point = (place: number, tick: number) => ({ x: xOf(view, tick), y: yOf(view, place) + trackHeight / 2 })

test('a point takes the clip drawn last of those under it, on its row and in its time; none off the grid', () => {
  const clips = [clip('under', 3, 2, 2), clip('over', 3, 3), clip('below', 4, 2)]
  const at = (place: number, tick: number) => Option.map(clipAt(clips, view, point(place, tick)), ({ id }) => id)
  expect(at(3, 2 * barTicks)).toEqual(Option.some('under'))
  expect(at(3, 3.5 * barTicks)).toEqual(Option.some('over'))
  // Its end is the next one's start.
  expect(at(4, 3 * barTicks)).toEqual(Option.none())
  expect(at(4, 3 * barTicks - 1)).toEqual(Option.some('below'))
  // Over the ruler, over the heads, and past the edges.
  expect(clipAt(clips, view, { x: xOf(view, 2.5 * barTicks), y: rulerHeight - 1 })).toEqual(Option.none())
  expect(clipAt([clip('scrolled', 3, 0)], view, { x: headsWidth - 1, y: yOf(view, 3) + 1 })).toEqual(Option.none())
  expect(clipAt([clip('far', 3, 9)], view, { x: view.width, y: yOf(view, 3) + 1 })).toEqual(Option.none())
})

test('a double click puts a clip from the start of the bar it falls in, on the row; none past the last track', () => {
  expect(startAt(view, point(5, 2.9 * barTicks))).toEqual(Option.some({ place: 5, tick: 2 * barTicks }))
  const last: View = { ...view, top: trackCount * trackHeight - 5 * trackHeight }
  expect(
    Option.map(startAt(last, { x: xOf(last, barTicks), y: yOf(last, trackCount - 1) + 1 }), ({ place }) => place)
  ).toEqual(Option.some(trackCount - 1))
  expect(startAt(last, { x: xOf(last, barTicks), y: yOf(last, trackCount) + 1 })).toEqual(Option.none())
})

test('a way across the arrangement takes each clip it passes over once', () => {
  const clips = [clip('a', 2, 1), clip('b', 3, 1), clip('c', 4, 5)]
  expect(clipsAlong(clips, view, point(2, 1.5 * barTicks), point(4, 1.5 * barTicks)).map(({ id }) => id)).toEqual([
    'a',
    'b'
  ])
})

test("the arrangement scrolls down, in tracks, to the row under the last, +'s, and across, in bars, to the last clip end", () => {
  expect(tracksDown(layout, view.height, trackCount, -1)).toBe(0)
  expect(tracksDown(layout, view.height, trackCount, 10 ** 9)).toBe(trackCount + 1 - 10)
  expect(tracksDown(layout, view.height, trackCount, 2.5)).toBe(2.5)
  // Fewer than fill it: none.
  expect(tracksDown(layout, view.height, 3, 10 ** 9)).toBe(0)
  // As many tracks at any size of the page: the rows, its height and the ruler all grow with its rem.
  const big = layoutOf(24)
  expect(tracksDown(big, big.rulerHeight + 10 * big.trackHeight, trackCount, 10 ** 9)).toBe(trackCount + 1 - 10)
  expect(endOf([])).toBe(0)
  expect(endOf([clip('a', 0, 2, 3), clip('b', 1, 4)])).toBe(5 * barTicks)
  expect(barsAcross(5 * barTicks, 10 ** 9)).toBe(5)
  expect(barsAcross(5 * barTicks, 2.25)).toBe(2.25)
  expect(barsAcross(0, 3)).toBe(0)
})

test('the tracks in sight are those partly under the ruler too, never past the last', () => {
  expect(tracksInSight({ ...view, top: 2.5 * trackHeight })).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(
    tracksInSight({ ...view, top: tracksDown(layout, view.height, trackCount, 10 ** 9) * trackHeight }).at(-1)
  ).toBe(trackCount - 1)
  expect(tracksInSight({ ...view, top: 0, tracks: 3 })).toEqual([0, 1, 2])
  expect(tracksInSight({ ...view, tracks: 0 })).toEqual([])
})

test('a clip dragged moves by whole bars and tracks, from the first bar and track to the last track', () => {
  const held = clip('held', 3, 2)
  const grab = Option.getOrThrow(grabAt([held], view, point(3, 2.5 * barTicks)))
  expect(Grab.$is('Move')(grab)).toBe(true)
  const length = barTicks
  expect(draggedTo(grab, view, point(3, 2.5 * barTicks))).toEqual({ place: 3, tick: 2 * barTicks, length, offset: 0 })
  // Half a bar on is the nearest bar on.
  expect(draggedTo(grab, view, point(5, 2.99 * barTicks))).toEqual({ place: 5, tick: 2 * barTicks, length, offset: 0 })
  expect(draggedTo(grab, view, point(5, 3 * barTicks))).toEqual({ place: 5, tick: 3 * barTicks, length, offset: 0 })
  expect(draggedTo(grab, view, point(-20, -9 * barTicks))).toEqual({ place: 0, tick: 0, length, offset: 0 })
  expect(draggedTo(grab, view, point(10 ** 6, 2.5 * barTicks)).place).toBe(trackCount - 1)
  // A longer one goes no further than its end allows: by the tick after the last.
  const long = Grab.Move({ clip: clip('long', 3, 0, 3), at: { place: 3, tick: 0 } })
  const lastBar = Math.floor((lastTick + 1) / barTicks)
  expect(draggedTo(long, view, point(3, 10 ** 12)).tick).toBe((lastBar - 3) * barTicks)
  // One off the bars keeps its place in its bar.
  const between = { ...held, tick: 2 * barTicks + 100 }
  const off = Option.getOrThrow(grabAt([between], view, point(3, 2.5 * barTicks)))
  expect(draggedTo(off, view, point(3, 0.5 * barTicks))).toEqual({ place: 3, tick: 100, length, offset: 0 })
})

test("a press by a clip's right edge, at most a third of the clip, takes hold of its length; the cursor says which", () => {
  const clips = [clip('one', 3, 2), clip('narrow', 4, 2, 0.25)]
  const end = xOf(view, 3 * barTicks)
  const at = (place: number, x: number) => ({ x, y: yOf(view, place) + trackHeight / 2 })
  const grabbed = (place: number, x: number) => Option.map(grabAt(clips, view, at(place, x)), (grab) => grab._tag)
  expect(grabbed(3, end - edgeWidth)).toEqual(Option.some('Resize'))
  expect(grabbed(3, end - 0.5)).toEqual(Option.some('Resize'))
  expect(grabbed(3, end - edgeWidth - 0.5)).toEqual(Option.some('Move'))
  // A quarter of a bar is 16 pixels: its edge is a third of it.
  const narrowEnd = xOf(view, 2.25 * barTicks)
  expect(grabbed(4, narrowEnd - 5)).toEqual(Option.some('Resize'))
  expect(grabbed(4, narrowEnd - 6)).toEqual(Option.some('Move'))
  expect([end - 1, end - edgeWidth - 1, end + 1].map((x) => cursorAt(clips, view, at(3, x)))).toEqual([
    'resize',
    'move',
    'none'
  ])
  const resize = Grab.Resize({ clip: clips[0], at: { place: 3, tick: 3 * barTicks }, edge: 'end' })
  expect([resize, Grab.Move({ clip: clips[0], at: { place: 3, tick: 0 } })].map(cursorOf)).toEqual(['resize', 'move'])
})

test("a clip's edge dragged makes it longer or shorter by whole bars, a bar at least, ending by the tick after the last", () => {
  const held = clip('held', 3, 2, 2, 1)
  const resize = Grab.Resize({ clip: held, at: { place: 3, tick: 4 * barTicks }, edge: 'end' })
  const lengthAt = (tick: number, place = 3) => draggedTo(resize, view, point(place, tick)).length
  expect(lengthAt(4 * barTicks)).toBe(2 * barTicks)
  // Half a bar on is the nearest bar on, on whatever track.
  expect(lengthAt(5.49 * barTicks, 7)).toBe(3 * barTicks)
  expect(lengthAt(5.5 * barTicks)).toBe(4 * barTicks)
  expect(lengthAt(-9 * barTicks)).toBe(barTicks)
  expect(lengthAt(10 ** 12)).toBe(Math.floor((lastTick + 1 - 2 * barTicks) / barTicks) * barTicks)
  expect(draggedTo(resize, view, point(7, 5.5 * barTicks))).toEqual({
    place: 3,
    tick: 2 * barTicks,
    length: 4 * barTicks,
    offset: 0
  })
  // One shorter than a bar, or ending later than whole bars can, as another client may leave it, stays so at a press.
  const odd = clip('odd', 3, 2, 0.25)
  const late = { ...clip('late', 3, 0, 1), tick: lastTick - 100, length: 101 }
  expect(
    [odd, late].map(
      (held) => draggedTo(Grab.Resize({ clip: held, at: { place: 3, tick: 0 }, edge: 'end' }), view, point(3, 0)).length
    )
  ).toEqual([0.25 * barTicks, 101])
  // Shown on top as long as held, round its pattern as before.
  const shown = draggedClips([held, clip('other', 1, 0)], resize, {
    place: 3,
    tick: 2 * barTicks,
    length: 4 * barTicks,
    offset: 0
  })
  expect(shown.at(-1)).toEqual({ ...held, length: 4 * barTicks })
})

test('a press on empty ground takes hold of nothing; a drag shows the clip held on top', () => {
  expect(grabAt([], view, point(6, 4.5 * barTicks))).toEqual(Option.none())
  const clips = [clip('a', 0, 0), clip('b', 1, 0)]
  const move = Grab.Move({ clip: clips[0], at: { place: 0, tick: 0 } })
  expect(
    draggedClips(clips, move, { place: 2, tick: barTicks, length: barTicks, offset: 0 }).map(({ tick, place }) => [
      tick,
      place
    ])
  ).toEqual([
    [0, 1],
    [barTicks, 2]
  ])
  // One gone from the document meanwhile shows nowhere.
  expect(draggedClips(clips.slice(1), move, { place: 2, tick: barTicks, length: barTicks, offset: 0 })).toEqual(
    clips.slice(1)
  )
})

test("a press by a clip's left edge takes hold of its start; on a clip a bar long, a third of it each way", () => {
  const clips = [clip('one', 3, 2, 2)]
  const start = xOf(view, 2 * barTicks)
  const at = (x: number) => ({ x, y: yOf(view, 3) + trackHeight / 2 })
  const grabbed = (x: number) =>
    Option.map(grabAt(clips, view, at(x)), (grab) =>
      Grab.$match(grab, { Move: () => 'move', Resize: ({ edge }) => edge })
    )
  expect([start, start + edgeWidth - 0.5, start + edgeWidth].map(grabbed)).toEqual([
    Option.some('start'),
    Option.some('start'),
    Option.some('move')
  ])
  expect(cursorAt(clips, view, at(start + 1))).toBe('resize')
  // Scrolled under the tracks' heads by 3 pixels, its start can't be taken hold of: right of them, it moves.
  const hidden = [clip('hidden', 3, (barWidth - 3) / barWidth, 2)]
  expect(xOf(view, hidden[0].tick)).toBe(headsWidth - 3)
  expect(Option.map(grabAt(hidden, view, at(headsWidth + 1)), ({ _tag }) => _tag)).toEqual(Option.some('Move'))
  // A bar of 64 pixels: 6 at each end, the rest moves it.
  const short = [clip('short', 3, 2)]
  expect(
    [start + 5, start + 32, start + barWidth - 1].map((x) => Option.map(grabAt(short, view, at(x)), ({ _tag }) => _tag))
  ).toEqual([Option.some('Resize'), Option.some('Move'), Option.some('Resize')])
})

test("a clip's left edge dragged starts it later or earlier by whole bars, its end where it was, its pattern going on from there", () => {
  // Bars 2 to 6 of a pattern three bars long, from its second bar.
  const held = clip('held', 3, 2, 4, 3, 1)
  const trim = Grab.Resize({ clip: held, at: { place: 3, tick: 2 * barTicks }, edge: 'start' })
  const spanAt = (tick: number) => draggedTo(trim, view, point(7, tick))
  expect(spanAt(2.2 * barTicks)).toEqual({ place: 3, tick: 2 * barTicks, length: 4 * barTicks, offset: barTicks })
  // Later: shorter, further into its pattern's rounds, kept so past a round, as the pattern may grow.
  expect(spanAt(4 * barTicks)).toEqual({ place: 3, tick: 4 * barTicks, length: 2 * barTicks, offset: 3 * barTicks })
  // A bar long at least.
  expect(spanAt(10 ** 9)).toEqual({ place: 3, tick: 5 * barTicks, length: barTicks, offset: 4 * barTicks })
  // Earlier: longer, from the round before's end, as far as the first bar; kept so under 0.
  expect(spanAt(0.6 * barTicks)).toEqual({ place: 3, tick: barTicks, length: 5 * barTicks, offset: 0 })
  expect(spanAt(-(10 ** 9))).toEqual({ place: 3, tick: 0, length: 6 * barTicks, offset: -barTicks })
  // Shown so, on top.
  const shown = draggedClips([held], trim, spanAt(0.6 * barTicks))
  expect(shown.at(-1)).toEqual({ ...held, tick: barTicks, length: 5 * barTicks, offset: 0 })
})

test('a clip that starts later is drawn over one before it, a shorter one over a longer, and so stays in reach', () => {
  const long = clip('a', 0, 0, 4)
  const inside = clip('z', 0, 1)
  const together = clip('m', 0, 0, 2)
  const drawn = inDrawingOrder([inside, long, together])
  expect(drawn.map(({ id }) => id)).toEqual(['a', 'm', 'z'])
  const shown = drawn.map((one) => ({ ...one, place: 3 }))
  const at = (tick: number) => Option.map(clipAt(shown, view, point(3, tick)), ({ id }) => id)
  expect(at(1.5 * barTicks)).toEqual(Option.some('z'))
  expect(at(2.5 * barTicks)).toEqual(Option.some('a'))
})

test('nothing is in sight of an arrangement no higher than its ruler, nor narrower than its heads', () => {
  expect(tracksInSight({ ...view, height: rulerHeight - 1 })).toEqual([])
  expect(barsInSight({ ...view, width: headsWidth - barWidth - 1, left: 0 })).toEqual([])
})

test('the sizes are whole pixels at any rem, so lines stay sharp, and grow with it', () => {
  expect(Object.values(layoutOf(23.1114)).every(Number.isInteger)).toBe(true)
  expect(layoutOf(24)).toMatchObject({ trackHeight: 54, barWidth: 96, headsWidth: 294, rulerHeight: 27 })
})
