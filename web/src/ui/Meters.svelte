<script lang="ts">
  // The bus level, drawn rather than reacted to. Levels are layer 1 by the same
  // division the playhead belongs to: what changes every frame is painted, and
  // what changes on a gesture is a component.
  //
  // A bar and not only the number beside it, because the engine's meter has
  // ballistics — a peak falls at a fixed rate instead of snapping back — and it
  // has them precisely so that a reader running once a frame has something to
  // watch. A number alone throws that away and shows a value that jumps.
  //
  // The eighteen lines below also stand in StepGrid.svelte, and are left
  // standing twice on purpose. Shared, they would need the element, the resize
  // observer and the device scale all injected before a test could reach them —
  // more code than the repetition, and code whose only caller would be the test
  // that justified it.

  import type { Session } from '../state/session.svelte'
  import { paintMeters } from './paint'

  const { session }: { session: Session } = $props()

  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    const element = canvas
    if (element === undefined) return
    const ctx = element.getContext('2d')
    if (ctx === null) return

    const style = getComputedStyle(element)
    const colours = {
      track: style.getPropertyValue('--meter-track').trim(),
      bar: style.getPropertyValue('--meter-bar').trim(),
      over: style.getPropertyValue('--meter-over').trim(),
    }

    let box = { width: 0, height: 0 }

    const measure = (): void => {
      const scale = devicePixelRatio
      box = { width: element.clientWidth, height: element.clientHeight }
      element.width = Math.round(box.width * scale)
      element.height = Math.round(box.height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }

    const resize = new ResizeObserver(measure)
    resize.observe(element)
    measure()

    const stop = session.onFrame((reading) => {
      paintMeters(ctx, box, colours, reading)
    })

    return () => {
      stop()
      resize.disconnect()
    }
  })
</script>

<!-- Hidden from the reader that cannot see it, because the numbers beside it
     say the same thing in text. -->
<canvas bind:this={canvas} class="meters" aria-hidden="true"></canvas>

<style>
  /* Sized so the reading can actually be read. At four rems by fourteen pixels
     it was the smallest thing on a page whose every other control it is the only
     feedback for — and the one mark here that moves with the sound. */
  .meters {
    display: block;
    width: 9rem;
    height: 1.25rem;

    /* Sunken rather than the panel's own line: the painter fills the whole track
       before it fills the bar, so this colour is what silence looks like, and
       silence has to sit below the surface the meter is mounted in. No radius —
       the fills are square and would show through the corners. */
    --meter-track: var(--surface-sunken);
    --meter-bar: var(--ok);
    --meter-over: var(--fail);
  }
</style>
