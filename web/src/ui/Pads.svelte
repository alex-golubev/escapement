<script lang="ts">
  // Eight pads, which is what `TriggerTrack` is for. They strike and leave
  // nothing behind, and that is the whole difference between a pad and a cell:
  // hearing a sound and putting one somewhere are separate wants, and the grid
  // answers only the second.

  import { KIT_NAMES } from '../audio/kit'
  import type { Session } from '../state/session.svelte'

  const { session }: { session: Session } = $props()
</script>

<div class="pads">
  {#each KIT_NAMES as pad, track (pad)}
    <!-- Disabled without a kit, unlike a cell. A pad is only ever a sound, so
         with no samples loaded it has nothing to be; a cell is the page's own
         belief about a pattern and stands whether or not anything can play
         it. -->
    <button
      class="pad"
      disabled={session.kit !== 'loaded'}
      onclick={() => session.trigger(track)}
    >
      {pad}
    </button>
  {/each}
</div>

<style>
  .pads {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  .pad {
    padding: 0.9rem 0.5rem;
    font: inherit;
    color: var(--fg);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .pad:hover:not(:disabled) {
    border-color: var(--dim);
  }

  .pad:disabled {
    color: var(--dim);
    cursor: default;
  }
</style>
