import { Boolean } from 'effect'

/** A number the drawn workstation shows: what moves keeps to what is written on the page. */
const shownNumber = (name: string, fallback: number) =>
  Number(document.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`) ?? fallback)

const beat = 60 / Number(document.querySelector('[data-bpm]')?.textContent ?? 124)
const bar = 4 * beat
const loopBars = shownNumber('loop-bars', 5)
const loop = loopBars * bar
const echo = shownNumber('echo-beats', 0.75) * beat
const ticksPerBeat = 960

/** Whether it plays and is in sight, how far it is, in seconds, and the frame asked for while it moves. */
const transport = { playing: true, visible: true, seconds: 0, last: 0, request: 0 }

const still = matchMedia('(prefers-reduced-motion: reduce)')

const moving = () => transport.playing && transport.visible && !still.matches

/** The theme's colours, read once: they are the page's own and don't change. */
const theme = getComputedStyle(document.documentElement)
const colour = (name: string) => theme.getPropertyValue(`--color-studio-${name}`).trim()
const colours = { panel: colour('panel'), elevated: colour('elevated'), amber: colour('amber') }

/** The analysers' canvases, each with what draws on it. */
const analysers = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas[data-analyser]')).flatMap((canvas) =>
  [canvas.getContext('2d')].filter((g): g is CanvasRenderingContext2D => g !== null).map((g) => ({ canvas, g }))
)

/** Sized to the box it fills, in the screen's own pixels. */
const fit = ({ canvas, g }: (typeof analysers)[number]) => {
  const scale = devicePixelRatio
  canvas.width = Math.round(canvas.clientWidth * scale)
  canvas.height = Math.round(canvas.clientHeight * scale)
  g.setTransform(scale, 0, 0, scale, 0, 0)
}

/** A spectrum as a mix shows it: a bump in the lows, a moving trough in the mids, the highs rolling off. */
const draw = ({ canvas, g }: (typeof analysers)[number], frame: number) => {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  g.fillStyle = colours.panel
  g.fillRect(0, 0, width, height)
  g.strokeStyle = colours.elevated
  g.lineWidth = 1
  Array.from({ length: Math.ceil((height - 10) / 20) }, (_, i) => 10 + i * 20).forEach((y) => {
    g.beginPath()
    g.moveTo(0, y + 0.5)
    g.lineTo(width, y + 0.5)
    g.stroke()
  })
  const points = 48
  const [first, ...rest] = Array.from({ length: points + 1 }, (_, i) => {
    const low = Math.sin(i / 8 + frame * 0.05) * 12
    const mid = Math.sin(i / 3 - frame * 0.08) * 6
    const rolloff = (i / points) * 22
    return { x: (i / points) * width, y: Math.max(8, Math.min(height - 5, height * 0.65 - low - mid + rolloff)) }
  })
  g.strokeStyle = colours.amber
  g.lineWidth = 1.2
  g.beginPath()
  g.moveTo(first.x, first.y)
  rest.forEach(({ x, y }) => g.lineTo(x, y))
  g.stroke()
}

const reductions = Array.from(document.querySelectorAll<HTMLElement>('[data-reduction]'))

/** The compressor's reduction, in percent of its meter: breathing as it plays, held without motion, none stopped. */
const reductionAt = (seconds: number) => {
  const breath = Math.floor((seconds * 60) / 7)
  const breathing = 18 + 24 * (0.5 + 0.5 * Math.sin(breath * 1.7) * Math.cos(breath * 0.61))
  return Number(transport.playing) * (28 + Number(!still.matches) * (breathing - 28))
}

/** The delay's taps, the dry hit first, each with how bright it stands at rest and the glow under it. */
const taps = Array.from(document.querySelectorAll<SVGElement>('[data-tap]'), (line) => ({
  line,
  glow: document.querySelector<SVGElement>(`[data-glow="${line.dataset.tap}"]`),
  at: Number(line.dataset.tap) * echo,
  rest: Number(line.getAttribute('opacity') ?? 1)
}))

/** A hit on each downbeat and its echoes after it: each flares as it sounds and fades until it sounds again. */
const flareOf = ({ at }: (typeof taps)[number], seconds: number) => {
  const since = (((seconds - at) % bar) + bar) % bar
  return Number(moving()) * Math.exp(-since / 0.22)
}

/** How wide a bar is drawn on the ruler, measured as the page is laid out, not on every frame. */
const layout = { barWidth: 96 }
const loopMarks = Array.from(document.querySelectorAll<HTMLElement>('[data-loop-bars]'))
const measure = () => {
  layout.barWidth = document.querySelector('[data-bar-width]')?.getBoundingClientRect().width ?? 96
  loopMarks.forEach((mark) => {
    mark.style.width = `${loopBars * layout.barWidth}px`
  })
  analysers.forEach(fit)
}

const playheads = Array.from(document.querySelectorAll<HTMLElement>('[data-playhead]'))
const readouts = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-${name}]`))
const shown = { bar: readouts('bar'), beat: readouts('beat'), tick: readouts('tick'), time: readouts('time') }

