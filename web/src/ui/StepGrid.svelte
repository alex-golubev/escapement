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
  import { paintPlayhead } from './paint'

  const { session }: { session: Session } = $props()

  let playhead: HTMLCanvasElement | undefined = $state()

  // The playhead, and the only thing on this page that moves every frame. It is
  // a canvas because of the rule the whole UI hangs from: the position must not
  // reach the reactive graph. Written into a rune it would wake this component
  // sixty times a second and take all 128 cells with it — and that is the cost
  // measured on milestone 0, which is paid per update rather than per pixel.
  // Through `onFrame` it reaches nothing but this element.
  $effect(() => {
    const canvas = playhead
    if (canvas === undefined) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    // Out of the stylesheet rather than named here as well: a palette written in
    // two languages is a palette that will be right in one of them.
    const style = getComputedStyle(canvas)
    const colours = {
      line: style.getPropertyValue('--playhead').trim(),
      wash: style.getPropertyValue('--playhead-wash').trim(),
    }

    let field = { width: 0, height: 0, steps: STEPS }

    // Measured when the box changes, not per frame. `clientWidth` forces the
    // layout the browser was about to skip, and asking sixty times a second is
    // the one way this canvas could cost more than the elements it draws over.
    const measure = (): void => {
      const scale = devicePixelRatio
      field = { width: canvas.clientWidth, height: canvas.clientHeight, steps: STEPS }
      canvas.width = Math.round(field.width * scale)
      canvas.height = Math.round(field.height * scale)
      // After the size and not before: setting either dimension resets the
      // context. With the scale in the transform everything `paint.ts` draws is
      // in CSS pixels — the units the stylesheet below is written in.
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }

    const resize = new ResizeObserver(measure)
    resize.observe(canvas)
    measure()

    const stop = session.onFrame((reading) => {
      paintPlayhead(ctx, field, colours, reading)
    })

    return () => {
      stop()
      resize.disconnect()
    }
  })

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

<div class="grid" style="--tracks: {TRACKS}; --steps: {STEPS}">
  <div class="labels">
    {#each tracks as track (track)}
      <span>{KIT_NAMES[track]}</span>
    {/each}
  </div>
  <div class="cells">
    {#each tracks as track (track)}
      {#each steps as step (step)}
        <!-- `aria-pressed` carries the state and the stylesheet reads it back:
             held in a class as well, a cell would say the same thing twice and
             they would eventually disagree.

             Enabled whether or not a kit is loaded, unlike the pads. A pad is
             only ever a sound, so without samples it has nothing to be; a cell
             is the page's own belief about a pattern, and the engine takes it
             and plays nothing, which is exactly what an empty slot should sound
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
    <!-- Last, so it lies over the cells rather than under them, and inert, so
         the clicks it lies over still land. -->
    <canvas bind:this={playhead} class="playhead" aria-hidden="true"></canvas>
  </div>
</div>

<button type="button" class="clear" onclick={() => session.clearPattern()}>Clear</button>

<style>
  .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.5rem;
    margin-top: 1.5rem;

    --row: 1.7rem;
  }

  /* The two halves are laid out on the same explicit rows, so a label always
     sits beside its own track. Left to their contents they would agree only
     while the tallest thing in each happened to match, and disagree by a
     fraction of a row the first time one of them did not. */
  .labels,
  .cells {
    display: grid;
    grid-template-rows: repeat(var(--tracks), var(--row));
    row-gap: 0.25rem;
  }

  .labels {
    align-items: center;
    color: var(--dim);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .cells {
    /* The playhead's containing block, and the reason the cells are wrapped at
       all rather than laid out beside the labels in one grid. An absolutely
       positioned grid child takes its area from the *explicit* grid, and the
       rows here are implicit — eight of them, none declared — so `grid-row: 1 /
       -1` found no lines to resolve against and the canvas fell out to the page,
       where sizing it from its own width ran away in a loop with the resize
       observer. A box of its own is one element against a rule with a corner
       in it. */
    position: relative;
    grid-template-columns: repeat(var(--steps), minmax(0, 1fr));
    /* Zero, and load-bearing. The playhead works out where cell `i` starts from
       the width of the canvas alone — `i·w`, argued at `paintPlayhead` — and
       that holds only while the columns are flush. A gap here would put every
       cell after the first further right than that: right at cell 0 and a whole
       gap adrift by cell 15, so wrong at the end of the bar and correct at the
       start, which is the way round nobody notices. The cells are held apart by
       a margin instead, which insets the button inside its track and leaves the
       track where it was. */
    column-gap: 0;
  }

  .cell {
    /* What the column gap would have been, moved inside the track — see
       above. */
    margin: 0 2px;
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

  .playhead {
    position: absolute;
    inset: 0;
    /* Both, and `inset` alone is not enough — measured, after this ran away
       twice. A canvas is a replaced element, so with `width: auto` its used
       width is its *intrinsic* width, the `width` attribute, and an
       over-constrained `right` is simply dropped. That closes a loop: the
       component sets the attribute from `clientWidth` times the device scale,
       the element grows by that factor, the resize observer fires, and two
       rounds later Chrome gives up and draws a broken image. Said in
       percentages the box comes from the containing block and the attribute
       cannot reach it. */
    width: 100%;
    height: 100%;
    pointer-events: none;
    /* Read back by the component and handed to the painter. Declared here so
       that the colours of this page live in one language. */
    --playhead: var(--fg);
    --playhead-wash: rgb(255 255 255 / 8%);
  }

  .clear {
    /* Block, so that nothing else can come to rest beside it. Inline, it drew
       the page's next button up alongside — and the next button is the one that
       ends the session, which is not a neighbour for a button that empties the
       grid. */
    display: block;
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
