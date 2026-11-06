/**
 * The debug samples, synthesized after the Roland TR-808's voices: only the recipes are borrowed, so the sounds are
 * ours. Every run gives the same bytes.
 */

export const sampleRate = 48_000

export interface Recipe {
  /** Lasting: the file is named after it. */
  readonly id: string
  readonly name: string
  readonly seconds: number
  /** A new voice for each render: it keeps its own state, noise and filters. */
  readonly voice: () => (time: number) => number
}

const tau = 2 * Math.PI

/** xorshift32 from a fixed seed, so the noise is the same on every run, unlike `Math.random`; from −1 to 1. */
const noise = (seed: number) => {
  const state = { x: seed >>> 0 }
  return () => {
    state.x = (state.x ^ (state.x << 13)) >>> 0
    state.x = (state.x ^ (state.x >>> 17)) >>> 0
    state.x = (state.x ^ (state.x << 5)) >>> 0
    return (state.x / 2 ** 32) * 2 - 1
  }
}

/** A biquad from Robert Bristow-Johnson's cookbook; `a0` divided out. */
const biquad = (b0: number, b1: number, b2: number, a1: number, a2: number) => {
  const state = { x1: 0, x2: 0, y1: 0, y2: 0 }
  return (x: number) => {
    const y = b0 * x + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2
    state.x2 = state.x1
    state.x1 = x
    state.y2 = state.y1
    state.y1 = y
    return y
  }
}

const shape = (frequency: number, q: number) => {
  const w = (tau * frequency) / sampleRate
  return { cos: Math.cos(w), alpha: Math.sin(w) / (2 * q) }
}

const highpass = (cutoff: number, q: number) => {
  const { cos, alpha } = shape(cutoff, q)
  const a0 = 1 + alpha
  return biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0)
}

/** 0 dB at the center. */
const bandpass = (center: number, q: number) => {
  const { cos, alpha } = shape(center, q)
  const a0 = 1 + alpha
  return biquad(alpha / a0, 0, -alpha / a0, (-2 * cos) / a0, (1 - alpha) / a0)
}

const decay = (time: number, seconds: number) => Math.exp(-time / seconds)

/** A sine whose pitch falls from about 150 to 50 Hz, with a short click on the attack. */
const kick: Recipe = {
  id: 'kick',
  name: 'Kick',
  seconds: 0.7,
  voice: () => {
    const phase = { value: 0 }
    return (time) => {
      phase.value += (tau * (50 + 100 * decay(time, 0.03))) / sampleRate
      const body = Math.sin(phase.value) * decay(time, 0.15)
      const click = 0.3 * Math.sin(tau * 1500 * time) * decay(time, 0.002)
      return body + click
    }
  }
}

/** Two tones for the drum's body and bright noise for its wires. */
const snare: Recipe = {
  id: 'snare',
  name: 'Snare',
  seconds: 0.3,
  voice: () => {
    const random = noise(0x5eed_0002)
    const wires = highpass(1800, 0.7)
    return (time) => {
      const body = (Math.sin(tau * 180 * time) + 0.6 * Math.sin(tau * 330 * time)) * decay(time, 0.045)
      return 0.6 * body + 0.9 * wires(random()) * decay(time, 0.07)
    }
  }
}

/** The 808's six square waves, which sound metallic together. */
const hatFrequencies = [205.3, 304.4, 369.6, 522.7, 540, 800]

const square = (frequency: number, time: number) => ((frequency * time) % 1 < 0.5 ? 1 : -1)

/** The squares above about 7 kHz, through two filters for a steep slope. */
const hat: Recipe = {
  id: 'hat',
  name: 'Closed hat',
  seconds: 0.12,
  voice: () => {
    const [first, second] = [highpass(7000, 0.7), highpass(7000, 0.7)]
    return (time) => {
      const metal = hatFrequencies.reduce((sum, frequency) => sum + square(frequency, time), 0) / hatFrequencies.length
      return second(first(metal)) * decay(time, 0.02)
    }
  }
}

/** Starts of the hands' bursts, a little apart; the last one rings out as the room. */
const clapBursts = [0, 0.01, 0.02]

const clap: Recipe = {
  id: 'clap',
  name: 'Clap',
  seconds: 0.35,
  voice: () => {
    const random = noise(0x5eed_0004)
    const band = bandpass(1100, 1.5)
    const last = clapBursts.length - 1
    const envelope = (time: number) =>
      clapBursts.reduce((sum, start, index) => {
        if (time < start) return sum
        const end = index === last ? Number.POSITIVE_INFINITY : clapBursts[index + 1]
        return time < end ? sum + decay(time - start, index === last ? 0.06 : 0.003) : sum
      }, 0)
    return (time) => band(random()) * envelope(time)
  }
}

export const recipes: ReadonlyArray<Recipe> = [kick, snare, hat, clap]

/** The peak every sound is brought to: −1 dB. */
export const peakLevel = 10 ** (-1 / 20)

/** Long enough to start and stop without a click. */
const fadeIn = 0.0005
const fadeOut = 0.01

/** Half a cosine, from 0 to 1. */
const rise = (fraction: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, fraction))

/** The voice at its peak level, starting and ending at 0. */
export const render = (recipe: Recipe): Float64Array => {
  const voice = recipe.voice()
  const length = Math.round(recipe.seconds * sampleRate)
  const raw = Float64Array.from({ length }, (_, i) => voice(i / sampleRate))
  const faded = raw.map(
    (sample, i) => sample * rise(i / (fadeIn * sampleRate)) * rise((length - 1 - i) / (fadeOut * sampleRate))
  )
  const peak = faded.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
  return faded.map((sample) => (sample / peak) * peakLevel)
}

/** 16-bit PCM. */
export const quantize = (samples: Float64Array): Int16Array =>
  Int16Array.from(samples, (sample) => Math.round(sample * 32767))

const ascii = (view: DataView, at: number, text: string) =>
  Array.from(text).forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)))

const headerBytes = 44

/** A mono WAV file: the header, then the samples little-endian. */
export const encodeWav = (pcm: Int16Array): Uint8Array => {
  const dataBytes = pcm.length * 2
  const bytes = new Uint8Array(headerBytes + dataBytes)
  const view = new DataView(bytes.buffer)
  ascii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(view, 8, 'WAVE')
  ascii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  // PCM, one channel.
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  pcm.forEach((sample, i) => view.setInt16(headerBytes + i * 2, sample, true))
  return bytes
}

export const sampleFile = (recipe: Recipe) => encodeWav(quantize(render(recipe)))

/** How long a file `encodeWav` wrote plays, by its own header. */
export const wavSeconds = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const [rate, frameBytes, dataBytes] = [view.getUint32(24, true), view.getUint16(32, true), view.getUint32(40, true)]
  return dataBytes / frameBytes / rate
}
