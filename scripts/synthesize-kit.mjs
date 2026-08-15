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
  const out = new Float32Array(seconds(0.18))
  const random = noise(0x9e37_79b9)
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    out[i] =
      random() * decay(t, 0.045) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * decay(t, 0.07) * 0.5
  }
  return out
}

/** Both hats are one sound with two lengths, which is what they are on a kit. */
function hat(tau, length, seed) {
  const out = new Float32Array(seconds(length))
  const random = noise(seed)
  let previous = 0
  let highpass = 0
  for (let i = 0; i < out.length; i += 1) {
    const value = random()
    // One pole of high-pass, enough to take the body out of white noise and
    // leave the hiss. A cymbal is inharmonic partials; this is the cheap
    // version of that and sounds like one at this length.
    highpass = 0.85 * (highpass + value - previous)
    previous = value
    out[i] = highpass * decay(i / RATE, tau)
  }
  return out
}

function clap() {
  const out = new Float32Array(seconds(0.2))
  const random = noise(0x1234_5678)
  // Three bursts and a tail: one burst is a snare, and the gap between hands is
  // what a clap is.
  const bursts = [0, 0.009, 0.018]
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    let envelope = decay(Math.max(0, t - 0.026), 0.06) * 0.35
    for (const start of bursts) {
      if (t >= start) envelope = Math.max(envelope, decay(t - start, 0.006))
    }
    out[i] = random() * envelope
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
  const out = new Float32Array(seconds(0.06))
  const random = noise(0xcafe_babe)
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    out[i] =
      (random() * 0.5 + Math.sin(2 * Math.PI * 1_700 * t) * 0.5) * decay(t, 0.009)
  }
  return out
}

function cowbell() {
  const out = new Float32Array(seconds(0.2))
  // Two detuned square-ish tones, which is the whole trick behind the 808's.
  const square = (hz, t) => Math.sign(Math.sin(2 * Math.PI * hz * t))
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE
    out[i] = (square(540, t) * 0.5 + square(800, t) * 0.5) * decay(t, 0.09) * 0.6
  }
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