const padded = (value: number, digits: number) => String(Math.floor(value)).padStart(digits, '0')

/** Where the playhead stands in the loop: bars, beats and ticks from 1, and hours to milliseconds. */
const positionAt = (seconds: number) => {
  const at = seconds % loop
  return {
    at,
    bar: padded(at / bar + 1, 3),
    beat: padded(((at / beat) % 4) + 1, 2),
    tick: padded(((at % beat) / beat) * ticksPerBeat, 3),
    time: `${padded(at / 3600, 2)}:${padded((at / 60) % 60, 2)}:${padded(at % 60, 2)}.${padded((at % 1) * 1000, 3)}`
  }
}

const write = (elements: ReadonlyArray<HTMLElement>, text: string) =>
  elements.forEach((element) => {
    element.textContent = text
  })

/** One frame of all that moves, as it stands at the transport's seconds. */
const render = () => {
  const { seconds } = transport
  analysers.forEach((analyser) => draw(analyser, seconds * 60))
  reductions.forEach((meter) => {
    meter.style.width = `${reductionAt(seconds)}%`
  })
  const position = positionAt(seconds)
  playheads.forEach((playhead) => {
    playhead.style.transform = `translateX(${(position.at / bar) * layout.barWidth}px)`
  })
  write(shown.bar, position.bar)
  write(shown.beat, position.beat)
  write(shown.tick, position.tick)
  write(shown.time, position.time)
  const lowered = Number(moving()) * 0.2
  taps.forEach((tap) => {
    const flare = flareOf(tap, seconds)
    tap.line.style.opacity = String(tap.rest * (1 - lowered * (1 - flare)))
    tap.glow?.style.setProperty('opacity', String(Math.min(1, 1.6 * flare) * tap.rest))
  })
}

// Time, not frames: a faster screen moves nothing faster, and the echoes keep the tempo.
const frame = (now: number) => {
  transport.seconds += Math.min(now - transport.last, 100) / 1000
  transport.last = now
  render()
  transport.request = requestAnimationFrame(frame)
}

/** Moves while it plays in sight, motion allowed; otherwise one still frame, and no work until that changes. */
const follow = () => {
  cancelAnimationFrame(transport.request)
  render()
  Boolean.match(moving(), {
    onTrue: () => {
      transport.last = performance.now()
      transport.request = requestAnimationFrame(frame)
    },
    onFalse: () => {}
  })
}

/** Play lit while it plays; its border always there, so it keeps its size. */
const playButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-play]'))
const playingLook = ['bg-studio-amber', 'text-studio-base', 'border-studio-amber']
const stoppedLook = ['bg-studio-panel', 'text-studio-bright', 'border-studio-border']
const play = (playing: boolean) => {
  transport.playing = playing
  playButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(playing))
    playingLook.forEach((name) => button.classList.toggle(name, playing))
    stoppedLook.forEach((name) => button.classList.toggle(name, !playing))
  })
  follow()
}

playButtons.forEach((button) => button.addEventListener('click', () => play(!transport.playing)))
document.querySelectorAll('[data-stop]').forEach((button) => button.addEventListener('click', () => play(false)))
document.querySelectorAll('[data-rewind]').forEach((button) =>
  button.addEventListener('click', () => {
    transport.seconds = 0
    follow()
  })
)

/** A new size, or a screen of another density, as when the window goes to another display. */
const watchDensity = () =>
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      measure()
      render()
      watchDensity()
    },
    { once: true }
  )
const workstations = Array.from(document.querySelectorAll('[data-workstation]'))
const resizing = new ResizeObserver(() => {
  measure()
  render()
})
workstations.forEach((workstation) => resizing.observe(workstation))
watchDensity()

const sighting = new IntersectionObserver((entries) => {
  transport.visible = entries.some((entry) => entry.isIntersecting)
  follow()
})
workstations.forEach((workstation) => sighting.observe(workstation))
still.addEventListener('change', follow)

measure()
follow()
