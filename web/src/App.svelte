<script lang="ts">
  // The shell: what starts the engine, what gives it back, and what is on the
  // page while it runs. Everything else is a component beside it, and none of
  // them holds engine state — they are handed readings and verbs, and the one
  // road into the audio thread never leaves `session.svelte.ts`.

  import { createSession } from './state/session.svelte'
  import Diagnostics from './ui/Diagnostics.svelte'
  import Pads from './ui/Pads.svelte'
  import StepGrid from './ui/StepGrid.svelte'
  import Transport from './ui/Transport.svelte'

  // Without cross-origin isolation there is no `SharedArrayBuffer`, and without
  // that there is no UI → audio link at all — so this decides whether there is a
  // page to draw, not merely a row to show. The rows are in the diagnostics
  // panel; the verdict is here, because it is the one failure that leaves
  // nothing else to look at.
  //
  // Deliberately plain constants rather than `$state`: both are settled before
  // the first paint and never change afterward. Reactivity that nothing needs is
  // still something to read past later.
  const isolated = crossOriginIsolated
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
</script>

<main>
  <h1>DAW</h1>
  <p class="subtitle">Milestone 1 — drum machine</p>

  {#if !isolationReady}
    <p class="verdict fail">Not isolated — check the COOP/COEP headers in vite.config.ts.</p>
  {:else if session.status === 'running'}
    <Transport {session} />
    <Pads {session} />
    <StepGrid {session} />

    {#if session.kitFailure !== null}
      <p class="verdict fail">{session.kitFailure}</p>
    {/if}

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

  <!-- Outside every branch above, because the two rows at the top of it are the
       ones worth reading *before* pressing anything — and because a panel that
       came and went with the engine would be missing on exactly the two screens
       a person reaches it from. -->
  <Diagnostics {session} {isolated} {sabError} />
</main>

<style>
  main {
    max-width: 36rem;
    margin: 0 auto;
    padding: 4rem 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: 0.02em;
  }

  .subtitle {
    margin: 0.25rem 0 0;
    color: var(--dim);
  }

  .verdict {
    margin-top: 2rem;
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
</style>
