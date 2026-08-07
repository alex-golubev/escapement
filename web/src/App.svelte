<script lang="ts">
  // The readiness criterion for this milestone, checked on the page instead of
  // in devtools. Without cross-origin isolation there is no
  // `SharedArrayBuffer`, and without that there is no UI -> audio link at all.
  // The failure has to be legible on sight; diagnosed later, from a metronome
  // that simply never sounds, it costs an evening.

  // Deliberately plain constants rather than `$state`: both are settled before
  // the first paint and never change afterwards. Reactivity that nothing needs
  // is still something to read past later.
  const isolated = crossOriginIsolated

  // The flag alone does not prove the constructor is reachable, so probe the
  // thing we will actually be using.
  let sabError: string | null = null
  try {
    new SharedArrayBuffer(1024)
  } catch (error) {
    sabError = error instanceof Error ? error.message : String(error)
  }

  const ready = isolated && sabError === null
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
  </ul>

  <p class="verdict" class:ok={ready} class:fail={!ready}>
    {ready
      ? 'Isolation is in place. Next: the worklet and the first sound.'
      : 'Not isolated — check the COOP/COEP headers in vite.config.ts.'}
  </p>
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

  .ok {
    color: var(--ok);
  }

  .fail {
    color: var(--fail);
  }
</style>