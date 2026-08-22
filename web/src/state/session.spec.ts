// The page's state layer, which until it left App.svelte no test could reach at
// all: a component holds its state inside itself, and half of what is below is a
// failure path that needs an engine to fail on demand.
//
// Nothing here is simulated except the two things Node does not have — the
// bring-up and the frame clock — and both are parameters for exactly that
// reason. The rig at the bottom is local to this file: it has one consumer, and
// a fake with one consumer belongs beside it.

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { READOUT_INTERVAL_MS, createSession } from './session.svelte'
import type { FrameLoop, IntervalLoop, KitFetch } from './session.svelte'
import type { EngineEvents, EngineHandle, StartFailure } from '../audio/host'
import { KitUnreachable, describeKitFailure } from '../audio/kit'
import type { KitFailure } from '../audio/kit'
import { STEPS, TRACKS } from '../audio/protocol'
import type { Command } from '../audio/protocol'
import type { Telemetry } from '../audio/telemetry'
import type { KitSample, WorkletMessage } from '../audio/worklet-messages'

/** Not 48000, and not 3: numbers the engine reports are not numbers the page knows. */
const SAMPLE_RATE = 44_100
const PROTOCOL_VERSION = 7

/**
 * What a start installs before anything else, in order, with the page holding
 * nothing but its defaults.
 *
 * Written out here because more than one test is about what follows it, and a
 * list repeated at each of them is a list that will be updated at some of them.
 * `clear-pattern` is the head of the pattern rather than a fourth setting: the
 * pattern goes over on every start, and an empty one is exactly that one record.
 */
const SETTINGS: readonly Command[] = [
  { op: 'set-bpm', bpm: 120 },
  { op: 'set-metronome', enabled: true },
  { op: 'set-master-gain', gain: 1 },
  { op: 'clear-pattern' },
]

