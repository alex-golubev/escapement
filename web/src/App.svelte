<script lang="ts">
  import { describeStartFailure, startEngine } from './audio/host'
  import type { EngineHandle } from './audio/host'
  import type { Command } from './audio/protocol'
  import type { WorkletMessage } from './audio/worklet-messages'

  // The readiness criterion for this milestone, checked on the page instead of
  // in devtools. Without cross-origin isolation there is no
  // `SharedArrayBuffer`, and without that there is no UI -> audio link at all.
  // The failure has to be legible on sight; diagnosed later, from a metronome
  // that simply never sounds, it costs an evening.

  // Deliberately plain constants rather than `$state`: both are settled before
  // the first paint and never change afterward. Reactivity that nothing needs
  // is still something to read past later.
  const isolated = crossOriginIsolated

  // The flag alone does not prove the constructor is reachable, so probe the
  // thing we will actually be using.
  const sabError = probeSharedArrayBuffer()
  const isolationReady = isolated && sabError === null

  function probeSharedArrayBuffer(): string | null {
    try {
      new SharedArrayBuffer(1024)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  // These do move, so they are state. The contrast with the two constants above
  // is the entire rule: reactivity where a value changes, nothing where it does
  // not.
  type Status = 'idle' | 'starting' | 'running' | 'failed'

  /**
   * Everything a successful start produced, in one holder — and the only thing
   * that says whether the page is driving a live engine. Non-null exactly while
   * it is: both failure paths go through `fail` below, which is what keeps that
   * true.
   *
   * One holder rather than a field apiece, because separate fields have to be
   * assigned in an order that nothing enforces. The frame loop below used to
   * wake on `status` while reading the reader out of a plain `let`, so it worked
   * only as long as the reader was assigned first — and swapping two lines in
   * `start` would have stopped the loop for good, with the numbers frozen at
   * zero and neither the compiler nor a test noticing.
   *
   * `$state.raw` and not `$state`: Svelte proxies plain-object state, and this is
   * a plain object holding two more, so `commands.send` on every step of a fader
   * drag and `telemetry.read` on every frame would go through two proxy layers.
   * Nothing mutates the handle — it is replaced whole, which is what raw means.
   *
   * Reactive at all because a reactive scope reads it. That is the rule the two
   * plain `let`s it replaces got half right: what a reactive scope reads has to
   * be reactive, what an event handler reads does not.
   */
  let engine = $state.raw<EngineHandle | null>(null)

  let starting = $state(false)
  let failure = $state<string | null>(null)
  let quantum = $state<number | null>(null)

  /**
   * Derived, so it cannot disagree with the holder above. Kept as its own name
   * because the template asks four questions of it and `engine !== null` answers
   * only one of them — but computed, because a `status` assigned by hand beside
   * `engine` would be the same ordering trap one level up.
   */
  const status: Status = $derived(
    failure !== null ? 'failed' : engine !== null ? 'running' : starting ? 'starting' : 'idle',
  )

  // The transport as the page believes it to be. Believes, and does not know:
  // the engine holds the truth, and until telemetry is read back this is an
  // open loop. It is honest for one button that only ever moves on a click.
  let playing = $state(false)
  let bpm = $state(120) // DEFAULT_BPM in transport.rs; the engine starts here too

  // What the engine says about itself. Unlike `playing` above, these are not
  // the page's belief about the audio thread — they came from it.
  let position = $state(0)
  let peakL = $state(0)
  let peakR = $state(0)

  // Read per frame, not per quantum: at 48 kHz the engine publishes 375 times
  // a second and a screen shows 60. Sampling the newest value is the whole
  // point of a seqlock over a queue — nothing accumulates, nothing is missed
  // that could have been displayed.
  $effect(() => {
    // One reactive read, and it is the same one `status` is derived from — so
    // there is no second value whose assignment order could matter. A non-null
    // handle is precisely the condition this loop needs.
    const running = engine
    if (running === null) return
    const reader = running.telemetry

    let frame = requestAnimationFrame(function tick() {
      const reading = reader.read()
      if (reading !== null) {
        position = reading.position
        peakL = reading.peakL
        peakR = reading.peakR
      }
      frame = requestAnimationFrame(tick)
    })

    return () => cancelAnimationFrame(frame)
  })

  // The click is what makes this legal: an AudioContext built outside a user
  // gesture stays suspended under the autoplay policy, silently.
  async function start(): Promise<void> {
    starting = true
    failure = null

    // No try/catch: `startEngine` reports every way it can fail as a value, so
    // a catch here could only ever hide a bug in it.
    const started = await startEngine({ onMessage: receive, onCrash: crashed })
    starting = false

    if (!started.ok) {
      fail(describeStartFailure(started.error))
      return
    }

    // One assignment, and it is what makes the page running: the frame loop
    // wakes on it, and `status` is computed from it.
    engine = started.value
  }

  /**
   * Give up on the engine we were driving.
   *
   * The two assignments belong together, and they are in one function so they
   * cannot come apart: `failure` is what the page shows, `engine` is what the
   * frame loop follows. A failure that left the handle in place would leave the
   * loop reading telemetry off an engine nobody is driving, and `send` writing
   * into a ring nobody drains — reachable or not, that is a live handle to a
   * dead thread, which is worth removing by construction rather than by the
   * template happening to hide the button.
   */
  function fail(message: string): void {
    failure = message
    engine = null
  }

  /**
   * The position as a clock. Derived from the sample count and the rate the
   * context reported — not accumulated here, because a second counter running
   * beside the engine's is a second answer to drift away from it.
   */
  function formatClock(samples: number, rate: number | undefined): string {
    if (rate === undefined || rate <= 0) return '—'
    const total = samples / rate
    const minutes = Math.floor(total / 60)
    return `${minutes}:${(total - minutes * 60).toFixed(3).padStart(6, '0')}`
  }

  function receive(message: WorkletMessage): void {
    if (message.type === 'first-quantum') quantum = message.frames
  }

  /**
   * The audio thread died mid-session. Dropping the handle is the substantive
   * part: it stops the frame loop and takes away the transport, so the page
   * stops showing a position that has not moved since and stops taking clicks
   * into a ring nobody drains.
   */
  function crashed(): void {
    fail('The audio thread stopped. Sound will not come back without a reload')
  }

  /**
   * Every gesture goes through here, so the ring being full is diagnosed in
   * one place. It cannot happen while the worklet is draining — 1024 records
   * against one click — so when it does, the audio thread has stopped, and the
   * fix is nowhere near the button that reported it.
   */
  function send(command: Command): boolean {
    const commands = engine?.commands
    // Two failures, and they were one message until this holder made them
    // distinguishable: no handle at all means this ran while the page was not
    // driving anything — unreachable through the template, and worth naming
    // rather than reporting as the ring being full, which is a different fault
    // with a different fix.
    if (commands === undefined) {
      fail('No engine to send to: the transport was used before the page had one')
      return false
    }
    if (commands.send(command)) return true
    fail('The command ring is full: the audio thread has stopped draining it')
    return false
  }

  function toggle(): void {
    if (send({ op: playing ? 'stop' : 'play' })) playing = !playing
  }

  // On every step of the drag, not on release: a tempo change that only lands
  // when the pointer comes up cannot show whether the change itself is
  // seamless, which is the criterion being tested.
  //
  // The value is taken off the element rather than through `bind:value`, which
  // would leave this handler and the binding racing to run first — and losing
  // that race means sending the tempo from one step back, for every step.
  function setTempo(event: Event & { currentTarget: HTMLInputElement }): void {
    bpm = event.currentTarget.valueAsNumber
    send({ op: 'set-bpm', bpm })
  }
</script>

<main>
  <h1>DAW</h1>
  <p class="subtitle">Milestone 0 — skeleton</p>

  <ul class="checks">
    <li class:ok={isolated} class:fail={!isolated}>
      <code>crossOriginIsolated</code>
      <span>{isolated}</span>
    </li>
    <li class:ok={sabError === null} class:fail={sabError !== null}>
      <code>new SharedArrayBuffer(1024)</code>
      <span>{sabError ?? 'ok'}</span>
    </li>

    {#if status === 'running'}
      <li class="ok">
        <code>AudioContext.sampleRate</code>
        <span>{engine?.sampleRate} Hz</span>
      </li>
      <li class:ok={quantum === 128} class:fail={quantum !== null && quantum !== 128}>
        <code>render quantum</code>
        <span>{quantum ?? 'awaiting first block'}</span>
      </li>
      <li class="ok">
        <code>engine_protocol_version()</code>
        <span>{engine?.protocolVersion}</span>
      </li>
    {/if}
  </ul>

  {#if !isolationReady}
    <p class="verdict fail">Not isolated — check the COOP/COEP headers in vite.config.ts.</p>
  {:else if status === 'failed'}
    <p class="verdict fail">{failure}</p>
  {:else if status === 'running'}
    <div class="transport">
      <button onclick={toggle}>{playing ? 'Stop' : 'Play'}</button>
      <label>
        <input type="range" min="20" max="300" step="1" value={bpm} oninput={setTempo} />
        <output>{bpm} BPM</output>
      </label>
    </div>
    <ul class="checks">
      <li>
        <code>transport</code>
        <span
          >{position.toLocaleString('en-US')} · {formatClock(
            position,
            engine?.sampleRate,
          )}</span
        >
      </li>
      <li>
        <code>peak L / R</code>
        <span class="peaks">
          <span class="meter"><span style="width: {Math.min(1, peakL) * 100}%"></span></span>
          <span class="meter"><span style="width: {Math.min(1, peakR) * 100}%"></span></span>
          {peakL.toFixed(3)} / {peakR.toFixed(3)}
        </span>
      </li>
    </ul>

    <p class="verdict ok">
      The metronome is computed in Rust on the audio thread. Commands reach it through the ring
      in shared memory, and the two numbers above came back the same way — read under a seqlock,
      once per frame.
    </p>
  {:else}
    <button onclick={start} disabled={status === 'starting'}>
      {status === 'starting' ? 'Starting…' : 'Start engine'}
    </button>
  {/if}
</main>

<style>
  main {
    max-width: 34rem;
    margin: 0 auto;
    padding: 4rem 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: 0.02em;
  }

  .subtitle {
    margin: 0.25rem 0 2rem;
    color: var(--dim);
  }

  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--line);
  }

  .checks li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--line);
  }

  .checks span {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .verdict {
    margin-top: 2rem;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-top: 2rem;
  }

  .transport button {
    margin-top: 0;
    min-width: 6rem;
  }

  .transport label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .transport output {
    min-width: 5.5rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }

  .peaks {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* The engine's meter has ballistics — a peak falls at a fixed rate rather
     than snapping back — precisely so that a reader running once a frame has
     something to see. A bare number would hide that. */
  .meter {
    width: 3rem;
    height: 0.4rem;
    background: var(--line);
    border-radius: 0.2rem;
    overflow: hidden;
  }

  .meter span {
    display: block;
    height: 100%;
    background: var(--ok);
  }

  button {
    margin-top: 2rem;
    padding: 0.6rem 1.2rem;
    font: inherit;
    color: var(--fg);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--dim);
  }

  button:disabled {
    color: var(--dim);
    cursor: default;
  }

  .ok {
    color: var(--ok);
  }

  .fail {
    color: var(--fail);
  }
</style>
