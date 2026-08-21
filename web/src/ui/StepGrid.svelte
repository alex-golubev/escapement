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

<section class="panel">
  <div class="grid" style="--tracks: {TRACKS}; --steps: {STEPS}; --beat: {STEPS_PER_BEAT}">
    <div class="labels">
      {#each tracks as track (track)}
        <!-- The track's name, and the way to hear it. A strike that leaves
             nothing behind, which is the whole difference between this and the
             cells beside it: hearing a sound and putting one somewhere are
             separate wants, and the row now answers the first in the same place
             it answers the second.

             It had a panel of eight large buttons to itself, and stopped
             needing one the moment anybody looked at the two together. The name
             was already written here, so that panel was a second copy of all
             eight names whose only further job was being clickable — and it
             outweighed the sequencer to do it.

             Disabled without a kit, unlike a cell: this is only ever a sound,
             so with no samples loaded it has nothing to be. -->
        <button
          disabled={session.kit !== 'loaded'}
          aria-label="play {KIT_NAMES[track]}"
          onclick={() => session.trigger(track)}
        >
          {KIT_NAMES[track]}
        </button>
      {/each}
    </div>
    <div class="cells">
      {#each tracks as track (track)}
        {#each steps as step (step)}
          <!-- `aria-pressed` carries the state and the stylesheet reads it back:
             held in a class as well, a cell would say the same thing twice and
             they would eventually disagree.

             Enabled whether or not a kit is loaded, unlike the name at the
             head of the row: that one is only ever a sound, while a cell is the
             page's own belief about a pattern, and the engine takes it and
             plays nothing, which is exactly what an empty slot should sound
             like. -->
          <button
            type="button"
            class="cell"
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

  <button
    type="button"
    class="clear btn btn-quiet btn-danger"
    onclick={() => session.clearPattern()}
  >
    Clear
  </button>
</section>

<style>
  .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--space-2);

    /* Tall enough that a cell at the page's widest is not a slot. What stops
       it being one is the page measure and nothing here: a ceiling per cell was
       tried and removed, because two knobs on one width meant the field stopped
       growing while the panel around it did not, and two hundred pixels of dead
       panel opened to the right of the last step. */
    --row: 2.25rem;
  }

  /* The two halves are laid out on the same explicit rows, so a label always
     sits beside its own track. Left to their contents they would agree only
     while the tallest thing in each happened to match, and disagree by a
     fraction of a row the first time one of them did not. */
  .labels,
  .cells {
    display: grid;
    grid-template-rows: repeat(var(--tracks), var(--row));
    row-gap: var(--space-1);
  }

  .labels {
    align-items: center;
    color: var(--dim);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  /* Left, because a column of names read down the edge of a grid is a list and
     not a set of captions — and the button reset takes the colour from the
     column above rather than restating it. */
  .labels button {
    text-align: left;
  }

  .labels button:hover:not(:disabled) {
    color: var(--fg);
  }

  .labels button:disabled {
    color: var(--faint);
    cursor: default;
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

    /* One beat wide, in the units the gradient measures in. Written from the two
       counts rather than as 25%, so that a pattern of another length or a beat
       of another division moves the marking with it instead of leaving it
       plausibly wrong. */
    --band: calc(100% * var(--beat) / var(--steps));

    /* The beat, said by the field rather than by every fourth cell — a rule on
       each beat's first column line.

       As a brighter border on the cell it was competing with a struck cell for
       the same property on the same element, so an empty pattern read as one
       that already had something in it. It cannot be said with a gap either:
       that is the arithmetic directly above. A wash across the whole beat was
       tried first and is what this replaces — two surfaces eleven units apart in
       a dark palette, which measured as no marking at all on the page and would
       have needed a contrast that then fought the struck cells. A line needs no
       contrast budget: it is thin, so it can be as bright as it likes.

       Lines land in the two-pixel gutter the cells' margins leave, which is why
       this moves nothing either — and they are exact because the columns are
       equal fractions of the same width the beat is measured against.

       Ink and not a line token, which is what it was first and what made it
       unreadable on the page while measuring perfectly correct in the
       inspector: the mark has to be told apart from a field of 128 cell
       borders, and `--line-strong` is a neighbour of the colour those borders
       are drawn in. Nothing about the geometry was wrong — forcing the colour
       to red put the lines exactly on the beats — so the whole of the defect
       was that a rule had been given a border's weight. What ranks it is the
       playhead above and the cell borders below. */
    background: repeating-linear-gradient(90deg, var(--dim) 0 1px, transparent 1px var(--band));
  }

  .cell {
    /* What the column gap would have been, moved inside the track — see
       above. */
    margin: 0 2px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  .cell:hover {
    border-color: var(--fg);
  }

  .cell[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }

  /* Inside the grid's own panel, which is what now holds it away from the
     button that ends the session: that one is a child of the shell, a panel
     edge and a gap away. Before there were panels the two were adjacent boxes
     in one column and `display: block` here was the whole of what separated
     them. */
  .clear {
    margin-top: var(--space-4);
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
</style>