describe('createSession', () => {
  it('starts idle, driving nothing', () => {
    const { session } = rig()

    expect(session.status).toBe('idle')
    expect(session.failure).toBeNull()
    expect(session.sampleRate).toBeNull()
    expect(session.protocolVersion).toBeNull()
  })

  it('reports a start in flight before it reports an engine', async () => {
    // The button reads this to disable itself. A status that only moved on
    // success would leave it live through the whole of `addModule`.
    const held = rig({ hold: true })

    const starting = held.session.start()
    expect(held.session.status).toBe('starting')

    held.release()
    await starting
    expect(held.session.status).toBe('running')
  })

  it('carries the engine’s own numbers rather than the page’s assumptions', async () => {
    // The context settles on a rate of its own choosing and the version came out
    // of the compiled wasm. Both are readings, not constants, which is why they
    // are null until there is something to read them from.
    const { session } = rig()
    await session.start()

    expect(session.sampleRate).toBe(SAMPLE_RATE)
    expect(session.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('describes a start that failed, and can be started again after one', async () => {
    // Every failure presents on the page as no sound, so the description is the
    // whole of what the user gets. Staying startable is the other half: a page
    // that reports a dead engine and takes the button away leaves a reload as
    // the only move.
    const harness = rig()
    harness.failNext({ kind: 'processor-silent', ms: 5000 })

    await harness.session.start()
    expect(harness.session.status).toBe('failed')
    expect(harness.session.failure).toContain('5000 ms')

    await harness.session.start()
    expect(harness.session.status).toBe('running')
    expect(harness.session.failure).toBeNull()
  })

  it('does not close a context that a failed start has already closed', async () => {
    // `startEngine` releases the context on its own way out — that is the one
    // shape `acquireRelease` does not give you, and it is argued in host.ts.
    // Closing again here would be this file assuming a failed start left
    // something behind.
    const harness = rig()
    harness.failNext({ kind: 'context-suspended', state: 'suspended' })

    await harness.session.start()
    expect(harness.closes()).toBe(0)
  })

  it('reads telemetry once a frame, and holds the last reading when the writer was mid-publish', async () => {
    // A null reading is the seqlock refusing, not an error. Zeroing the display
    // on it would make the meters flicker against a perfectly healthy engine.
    const harness = rig()
    await harness.session.start()

    harness.publish({ position: 4096, peakL: 0.5, peakR: 0.25, step: 2.75 })
    harness.frame()
    expect(harness.session.position).toBe(4096)
    expect(harness.session.step).toBe(2.75)

    harness.publish(null)
    harness.frame()
    expect(harness.session.position).toBe(4096)
    expect(harness.session.peakL).toBe(0.5)
    expect(harness.session.step).toBe(2.75)
  })

  it('hands every reading to whoever is drawing, whatever the readouts are doing', async () => {
    // The whole reason `onFrame` exists. The playhead has to move on every frame
    // and nothing on the page may: a field written sixty times a second wakes
    // the reactive graph sixty times a second, and behind it a paint of
    // everything downstream — which is the cost `READOUT_INTERVAL_MS` was
    // measured against.
    const harness = rig()
    await harness.start()
    const drawn: number[] = []
    harness.session.onFrame((reading) => drawn.push(reading.step))

    for (const [at, step] of [
      [0, 1],
      [16, 2],
      [32, 3],
    ]) {
      harness.publish({ position: 0, peakL: 0, peakR: 0, step })
      harness.frame(at)
    }

    expect(drawn).toEqual([1, 2, 3])
    // Three frames inside one interval, and the readout moved once — for the
    // first of them, because a page that showed nothing until the interval had
    // passed would open blank.
    expect(harness.session.step).toBe(1)
  })

  it('stops handing readings to a listener that let go', async () => {
    const harness = rig()
    await harness.start()
    const drawn: number[] = []
    const stop = harness.session.onFrame((reading) => drawn.push(reading.step))

    harness.frame()
    stop()
    harness.frame()

    expect(drawn).toHaveLength(1)
  })

  it('lets the readouts move again once the interval has passed', async () => {
    // A threshold guard, so the fixtures have to straddle the threshold: one
    // that only ever sat on the far side of it would pass with the throttle
    // removed and pass exactly as green.
    expect(50).toBeLessThan(READOUT_INTERVAL_MS)
    expect(100).toBeGreaterThanOrEqual(READOUT_INTERVAL_MS)

    const harness = rig()
    await harness.start()

    harness.publish({ position: 1, peakL: 0, peakR: 0, step: 0 })
    harness.frame(0)
    harness.publish({ position: 2, peakL: 0, peakR: 0, step: 0 })
    harness.frame(50)
    expect(harness.session.position).toBe(1)

    harness.publish({ position: 3, peakL: 0, peakR: 0, step: 0 })
    harness.frame(100)
    expect(harness.session.position).toBe(3)
  })

  it('gives the device back on stop, and stops reading with it', async () => {
    // The substantive half of stopping. A handle merely dropped leaves the node
    // rendering into `destination` with nothing left holding a reference that
    // could stop it: the page goes quiet and the metronome does not.
    const harness = rig()
    await harness.session.start()
    expect(harness.reading()).toBe(true)

    harness.session.stop()

    expect(harness.closes()).toBe(1)
    expect(harness.reading(), 'the frame loop outlived the engine').toBe(false)
    expect(harness.session.status).toBe('idle')
    expect(harness.session.failure).toBeNull()
  })

  it('closes the context when the audio thread dies under it', async () => {
    // A crash takes the worklet and leaves the device open, so the teardown
    // has to come from this side — a dead engine still holding an output is
    // the one failure the page can neither hear nor see.
    const harness = rig()
    await harness.session.start()

    harness.crash()

    expect(harness.session.status).toBe('failed')
    expect(harness.session.failure).toContain('panic')
    expect(harness.closes()).toBe(1)
    expect(harness.reading()).toBe(false)
  })

  it('refuses a second start while the first is still in flight', async () => {
    // `disabled` on the button reaches the DOM a task later than a second click
    // can arrive, and two starts are two contexts — both connected, both
    // rendering, and only one of them reachable afterwards.
    const harness = rig({ hold: true })

    const first = harness.session.start()
    const second = harness.session.start()
    expect(harness.starts()).toBe(1)

    harness.release()
    await Promise.all([first, second])
    expect(harness.starts()).toBe(1)
  })

  it('refuses a start while an engine is already running', async () => {
    const harness = rig()
    await harness.session.start()

    await harness.session.start()

    expect(harness.starts()).toBe(1)
  })

  it('sends play and stop, and believes only what was accepted', async () => {
    const harness = rig()
    await harness.session.start()

    harness.session.toggle()
    expect(harness.session.playing).toBe(true)
    harness.session.toggle()
    expect(harness.session.playing).toBe(false)

    expect(harness.sent()).toEqual([
      ...SETTINGS, // installed by the start above
      { op: 'play' },
      { op: 'stop' },
    ])
  })

  it('sends the tempo of every step of a drag', async () => {
    // Not on release: a change that only lands when the pointer comes up cannot
    // show whether the change itself was seamless, which is what is being tested
    // by dragging it.
    const harness = rig()
    await harness.session.start()

    for (const bpm of [121, 122, 123]) harness.session.setBpm(bpm)

    expect(harness.session.bpm).toBe(123)
    expect(harness.sent()).toEqual([
      ...SETTINGS,
      { op: 'set-bpm', bpm: 121 },
      { op: 'set-bpm', bpm: 122 },
      { op: 'set-bpm', bpm: 123 },
    ])
  })

  it('tells a new engine the settings the page is already showing', async () => {
    // The engine comes up at defaults of its own, and the page comes up showing
    // them. Leaving those to agree is leaving the display to be wrong in
    // silence: nothing reads either back, so a divergence would show up as a
    // metronome that does not match the readout and nowhere else.
    //
    // Every setting, not the tempo alone — which is what makes this assertion an
    // equality rather than a `toContainEqual`. A control added to the page and
    // left out of this list is one the engine is never told about.
    const harness = rig()

    await harness.session.start()

    expect(harness.sent()).toEqual(SETTINGS)
  })

  it('carries the tempo across a restart, and tells the second engine about it', async () => {
    // The page holds the setting and hands it to whatever engine it has, which
    // is the whole reason it no longer has to reset the tempo when one goes
    // away. The transport is the other kind and does not survive: an engine that
    // has never been told to play is not playing.
    const harness = rig()
    await harness.session.start()
    harness.session.setBpm(174)
    harness.session.toggle()

    harness.session.stop()
    await harness.session.start()

    expect(harness.session.bpm).toBe(174)
    expect(harness.session.playing).toBe(false)
    expect(harness.sent().slice(-SETTINGS.length)).toEqual([
      { op: 'set-bpm', bpm: 174 },
      { op: 'set-metronome', enabled: true },
      { op: 'set-master-gain', gain: 1 },
      { op: 'clear-pattern' },
    ])
  })

  it('does not move the transport it failed to send', async () => {
    // The belief and the command are one gesture. A page that flipped to
    // "playing" on a command that never arrived would show a transport running
    // against silence, with nothing to say which of the two was wrong.
    const harness = rig()
    await harness.session.start()
    harness.refuse()

    harness.session.toggle()

    expect(harness.session.playing).toBe(false)
  })

  it('keeps driving the engine when the ring refuses a command', async () => {
    // A full ring says a command did not fit and nothing about why. Treating it
    // as the engine being gone was right only while the sole way to fill the
    // ring was the far end having stopped — and it would tear down a working
    // engine the first time a project pushes hundreds of parameters at once.
    const harness = rig()
    await harness.session.start()
    harness.refuse()

    harness.session.toggle()

    expect(harness.session.status).toBe('running')
    expect(harness.session.failure).toBeNull()
    expect(harness.closes()).toBe(0)
  })

  it('counts every command the ring refused, and says so out loud', async () => {
    // The one thing a drop must never do is pile up quietly. The count comes
    // back from the ring rather than being tallied here, so it is one number
    // and not two that agree today.
    const harness = rig()
    await harness.session.start()
    expect(harness.session.dropped).toBe(0)

    harness.refuse()
    harness.session.toggle()
    harness.session.setBpm(174)

    expect(harness.session.dropped).toBe(2)
  })

  it('does not adopt a tempo the ring refused', async () => {
    // The same rule the transport follows, and for the same reason: a readout
    // showing 174 against an engine playing 120 is a divergence with nothing on
    // screen to explain it, and the two would never come back together.
    const harness = rig()
    await harness.session.start()
    harness.session.setBpm(174)
    harness.refuse()

    harness.session.setBpm(200)

    expect(harness.session.bpm).toBe(174)
  })

  it('forgets what belonged to the engine it gave up', async () => {
    // Two beliefs about a thread that no longer exists. Carried over, the first
    // would offer to stop a transport that never ran, and the second would show
    // drops against a ring that has not lost anything.
    const harness = rig()
    await harness.session.start()
    harness.session.toggle()
    harness.refuse()
    harness.session.toggle()
    expect(harness.session.playing).toBe(true)
    expect(harness.session.dropped).toBe(1)

    harness.session.stop()
    harness.accept()
    await harness.session.start()

    expect(harness.session.playing).toBe(false)
    expect(harness.session.dropped).toBe(0)
  })

  it('reports the size of the first block the processor rendered', async () => {
    // The one number the native suite cannot observe: Web Audio specifies 128
    // and the page holds the reported value against it.
    const harness = rig()
    await harness.session.start()

    harness.post({ type: 'first-quantum', frames: 128 })

    expect(harness.session.quantum).toBe(128)
  })

  it('tells the engine what the metronome is set to, rather than assuming', async () => {
    // The same rule the tempo follows: two defaults agreeing is not agreement,
    // and the one on screen is the one that can be wrong in silence.
    const harness = rig()

    await harness.start()

    expect(harness.sent()).toContainEqual({ op: 'set-metronome', enabled: true })
  })

  it('keeps the switch on screen in step with the command that moved it', async () => {
    const harness = rig()
    await harness.start()

    harness.session.setMetronome(false)
    expect(harness.session.metronome).toBe(false)

    // A command the ring had no room for leaves the belief where it was, or the
    // page would show a click it never turned off.
    harness.refuse()
    harness.session.setMetronome(true)
    expect(harness.session.metronome).toBe(false)
  })

  it('keeps the master level in step with the command that moved it', async () => {
    const harness = rig()
    await harness.start()

    harness.session.setMasterGain(0.25)
    expect(harness.session.masterGain).toBe(0.25)
    expect(harness.sent()).toContainEqual({ op: 'set-master-gain', gain: 0.25 })

    // The same rule the tempo follows: a readout showing a level the engine was
    // never told is a divergence with nothing on screen to explain it.
    harness.refuse()
    harness.session.setMasterGain(1)
    expect(harness.session.masterGain).toBe(0.25)
  })

  it('strikes a cell at full velocity and clears it with none', async () => {
    // A cell is its velocity and zero is off, which is what makes these two the
    // same command twice rather than a command and its opposite.
    const harness = rig()
    await harness.start()

    harness.session.setStep(3, 5, true)
    expect(harness.session.isStepOn(3, 5)).toBe(true)
    harness.session.setStep(3, 5, false)
    expect(harness.session.isStepOn(3, 5)).toBe(false)

    expect(harness.sent().slice(SETTINGS.length)).toEqual([
      { op: 'set-step', track: 3, step: 5, velocity: 1 },
      { op: 'set-step', track: 3, step: 5, velocity: 0 },
    ])
  })

  it('does not light a cell the ring refused', async () => {
    // The same gesture-and-belief rule the transport follows. A grid showing a
    // cell the engine never took would go on showing it, silently, for as long
    // as the pattern lived.
    const harness = rig()
    await harness.start()
    harness.refuse()

    harness.session.setStep(0, 0, true)

    expect(harness.session.isStepOn(0, 0)).toBe(false)
  })

  it('keeps a cell outside the grid out of both the engine and the page', async () => {
    // Unreachable from a grid built on TRACKS and STEPS, and guarded anyway
    // because the two ways out of range fail differently on this side and
    // neither failure is the engine's to catch — see `inGrid`.
    const harness = rig()
    await harness.start()
    const settled = harness.sent().length

    harness.session.setStep(TRACKS, 0, true)
    harness.session.setStep(0, STEPS, true)
    harness.session.setStep(-1, 0, true)
    harness.session.setStep(0.5, 0, true)

    expect(harness.sent()).toHaveLength(settled)
    expect(harness.session.isStepOn(TRACKS, 0)).toBe(false)
  })

  it('empties the grid with one record rather than a hundred and twenty-eight', async () => {
    // Which is what the opcode is for: clearing by hand would be a burst larger
    // than the exchange area the engine drains in a quantum, sent to say
    // something one byte already says.
    const harness = rig()
    await harness.start()
    harness.session.setStep(0, 0, true)
    harness.session.setStep(7, 15, true)
    const settled = harness.sent().length

    harness.session.clearPattern()

    expect(harness.session.isStepOn(0, 0)).toBe(false)
    expect(harness.session.isStepOn(7, 15)).toBe(false)
    expect(harness.sent().slice(settled)).toEqual([{ op: 'clear-pattern' }])
  })

  it('does not empty a grid the ring refused to clear', async () => {
    const harness = rig()
    await harness.start()
    harness.session.setStep(0, 0, true)
    harness.refuse()

    harness.session.clearPattern()

    expect(harness.session.isStepOn(0, 0)).toBe(true)
  })

  it('tells a new engine the pattern the page is already showing', async () => {
    // The pattern is a setting the page holds, like the tempo, so it outlives
    // the engine it was set on. Worth its own test because the sending is bulk —
    // the first here — and because until a project can be opened, restarting is
    // the only way this path is ever taken with something in it.
    const harness = rig()
    await harness.start()
    harness.session.setStep(1, 2, true)
    harness.session.setStep(6, 15, true)

    harness.session.stop()
    await harness.start()

    expect(harness.session.isStepOn(1, 2)).toBe(true)
    expect(harness.sent().slice(-SETTINGS.length - 2)).toEqual([
      ...SETTINGS,
      { op: 'set-step', track: 1, step: 2, velocity: 1 },
      { op: 'set-step', track: 6, step: 15, velocity: 1 },
    ])
  })

  it('strikes a pad without remembering anything about it', async () => {
    const harness = rig()
    await harness.start()

    harness.session.trigger(3)

    expect(harness.sent()).toContainEqual({ op: 'trigger-track', track: 3, velocity: 1 })
  })

  it('hands the kit over as soon as there is an engine to hand it to', async () => {
    const harness = rig()

    await harness.start()

    expect(harness.handed()).toHaveLength(1)
    // Still loading: the page has parted with the samples, which is not the same
    // as the engine having taken them.
    expect(harness.session.kit).toBe('loading')
  })

  it('is loaded when the audio thread says it is', async () => {
    const harness = rig()
    await harness.start()

    harness.post({ type: 'kit-loaded', slots: 8, floats: 1_024, bytes: 2 ** 20 })

    expect(harness.session.kit).toBe('loaded')
    expect(harness.session.kitFailure).toBeNull()
  })

  it('shows what the audio thread refused a kit for', async () => {
    const harness = rig()
    await harness.start()

    harness.post({ type: 'kit-refused', message: 'the engine would not reserve 12 values' })

    expect(harness.session.kit).toBe('failed')
    expect(harness.session.kitFailure).toBe('the engine would not reserve 12 values')
  })

  it('shows a kit that never got as far as the audio thread', async () => {
    const harness = rig()
    const failure: KitFailure = new KitUnreachable({ url: '/kit/kick.wav', detail: '404' })
    harness.refuseKit(failure)

    await harness.start()

    expect(harness.session.kit).toBe('failed')
    expect(harness.session.kitFailure).toBe(describeKitFailure(failure))
    expect(harness.handed(), 'a kit that never loaded was sent anyway').toHaveLength(0)
  })

  it('keeps the engine when the kit will not load', async () => {
    // A kit is a reading, not the session: the transport still moves and the
    // metronome still sounds, so tearing the engine down over it would take away
    // more than was lost.
    const harness = rig()
    harness.refuseKit(new KitUnreachable({ url: '/kit/kick.wav', detail: '404' }))

    await harness.start()

    expect(harness.session.status).toBe('running')
    expect(harness.session.failure).toBeNull()
  })

  it('does not report a kit that outlived the engine it was fetched for', async () => {
    // The window is real: a fetch and a decode take long enough for the stop
    // button to be pressed inside them, and what comes back then is a reading
    // about an engine that no longer exists — over fields `discard` has cleared.
    const harness = rig({ holdKit: true })
    await harness.session.start()
    expect(harness.session.kit).toBe('loading')

    harness.session.stop()
    harness.releaseKit()
    await harness.settle()

    expect(harness.session.kit).toBe('none')
    expect(harness.handed(), 'a kit reached an engine that was given back').toHaveLength(0)
  })

  it('forgets the kit when the engine is given back', async () => {
    const harness = rig()
    await harness.start()
    harness.post({ type: 'kit-loaded', slots: 8, floats: 1_024, bytes: 2 ** 20 })

    harness.session.stop()

    expect(harness.session.kit).toBe('none')
    expect(harness.session.kitFailure).toBeNull()
    expect(harness.session.kitBytes, 'a size belonging to a dead engine').toBeNull()
  })

  it('takes the linear memory reading off the load that reported it', async () => {
    const harness = rig()
    await harness.start()

    harness.post({ type: 'kit-loaded', slots: 8, floats: 1_024, bytes: 3 * 2 ** 20 })

    expect(harness.session.kitBytes).toBe(3 * 2 ** 20)
  })

  it('fetches and hands over the kit again when asked to reload', async () => {
    // The verb exists to make the number above move: a load is the only event
    // that can grow linear memory, so one reading proves nothing and the
    // question is only ever asked of a series.
    const harness = rig()
    await harness.start()
    expect(harness.handed()).toHaveLength(1)
    // The first load has to have been answered before a second is accepted:
    // `loading` covers the wait for the answer, and the answer is where the
    // size comes from.
    harness.post({ type: 'kit-loaded', slots: 8, floats: 1_024, bytes: 2 ** 20 })

    harness.session.reloadKit()
    await harness.settle()

    expect(harness.handed()).toHaveLength(2)
    expect(harness.session.kit).toBe('loading')

    harness.post({ type: 'kit-loaded', slots: 8, floats: 1_024, bytes: 2 ** 20 })

    expect(harness.session.kitBytes, 'a second load of the same kit grew linear memory').toBe(
      2 ** 20,
    )
  })

  it('will not reload before the first load has been answered', async () => {
    // The window is not the fetch — that is the test below — but the wait for
    // the worklet, which is where the size comes from. A press inside it would
    // report two loads nobody can tell apart.
    const harness = rig()
    await harness.start()

    harness.session.reloadKit()
    await harness.settle()

    expect(harness.handed()).toHaveLength(1)
  })

  it('refuses a reload while one is already in flight', async () => {
    // Two reservations racing would leave the second writing into an arena the
    // first has already replaced. The same reason `start` refuses a second
    // start, and unlike that one this button stays live while it happens.
    const harness = rig({ holdKit: true })
    await harness.session.start()

    harness.session.reloadKit()
    harness.session.reloadKit()
    harness.releaseKit()
    await harness.settle()

    expect(harness.handed()).toHaveLength(1)
  })

  it('has nothing to reload when there is no engine', () => {
    // Reachable through this module's surface rather than through a template
    // that hides the button, and it must not be the failure `send` reports:
    // nothing was asked of an engine, so there is nothing to give up over.
    const harness = rig()

    harness.session.reloadKit()

    expect(harness.session.status).toBe('idle')
    expect(harness.session.failure).toBeNull()
  })

  it('samples the render drift on a clock the frame loop does not stop', async () => {
    // The whole point of the second loop. A hidden tab stops delivering frames
    // long before it stops rendering audio, so the reading that says whether
    // the audio thread is well has to arrive without one.
    const harness = rig()
    await harness.start()

    expect(harness.sampling()).toBe(true)

    // One reading is a count; the difference between two is the measurement.
    harness.interval(0)
    expect(harness.session.driftMsPerSecond).toBeNull()

    // A second of wall clock against a second of audio at 44 100.
    harness.render(SAMPLE_RATE)
    harness.interval(1_000)
    expect(harness.session.driftMsPerSecond).toBe(0)
  })

  it('reports the thread falling behind the wall clock', async () => {
    const harness = rig()
    await harness.start()

    harness.interval(0)
    // Half a second of audio for a second of clock: 500 ms lost.
    harness.render(SAMPLE_RATE / 2)
    harness.interval(1_000)

    expect(harness.session.driftMsPerSecond).toBeCloseTo(500, 6)
  })

  it('keeps the last drift it managed to take', async () => {
    // A window with no time in it describes nothing, and a zero published there
    // would read as a healthy engine. The previous number stands, exactly as the
    // readouts stand through a refused telemetry read.
    const harness = rig()
    await harness.start()

    harness.interval(0)
    harness.render(SAMPLE_RATE / 2)
    harness.interval(1_000)
    harness.interval(1_000)

    expect(harness.session.driftMsPerSecond).toBeCloseTo(500, 6)
  })

  it('measures across the window, and lets a bad second walk out of it', async () => {
    // Why a published reading spans eight samples and not the last two. At one
    // second the counter's own step is worth ±2.7 ms/s on a healthy engine, and
    // the page showed exactly that, alternating sign every window; the argument
    // is at `DRIFT_WINDOW`. This is what the fix costs, and the width is
    // written here as a literal on purpose — a test reading the constant would
    // agree with whatever it said.
    const WINDOW = 8
    const harness = rig()
    await harness.start()

    let now = 0
    const second = (frames: number): void => {
      harness.render(frames)
      now += 1_000
      harness.interval(now)
    }

    harness.interval(now)
    for (let i = 0; i < WINDOW; i += 1) second(SAMPLE_RATE)
    expect(harness.session.driftMsPerSecond).toBeCloseTo(0, 6)

    // Half a second of audio for a second of clock, once. Reported diluted:
    // 500 ms spread over the eight seconds the window covers.
    second(SAMPLE_RATE / 2)
    expect(harness.session.driftMsPerSecond).toBeCloseTo(62.5, 6)

    for (let i = 0; i < WINDOW - 1; i += 1) second(SAMPLE_RATE)
    expect(harness.session.driftMsPerSecond, 'still under the window').toBeCloseTo(62.5, 6)

    second(SAMPLE_RATE)
    expect(harness.session.driftMsPerSecond, 'the window walked past it').toBeCloseTo(0, 6)
  })

  it('does not carry a drift across two engines', async () => {
    // The counter belongs to a processor that is gone, and the next one starts
    // from zero — so a sample straddling the two reports the whole of the first
    // engine's run as time the second lost. Silent, enormous, and once.
    const harness = rig()
    await harness.start()
    harness.interval(0)
    harness.render(SAMPLE_RATE)
    harness.interval(1_000)
    expect(harness.session.driftMsPerSecond).toBe(0)

    harness.session.stop()
    expect(
      harness.session.driftMsPerSecond,
      'a reading about an engine that is gone',
    ).toBeNull()
    expect(harness.sampling(), 'the sampler outlived the engine it was sampling').toBe(false)

    harness.rendered(0)
    await harness.start()
    harness.interval(10_000)

    expect(
      harness.session.driftMsPerSecond,
      'the first engine was billed to the second',
    ).toBeNull()
  })

  it('counts the samples it took, and the longest it went without one', async () => {
    const harness = rig()
    await harness.start()

    harness.interval(0)
    expect(harness.session.driftSamples).toBe(1)
    // One sample is no interval: a gap is the distance between two of them.
    expect(harness.session.driftMaxGapMs).toBeNull()
    expect(harness.session.driftSpanMs).toBe(0)

    harness.interval(1_000)
    harness.interval(1_500)

    expect(harness.session.driftSamples).toBe(3)
    // The widest and not the latest, because the interval worth knowing about
    // passed while the page could not be seen.
    expect(harness.session.driftMaxGapMs).toBe(1_000)
    // From the first sample and not from the oldest one still in the window,
    // which walks forward and would report a span that shrinks.
    expect(harness.session.driftSpanMs).toBe(1_500)
  })

  it('measures a clock that was slowed rather than stopped', async () => {
    // The case the count alone cannot report and the gap alone calls innocent:
    // every interval twice what was asked for, none of them alarming, and half
    // the samples never taken. Only the two numbers together say so — 6 over
    // ten seconds, against the ten that one a second would have given.
    const harness = rig()
    await harness.start()

    for (let i = 0; i <= 10_000; i += 2_000) harness.interval(i)

    expect(harness.session.driftSamples).toBe(6)
    expect(harness.session.driftSpanMs).toBe(10_000)
    expect(harness.session.driftMaxGapMs).toBe(2_000)
  })

  it('shows a sampler that slept, which the drift beside it cannot', async () => {
    // Why the two numbers above exist at all. A hidden tab goes on rendering
    // and the frame counter runs free, so ten minutes sampled once a second and
    // one sample taken on waking with the tab publish the same reading — and it
    // is the correct reading both times. Only the gap differs.
    const harness = rig()
    await harness.start()

    harness.interval(0)
    harness.render(SAMPLE_RATE * 600)
    harness.interval(600_000)

    expect(harness.session.driftMsPerSecond, 'ten well minutes, and it says so').toBeCloseTo(
      0,
      6,
    )
    expect(harness.session.driftSamples).toBe(2)
    expect(harness.session.driftMaxGapMs).toBe(600_000)
    expect(harness.session.driftSpanMs).toBe(600_000)
  })

  it('starts the sampler tally over with the next engine', async () => {
    // The same rule as the drift itself: a gap measured across a restart is a
    // stretch during which nothing was owed, and the count is about a processor
    // that no longer exists.
    const harness = rig()
    await harness.start()
    harness.interval(0)
    harness.interval(1_000)
    expect(harness.session.driftSamples).toBe(2)

    harness.session.stop()
    expect(harness.session.driftSamples).toBe(0)
    expect(harness.session.driftMaxGapMs).toBeNull()
    expect(harness.session.driftSpanMs).toBe(0)

    harness.rendered(0)
    await harness.start()
    harness.interval(60_000)

    expect(harness.session.driftSamples).toBe(1)
    expect(harness.session.driftMaxGapMs, 'a gap billed across the restart').toBeNull()
    // The span counts from this engine's first sample, not from a clock that
    // has been running since the page loaded.
    expect(harness.session.driftSpanMs).toBe(0)
  })
})

/**
 * A session driven by a fake bring-up and a hand-cranked frame clock.
 *
 * `hold` keeps the start pending until `release`, which is the only way to
 * observe the window a second click can arrive in.
 */
function rig(options: { hold?: boolean; holdKit?: boolean } = {}) {
  let closes = 0
  let starts = 0
  let refusals = 0
  let accept = true
  let reading: Telemetry | null = { position: 0, peakL: 0, peakR: 0, step: 0 }
  let failure: StartFailure | null = null
  let events: EngineEvents = {}
  let tick: ((now: number) => void) | null = null
  // The free-running counter, cranked by `render` below. A number here and not
  // a derived one: what the drift measurement is about is the counter and the
  // clock disagreeing, so a fake that computed one from the other could not
  // express the case worth testing.
  let renderedFrames = 0
  let slowTick: ((now: number) => void) | null = null
  const sent: Command[] = []

  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve()
    }
  })

  const handle: EngineHandle = {
    context: {
      close: () => {
        closes += 1
        return Promise.resolve()
      },
    } as unknown as AudioContext,
    node: {} as unknown as AudioWorkletNode,
    sampleRate: SAMPLE_RATE,
    protocolVersion: PROTOCOL_VERSION,
    commands: {
      // Counting its own refusals, the way `createWriter` does: the number the
      // session reads back has to come from the same place that made it, or the
      // test would be agreeing with the session about a count neither took from
      // the ring.
      send: (command: Command) => {
        if (!accept) {
          refusals += 1
          return false
        }
        sent.push(command)
        return true
      },
      dropped: () => refusals,
    },
    telemetry: { read: () => reading, rendered: () => renderedFrames },
    loadKit: (samples) => {
      handed.push(samples)
    },
  }

  /** One sample, standing in for a decoded file. Its contents are never read. */
  const KIT: readonly KitSample[] = [{ data: new Float32Array([1, 0]), channels: 1 }]
  const handed: (readonly KitSample[])[] = []
  // An Effect rather than a value the fake resolves to, because that is the
  // currency `KitFetch` is in now — a promise-returning fake would be testing
  // the session against a shape nothing else hands it.
  let kitEffect: Effect.Effect<readonly KitSample[], KitFailure> = Effect.succeed(KIT)

  let releaseKit = (): void => undefined
  const heldKit = new Promise<void>((resolve) => {
    releaseKit = () => {
      resolve()
    }
  })

  const kit: KitFetch = () =>
    Effect.gen(function* () {
      if (options.holdKit === true) yield* Effect.promise(() => heldKit)
      return yield* kitEffect
    })

  const frames: FrameLoop = (run) => {
    tick = run
    return () => {
      tick = null
    }
  }

  const intervals: IntervalLoop = (run) => {
    slowTick = run
    return () => {
      slowTick = null
    }
  }

  // What `requestAnimationFrame` would be handing the loop. Advanced by a
  // second whenever a test does not care, so that `frame()` keeps meaning what
  // it meant before there was a throttle: a frame late enough to matter.
  let clock = 0

  const session = createSession({
    frames,
    intervals,
    kit,
    start: async (given: EngineEvents = {}) => {
      starts += 1
      events = given
      if (options.hold === true) await held
      // Consumed, so that `failNext` names one start rather than every one after
      // it — the retry after a failure is a case worth being able to write.
      const refusal = failure
      failure = null
      return refusal === null ? { ok: true, value: handle } : { ok: false, error: refusal }
    },
  })

  return {
    session,
    release: (): void => {
      release()
    },
    starts: () => starts,
    closes: () => closes,
    sent: () => sent,
    /** Whether the frame loop is running. */
    reading: () => tick !== null,
    frame: (now?: number): void => {
      if (tick === null) throw new Error('no frame loop is running')
      if (now === undefined) clock += 1_000
      tick(now ?? clock)
    },
    publish: (next: Telemetry | null): void => {
      reading = next
    },
    /** Whether the drift sampler is running. */
    sampling: () => slowTick !== null,
    /** Pretend the audio thread rendered this many frames. */
    render: (count: number): void => {
      renderedFrames = (renderedFrames + count) >>> 0
    },
    /** Put the counter exactly here, for the wrap. */
    rendered: (count: number): void => {
      renderedFrames = count
    },
    /** Fire the slow loop at a stated wall-clock time, in milliseconds. */
    interval: (now: number): void => {
      if (slowTick === null) throw new Error('no drift sampler is running')
      slowTick(now)
    },
    refuse: (): void => {
      accept = false
    },
    accept: (): void => {
      accept = true
    },
    failNext: (next: StartFailure): void => {
      failure = next
    },
    crash: (): void => events.onCrash?.(),
    post: (message: WorkletMessage): void => events.onMessage?.(message),
    /** What was handed to the audio thread, in the order it was handed over. */
    handed: () => handed,
    releaseKit: (): void => {
      releaseKit()
    },
    refuseKit: (failure: KitFailure): void => {
      kitEffect = Effect.fail(failure)
    },
    settle,
    /**
     * Start, and let the kit that follows catch up — which is what a test wants
     * unless the point of it is the window between the two.
     */
    start: async (): Promise<void> => {
      await session.start()
      await settle()
    },
  }
}

/**
 * Let the kit's promise chain run out.
 *
 * `start` deliberately does not await the load — the engine runs before the kit
 * arrives — so from a test the load is a couple of microtasks behind the call
 * that began it. Two turns is what the chain takes; counting them is grim, and
 * the alternative is a timer, which is a race written as a delay.
 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
