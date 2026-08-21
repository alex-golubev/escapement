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
      <!-- The one row here read from a clock a hidden tab does not stop.
           Everything above it is read from `requestAnimationFrame` and freezes
           with the tab — watched hidden, and they stood still to the digit —
           which is why none of them can say whether the audio thread is well,
           and the tab being hidden is exactly when that is worth knowing.
           A tenth of the clock and not something near the noise: the reading
           carries the counter's quantisation, which is bounded rather than
           small (`DRIFT_WINDOW`), and what this row is for is a thread that
           stopped keeping up, not one that is a few milliseconds off. -->
      <li
        class:fail={session.driftMsPerSecond !== null &&
          Math.abs(session.driftMsPerSecond) > 100}
      >
        <code>render drift</code>
        <span
          >{session.driftMsPerSecond === null
            ? 'sampling…'
            : `${session.driftMsPerSecond.toFixed(1)} ms/s`}</span
        >
      </li>
      <!-- Whether the clock above was running while nobody could see it, which
           the drift itself cannot say: audio goes on in a hidden tab, so a
           sampler that slept through the absence and woke with the tab reports
           the same healthy number as one that watched all of it. Read on
           coming back, and read as a pair — the count against the seconds it
           covers, one a second being what was asked for. A short count with
           every gap innocent is a clock the browser slowed; a gap the width of
           the absence is one it stopped. Nothing here is coloured: a throttled
           timer is the browser being itself, and red on this panel means a
           check failed. -->
      <li>
        <code>drift samples</code>
        <span
          >{session.driftSamples} in {(session.driftSpanMs / 1000).toFixed(0)} s · longest gap {session.driftMaxGapMs ===
          null
            ? '—'
            : `${(session.driftMaxGapMs / 1000).toFixed(1)} s`}</span
        >
      </li>
      <!-- A reading and not part of the engine's status: with no kit the
           transport still runs and the metronome still sounds, and only the pads
           have nothing to play. -->
      <li class:ok={session.kit === 'loaded'} class:fail={session.kit === 'failed'}>
        <code>kit</code>
        <span>{session.kit}</span>
      </li>
      <!-- The button is an instrument in a panel that calls itself evidence, and
           it is here anyway: the number beside it only means something as a
           series, and loading a kit is the only event that can move it. One
           press proves nothing; a dozen with this figure standing still is the
           whole of what the milestone asks about leaked sample memory. -->
      <li>
        <code>linear memory</code>
        <span>
          {session.kitBytes === null
            ? '—'
            : `${(session.kitBytes / 1024 / 1024).toFixed(2)} MiB`}
          <button
            type="button"
            class="btn btn-quiet"
            onclick={() => session.reloadKit()}
            disabled={session.kit === 'loading'}
          >
            reload kit
          </button>
        </span>
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
  /* No panel, and that is the decision rather than an omission: this is the
     instrument's measuring equipment, not one of its groups, and a panel would
     put it among them. A rule and a disclosure triangle say what it is. */
  .diagnostics {
    border-top: 1px solid var(--line);
  }

  summary {
    padding: var(--space-3) 0;
    color: var(--dim);
    font-size: var(--text-sm);
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
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--line);
  }

  .checks span {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .checks button:disabled {
    opacity: 0.5;
  }

  .note {
    color: var(--dim);
    font-size: var(--text-sm);
  }
</style>
