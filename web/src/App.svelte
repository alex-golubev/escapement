<script lang="ts">
  import { QUANTUM } from './audio/worklet-messages'
  import { createSession } from './state/session.svelte'

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

  // Everything that moves lives in here, including the one way to reach the
  // audio thread. This component reads and calls; it holds no engine state of
  // its own, and cannot — the handle does not leave that module.
  const session = createSession()

  /**
   * The position as a clock. Derived from the sample count and the rate the
   * context reported — not accumulated here, because a second counter running
   * beside the engine's is a second answer to drift away from it.
   */
  function formatClock(samples: number, rate: number | null): string {
    if (rate === null || rate <= 0) return '—'
    const total = samples / rate
    const minutes = Math.floor(total / 60)
    return `${minutes}:${(total - minutes * 60).toFixed(3).padStart(6, '0')}`
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

    {#if session.status === 'running'}
      <li class="ok">
        <code>AudioContext.sampleRate</code>
        <span>{session.sampleRate} Hz</span>
      </li>
      <!-- Against the constant the worklet allocated the engine for, so that
           this row says the host rendered what was built for it rather than
           that it rendered a number this file happens to name. -->
      <li
        class:ok={session.quantum === QUANTUM}
        class:fail={session.quantum !== null && session.quantum !== QUANTUM}
      >
        <code>render quantum</code>
        <span>{session.quantum ?? 'awaiting first block'}</span>
      </li>
      <li class="ok">
        <code>engine_protocol_version()</code>
        <span>{session.protocolVersion}</span>
      </li>
    {/if}
  </ul>

  {#if !isolationReady}
    <p class="verdict fail">Not isolated — check the COOP/COEP headers in vite.config.ts.</p>
  {:else if session.status === 'running'}
    <div class="transport">
      <button onclick={() => session.toggle()}>{session.playing ? 'Stop' : 'Play'}</button>
      <label>
        <!-- On every step of the drag, not on release: a tempo change that only
             lands when the pointer comes up cannot show whether the change itself
             is seamless, which is the criterion being tested.

             The value is taken off the element rather than through `bind:value`,
             which would leave this handler and the binding racing to run first —
             and losing that race means sending the tempo from one step back, for
             every step. -->
        <input
          type="range"
          min="20"
          max="300"
          step="1"
          value={session.bpm}
          oninput={(event) => session.setBpm(event.currentTarget.valueAsNumber)}
        />
        <output>{session.bpm} BPM</output>
      </label>
    </div>
    <ul class="checks">
      <li>
        <code>transport</code>
        <span
          >{session.position.toLocaleString('en-US')} · {formatClock(
            session.position,
            session.sampleRate,
          )}</span
        >
      </li>
      <li>
        <code>peak L / R</code>
        <!-- The reading is of the bus before the limiter, so it runs past 1
             on any busy pattern — see `Telemetry.peakL`. The bars are clamped
             because a bar has an end; the overload is what the colour says,
             since a clamp alone would turn the one thing worth knowing into a
             bar that looks merely full. -->
        <span class="peaks" class:fail={session.peakL > 1 || session.peakR > 1}>
          <span class="meter"
            ><span style="width: {Math.min(1, session.peakL) * 100}%"></span></span
          >
          <span class="meter"
            ><span style="width: {Math.min(1, session.peakR) * 100}%"></span></span
          >
          {session.peakL.toFixed(3)} / {session.peakR.toFixed(3)}
        </span>
      </li>
      <!-- Shown while running rather than only when it moves. A counter that
           appears on its first drop is a line nobody has ever seen, and the
           question it answers — was anything lost — is one you want answered
           before you have a reason to ask it. -->
      <li class:fail={session.dropped > 0}>
        <code>commands dropped</code>
        <span>{session.dropped}</span>
      </li>
    </ul>

    <p class="verdict ok">
      The metronome is computed in Rust on the audio thread. Commands reach it through the ring
      in shared memory, and the position and the meters came back the same way — read under a
      seqlock, once per frame.
    </p>

    <!-- The only way to hand the device back. Without it the context outlives
         every interest the page has in it, and the metronome plays until the tab
         is reloaded. -->
    <button onclick={() => session.stop()}>Stop engine</button>
  {:else}
    <!-- The failure and the way out of it, together. A page that reports a dead
         engine and takes the button away leaves a reload as the only move, and
         starting again is a new context — there is nothing left of the old one
         to be confused by. -->
    {#if session.failure !== null}
      <p class="verdict fail">{session.failure}</p>
    {/if}
    <button onclick={() => void session.start()} disabled={session.status === 'starting'}>
      {#if session.status === 'starting'}
        Starting…
      {:else if session.failure !== null}
        Start again
      {:else}
        Start engine
      {/if}
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
