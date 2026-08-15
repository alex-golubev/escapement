<script lang="ts">
  // The pattern, as something to click. Eight rows of sixteen plain DOM
  // elements — 128 of them is not a load, and the one surface here that does
  // need drawing is the playhead, which is a canvas of its own and does not go
  // through this component at all.
  //
  // Thin on purpose, and not for taste: nothing in this package can test a
  // `.svelte` file — there is no jsdom and no component library — so anything
  // that lives here is code no test will ever run. What that leaves is the
  // markup, the styles, and two handlers that only forward. The state, the
  // guards and the one road into the engine are all in `session.svelte.ts`,
  // where a spec can reach them.

  import { KIT_NAMES } from '../audio/kit'
  import { STEPS, TRACKS } from '../audio/protocol'
  import type { Session } from '../state/session.svelte'

  const { session }: { session: Session } = $props()

  /**
   * How many cells make a beat, mirroring `STEPS_PER_BEAT` in sequencer.rs.
   *
   * Here and not in protocol.ts beside `TRACKS` and `STEPS`, and the difference
   * is the point: those two are addressed by a command, so a disagreement
   * between the languages is a command dropped in silence — which is what
   * `PROTOCOL_VERSION` is for. This one addresses nothing. It decides where a
   * line falls, and a line every third cell against an engine counting four is
   * wrong from the first bar and wrong out loud, with the playhead crossing it
   * at visibly the wrong moment. A guard against a failure that announces
   * itself buys nothing and costs a third mirror.
   */
  const STEPS_PER_BEAT = 4

  const tracks = Array.from({ length: TRACKS }, (_, track) => track)
  const steps = Array.from({ length: STEPS }, (_, step) => step)

  /**
   * Flip a cell, and let the ear confirm it.
   *
   * The preview is what makes editing audible at all: a pattern is built with
   * the transport stopped more often than not, and a cell set then says nothing
   * until somebody presses play. It goes out as `TriggerTrack`, which reaches
   * the same `trigger` the grid itself strikes through — two doors would drift,
   * and the drift would be heard long before anyone thought to look for it.
   *
   * Only what landed is previewed. A sound with no lit cell behind it would be
   * the one thing on this page that happened and left no trace.
   */
  function flip(track: number, step: number): void {
    const wanted = !session.isStepOn(track, step)
    session.setStep(track, step, wanted)
    if (wanted && session.isStepOn(track, step)) session.trigger(track)
  }
</script>

<div class="grid" style="--steps: {STEPS}">
  {#each tracks as track (track)}
    <span class="label">{KIT_NAMES[track]}</span>
    {#each steps as step (step)}
      <!-- `aria-pressed` carries the state and the stylesheet reads it back:
           held in a class as well, a cell would say the same thing twice and
           they would eventually disagree.

           Enabled whether or not a kit is loaded, unlike the pads. A pad is
           only ever a sound, so without samples it has nothing to be; a cell is
           the page's own belief about a pattern, and the engine takes it and
           plays nothing, which is exactly what an empty slot should sound
           like. -->
      <button
        type="button"
        class="cell"
        class:beat={step % STEPS_PER_BEAT === 0}
        aria-pressed={session.isStepOn(track, step)}
        aria-label="{KIT_NAMES[track]}, step {step + 1}"
        onclick={() => {
          flip(track, step)
        }}
      ></button>
    {/each}
  {/each}
</div>

<button type="button" class="clear" onclick={() => session.clearPattern()}>Clear</button>

<style>
  .grid {
    display: grid;
    grid-template-columns: max-content repeat(var(--steps), minmax(0, 1fr));
    gap: 0.25rem;
    align-items: center;
    margin-top: 1.5rem;
  }

  .label {
    padding-right: 0.5rem;
    color: var(--dim);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .cell {
    height: 1.7rem;
    padding: 0;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.15rem;
    cursor: pointer;
  }

  /* Every fourth cell brighter, so a beat can be counted without reading
     numbers. It shows on empty cells, which is where counting happens; a struck
     cell is filled, and the fill has already said where it is. */
  .cell.beat {
    border-color: var(--dim);
  }

  .cell:hover {
    border-color: var(--fg);
  }

  /* Last, so that it wins over `.beat` at equal specificity: a struck cell on a
     beat is struck first and on a beat second. */
  .cell[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }

  .clear {
    margin-top: 1rem;
    padding: 0.35rem 0.9rem;
    font: inherit;
    font-size: 0.85rem;
    color: var(--dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .clear:hover {
    color: var(--fg);
    border-color: var(--dim);
  }
</style>
