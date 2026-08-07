<script lang="ts">
  import { describeStartFailure, startEngine } from './audio/host'
  import type { Command } from './audio/protocol'
  import type { RingWriter } from './audio/ring-writer'
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

  let status = $state<Status>('idle')
  let failure = $state<string | null>(null)
  let sampleRate = $state<number | null>(null)
  let protocolVersion = $state<number | null>(null)
  let quantum = $state<number | null>(null)

  // The transport as the page believes it to be. Believes, and does not know:
  // the engine holds the truth, and until telemetry is read back this is an
  // open loop. It is honest for one button that only ever moves on a click.
  let playing = $state(false)
  let bpm = $state(120) // DEFAULT_BPM in transport.rs; the engine starts here too

  // Not `$state`: it is assigned once, and every reader of it is an event
  // handler that runs long after. Making it reactive would be reactivity that
  // nothing subscribes to.
  let commands: RingWriter | null = null

  // The click is what makes this legal: an AudioContext built outside a user
  // gesture stays suspended under the autoplay policy, silently.
  async function start(): Promise<void> {
    status = 'starting'
    failure = null

    // No try/catch: `startEngine` reports every way it can fail as a value, so
    // a catch here could only ever hide a bug in it.
    const started = await startEngine(receive)

    if (!started.ok) {
      failure = describeStartFailure(started.error)
      status = 'failed'
      return
    }

    sampleRate = started.value.sampleRate
    protocolVersion = started.value.protocolVersion
    commands = started.value.commands
    status = 'running'
  }

  function receive(message: WorkletMessage): void {
    if (message.type === 'first-quantum') quantum = message.frames
  }

  /**
   * Every gesture goes through here, so the ring being full is diagnosed in
   * one place. It cannot happen while the worklet is draining — 1024 records
   * against one click — so when it does, the audio thread has stopped, and the
   * fix is nowhere near the button that reported it.
   */
  function send(command: Command): boolean {
    if (commands?.send(command) === true) return true
    failure = 'The command ring is full: the audio thread has stopped draining it'
    status = 'failed'
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
        <span>{sampleRate} Hz</span>
      </li>
      <li class:ok={quantum === 128} class:fail={quantum !== null && quantum !== 128}>
        <code>render quantum</code>
        <span>{quantum ?? 'awaiting first block'}</span>
      </li>
      <li class="ok">
        <code>engine_protocol_version()</code>
        <span>{protocolVersion}</span>
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
    <p class="verdict ok">
      The metronome is computed in Rust on the audio thread, and commands reach it through the
      ring in shared memory. Nothing is read back yet — the position on screen would be the
      page's own guess, so there is none.
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
