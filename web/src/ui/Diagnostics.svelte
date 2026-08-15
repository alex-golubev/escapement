<script lang="ts">
  // What the milestones were checked against, kept on the page rather than in
  // devtools — every failure here presents as silence, and silence diagnosed a
  // week later from a metronome that never sounded costs an evening.
  //
  // Folded away because it is evidence and not an instrument. Two things are
  // not allowed to fold away with it: cross-origin isolation, which stops the
  // page before this panel is reached at all, and a dropped command, which is a
  // bug that must never pile up quietly — so the summary itself says that one,
  // and says it while shut.
  //
  // Shut also costs less than it looks: the rows keep their readings, but a
  // closed `details` puts them out of the layout, and what milestone 0 measured
  // was paint and compositing rather than the work behind them.

  import { QUANTUM } from '../audio/worklet-messages'
  import type { Session } from '../state/session.svelte'
  import { formatClock } from './format'

  const {
    session,
    isolated,
    sabError,
  }: { session: Session; isolated: boolean; sabError: string | null } = $props()
</script>

<details class="diagnostics">
  <summary class:fail={session.dropped > 0}>
    diagnostics{session.dropped > 0 ? ` — ${session.dropped} commands dropped` : ''}
  </summary>

  <ul class="checks">
    <li class:ok={isolated} class:fail={!isolated}>
      <code>crossOriginIsolated</code>
      <span>{isolated}</span>
    </li>
    <!-- The flag alone does not prove the constructor is reachable, so the probe
         asks for the thing the ring is actually built out of. -->
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
           this row says the host rendered what was built for it rather than that
           it rendered a number this file happens to name. -->
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
      <li>
        <code>transport</code>
        <span
          >{session.position.toLocaleString('en-US')} · {formatClock(
            session.position,
            session.sampleRate,
          )}</span
        >
      </li>
      <!-- The number the playhead is drawn from, in the units it is drawn in.
           The line moves on every frame and this changes at the readout rate, so
           the two agree about the position and disagree about how recent it
           is. -->
      <li>
        <code>step</code>
        <span>{session.step.toFixed(2)} · cell {Math.floor(session.step)}</span>
      </li>
      <li class:fail={session.peakL > 1 || session.peakR > 1}>
        <code>peak L / R</code>
        <span>{session.peakL.toFixed(3)} / {session.peakR.toFixed(3)}</span>
      </li>
      <li class:fail={session.dropped > 0}>
        <code>commands dropped</code>
        <span>{session.dropped}</span>
      </li>
      <!-- A reading and not part of the engine's status: with no kit the
           transport still runs and the metronome still sounds, and only the pads
           have nothing to play. -->
      <li class:ok={session.kit === 'loaded'} class:fail={session.kit === 'failed'}>
        <code>kit</code>
        <span>{session.kit}</span>
      </li>
    {/if}
  </ul>

  <p class="note">
    Every sample is computed in Rust on the audio thread. The kit crossed once, by the port, and
    lives in memory the engine owns; the grid reaches it through the ring in shared memory, and
    the position and the meters came back the same way — read under a seqlock, once per frame.
  </p>
</details>

<style>
  .diagnostics {
    margin-top: 2.5rem;
    border-top: 1px solid var(--line);
  }

  summary {
    padding: 0.75rem 0;
    color: var(--dim);
    font-size: 0.85rem;
    cursor: pointer;
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

  .note {
    color: var(--dim);
    font-size: 0.85rem;
  }
</style>
