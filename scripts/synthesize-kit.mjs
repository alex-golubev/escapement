#!/usr/bin/env node
// Eight drum sounds, computed rather than sourced, into web/public/kit.
//
// Synthesised because a sample has a licence as real as a line of code has. The
// free drum packs almost all come with terms, this repository is public and
// proprietary, and a pack would go out to every visitor along with the page —
// so the rule about checking a licence before adding a dependency covers these
// too. Computing them removes the question rather than answering it.
//
// Two things follow that are worth more than the sounds themselves. The kit is
// a **reproducible artifact**: it can be made again from this file, which is
// what the golden render tests on M3 will need of their inputs. And swapping in
// real recordings later changes nothing else — the load path does not care
// where a file came from.
//
// Deterministic by construction: the only noise source is the seeded generator
// below, so running this twice writes the same bytes. Run it with
// `node scripts/synthesize-kit.mjs`; the output is committed, so it is a tool
// rather than a build step.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 48_000
const DESTINATION = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'kit')

/**
 * xorshift32, seeded per sound so that each is reproducible on its own and no
 * two of them share a sequence.
 */
function noise(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return (state / 0x1_0000_0000) * 2 - 1
  }
}

const seconds = (value) => Math.round(value * RATE)
const decay = (t, tau) => Math.exp(-t / tau)

/**
 * One biquad section, in place — the RBJ cookbook coefficients.
 *
 * Two poles rather than the one-pole that was here, and it is the difference
 * between a filter and a tilt: at six decibels an octave the band being asked
 * for is still mostly everything else. Sections are cascaded by calling this
 * twice, which is what the sounds below do.
 *
 * Every caller filters before it envelopes. The other order works and sounds
 * different: the filter would then be ringing at an amplitude that is already
 * falling, which smears the attack — the one part of a drum that nothing
 * downstream can put back.
 */
function biquad(samples, { type, hz, q }) {
  const w = (2 * Math.PI * hz) / RATE
  const cosine = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)

  const [b0, b1, b2] =
    type === 'bandpass'
      ? [alpha, 0, -alpha]
      : [(1 + cosine) / 2, -(1 + cosine), (1 + cosine) / 2]
  const a0 = 1 + alpha
  const a1 = -2 * cosine
  const a2 = 1 - alpha

  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i]
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    samples[i] = y0
  }
}

/**
 * Scale to unit RMS, in place.
 *
 * For noise about to be mixed with something else, and **RMS rather than peak
 * for exactly that reason.** A band-pass passes a fraction of what white noise
 * carries, and how large a fraction depends on where the band sits and how
 * wide — so a mix written before any filter existed stops meaning what it says
 * the moment one arrives, and drifts again with every tuning of it. Peak would
 * not fix that: noise at unit peak carries a third of the energy a sine at unit
 * peak does, so a half-and-half mix by peak is a tone with hiss on it, which is
 * what the first attempt here measured as.
 */
function levelled(samples) {
  let sum = 0
  for (const value of samples) sum += value * value
  const rms = Math.sqrt(sum / samples.length)
  if (rms > 0) for (let i = 0; i < samples.length; i += 1) samples[i] /= rms
  return samples
}

function kick() {
  const out = new Float32Array(seconds(0.3))
  let phase = 0
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    // The drop in pitch is the whole sound: a fixed 45 Hz sine is a test tone.
    phase += (45 + 75 * decay(t, 0.028)) / RATE
    out[i] = Math.sin(2 * Math.PI * phase) * decay(t, 0.085)
  }
  return out
}

function snare() {
  const frames = seconds(0.18)
  const hiss = new Float32Array(frames)
  const random = noise(0x9e37_79b9)
  for (let i = 0; i < frames; i += 1) hiss[i] = random()

  // **Noise gets a band, and it is bounded above as well as below.** The rule
  // holds for every noise sound here and was learned by measuring one: white
  // noise reaches Nyquist, so a good half of what is normalised to full scale
  // sits where it is barely audible — and `decodeAudioData` resamples to the
  // device, which on a 44.1 kHz machine throws that half away and leaves the
  // sound both quieter and duller than on a 48 kHz one. Where the band sits is
  // per sound; that there is one at all is not.
  biquad(hiss, { type: 'bandpass', hz: 3_200, q: 0.5 })
  levelled(hiss)

  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE
    out[i] =
      hiss[i] * decay(t, 0.045) * 0.7 + Math.sin(2 * Math.PI * 190 * t) * decay(t, 0.06) * 0.5
  }
  return out
}

/** Both hats are one sound with two lengths, which is what they are on a kit. */
function hat(tau, length, seed) {
  const out = new Float32Array(seconds(length))
  const random = noise(seed)
  for (let i = 0; i < out.length; i += 1) out[i] = random()

  // High, because a cymbal is; a band rather than a slope, for the reason at
  // the snare. That reason was found here: two high-passes at 7 kHz were
  // written first and measured 78% of the sound above 12 kHz. Twice the poles
  // in the right shape is not the same as twice the filter.
  biquad(out, { type: 'bandpass', hz: 9_000, q: 0.8 })
  biquad(out, { type: 'bandpass', hz: 9_000, q: 0.8 })

  for (let i = 0; i < out.length; i += 1) out[i] *= decay(i / RATE, tau)
  return out
}

