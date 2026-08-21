<script lang="ts">
  // The shell: what starts the engine, what gives it back, and what is on the
  // page while it runs. Everything else is a component beside it, and none of
  // them holds engine state — they are handed readings and verbs, and the one
  // road into the audio thread never leaves `session.svelte.ts`.

  import { createSession } from './state/session.svelte'
  import Diagnostics from './ui/Diagnostics.svelte'
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
  <header>
    <div class="titles">
      <h1>DAW</h1>
      <p class="subtitle">Milestone 1 — drum machine</p>
    </div>

    <!-- The only way to hand the device back. Without it the context outlives
         every interest the page has in it, and the metronome plays until the tab
         is reloaded.

         Up here with the page's own name rather than below the instrument,
         because what it ends is the session and not anything the instrument is
         doing. In the flow it was one gap under the grid and wearing the same
         quiet frame as the button that empties it — two controls of very
         different consequence, told apart by nothing. -->
    {#if session.status === 'running'}
      <button class="btn btn-quiet btn-danger" onclick={() => session.stop()}>
        Stop engine
      </button>
    {/if}
  </header>

  {#if !isolationReady}
    <p class="verdict fail">Not isolated — check the COOP/COEP headers in vite.config.ts.</p>
  {:else if session.status === 'running'}
    <Transport {session} />
    <StepGrid {session} />

    {#if session.kitFailure !== null}
      <p class="verdict fail">{session.kitFailure}</p>
    {/if}
  {:else}
    <!-- The failure and the way out of it, together. A page that reports a dead
         engine and takes the button away leaves a reload as the only move, and
         starting again is a new context — there is nothing left of the old one
         to be confused by. -->
    {#if session.failure !== null}
      <p class="verdict fail">{session.failure}</p>
    {/if}
    <button
      class="btn"
      onclick={() => void session.start()}
      disabled={session.status === 'starting'}
    >
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
  /* The instrument sets the page width, and the distance between groups is the
     shell's rather than each group's own top margin. Both were the other way
     round: one reading measure over everything gave the sequencer 29-pixel
     cells with two thirds of the window empty beside them, and the spacing was
     five `margin-top` values in five files that agreed only by being read one
     after another. */
  main {
    display: grid;
    gap: var(--space-5);
    max-width: var(--measure-page);
    margin: 0 auto;
    padding: var(--space-7) var(--space-5);
  }

  /* The page's name at one end and the control over its session at the other. */
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-5);
  }

  /* Prose stays narrow inside the page width — a heading and a failure are
     read, not scanned. */
  .titles,
  .verdict {
    max-width: var(--measure-prose);
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: 0.02em;
  }

  .subtitle {
    margin: var(--space-1) 0 0;
    color: var(--dim);
  }

  .verdict {
    margin: 0;
  }

  /* A button is as wide as its own words. Left to the grid it would be as wide
     as the sequencer. */
  button {
    justify-self: start;
  }
</style>