function clap() {
  const frames = seconds(0.2)
  const hiss = new Float32Array(frames)
  const random = noise(0x1234_5678)
  for (let i = 0; i < frames; i += 1) hiss[i] = random()

  // Lower and narrower than the hat: what a clap is made of is a room and two
  // hands, neither of which is bright. Same rule as the snare's, and the band
  // is the difference between a clap and an escape of steam.
  biquad(hiss, { type: 'bandpass', hz: 1_500, q: 0.55 })
  biquad(hiss, { type: 'bandpass', hz: 1_500, q: 0.55 })

  // Three bursts and a tail: one burst is a snare, and the gap between hands is
  // what a clap is.
  const bursts = [0, 0.009, 0.018]
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE
    let envelope = decay(Math.max(0, t - 0.026), 0.06) * 0.35
    for (const start of bursts) {
      if (t >= start) envelope = Math.max(envelope, decay(t - start, 0.006))
    }
    out[i] = hiss[i] * envelope
  }
  return out
}

function tom() {
  const out = new Float32Array(seconds(0.25))
  let phase = 0
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    phase += (90 + 90 * decay(t, 0.05)) / RATE
    out[i] = Math.sin(2 * Math.PI * phase) * decay(t, 0.12)
  }
  return out
}

function rim() {
  const frames = seconds(0.06)
  const hiss = new Float32Array(frames)
  const random = noise(0xcafe_babe)
  for (let i = 0; i < frames; i += 1) hiss[i] = random()

  // Around the tone it is mixed with, so the two read as one strike on one
  // piece of wood rather than as a click with hiss over it.
  biquad(hiss, { type: 'bandpass', hz: 2_200, q: 0.7 })
  levelled(hiss)

  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    const t = i / RATE
    out[i] = (hiss[i] * 0.5 + Math.sin(2 * Math.PI * 1_700 * t) * 0.5) * decay(t, 0.009)
  }
  return out
}

function cowbell() {
  const out = new Float32Array(seconds(0.2))
  // Two square tones, 540 and 800 Hz — the 808's pair, and its interval.
  const square = (hz, t) => Math.sign(Math.sin(2 * Math.PI * hz * t))
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    out[i] = square(540, t) * 0.5 + square(800, t) * 0.5
  }

  // **And the filter, which is the part that makes it a bell.** The pair alone
  // was written first and measured: two fundamentals at equal level with their
  // odd harmonics trailing off, which is a doorbell rather than a cowbell. What
  // is wanted is the hollow middle — so the fundamentals are pushed down and
  // the band around them is what is left, in two sections because one leaves
  // them where they were.
  biquad(out, { type: 'bandpass', hz: 2_600, q: 1.4 })
  biquad(out, { type: 'bandpass', hz: 2_600, q: 1.4 })

  for (let i = 0; i < out.length; i += 1) out[i] *= decay(i / RATE, 0.09)
  return out
}

/**
 * Bring the peak to just under full scale, then fade the tail to exactly zero.
 *
 * The fade is not cosmetic. A voice stops when it runs out of sample, with no
 * ramp of its own — the release ramp exists for a transport that stopped, not
 * for a sound that ended — so whatever value the last frame holds is a step to
 * silence, and a step is a click. Two milliseconds is below hearing as a change
 * of level and long enough to remove it.
 */
function finish(samples) {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  const gain = peak > 0 ? 0.95 / peak : 0

  const fade = Math.min(seconds(0.002), samples.length)
  const start = samples.length - fade
  for (let i = 0; i < samples.length; i += 1) {
    const taper = i < start ? 1 : (samples.length - 1 - i) / (fade - 1 || 1)
    samples[i] *= gain * taper
  }
  return samples
}

/** 16-bit PCM mono, which is all `decodeAudioData` needs and the smallest of it. */
function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + samples.length * 2, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(RATE, 24)
  bytes.writeUInt32LE(RATE * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    bytes.writeInt16LE(Math.round(clamped * 32_767), 44 + i * 2)
  }
  return bytes
}

// The order is the kit's order, and the kit's order is the track order: the
// page loads this list and slot `n` is track `n`. Changing it moves the sounds
// between the rows of the grid and nothing else.
const KIT = [
  ['kick', kick()],
  ['snare', snare()],
  ['hat-closed', hat(0.014, 0.05, 0x5eed_0001)],
  ['hat-open', hat(0.09, 0.25, 0x5eed_0002)],
  ['clap', clap()],
  ['tom', tom()],
  ['rim', rim()],
  ['cowbell', cowbell()],
]

mkdirSync(DESTINATION, { recursive: true })
for (const [name, samples] of KIT) {
  const file = join(DESTINATION, `${name}.wav`)
  const bytes = wav(finish(samples))
  writeFileSync(file, bytes)
  console.log(`${name}.wav — ${samples.length} frames, ${bytes.length} bytes`)
}
