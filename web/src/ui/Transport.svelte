<script lang="ts">
  // Play, tempo, output level and the click — everything that acts on the
  // engine as a whole rather than on one track or one cell.
  //
  // The meter sits here with the fader it answers to. Apart they would be a
  // number to set and a number to read with nothing between them; together they
  // are the one control on this page with feedback.

  import type { Session } from '../state/session.svelte'
  import Meters from './Meters.svelte'

  const { session }: { session: Session } = $props()
</script>

<div class="transport panel">
  <button class="btn" onclick={() => session.toggle()}>
    {session.playing ? 'Stop' : 'Play'}
  </button>

  <label class="field">
    <span class="name">tempo</span>
    <!-- On every step of the drag, not on release: a tempo change that only
         lands when the pointer comes up cannot show whether the change itself is
         seamless, which is the criterion being tested.

         The value is taken off the element rather than through `bind:value`,
         which would leave this handler and the binding racing to run first — and
         losing that race means sending the tempo from one step back, for every
         step. -->
    <input
      type="range"
      min="20"
      max="300"
      step="1"
      value={session.bpm}
      oninput={(event) => session.setBpm(event.currentTarget.valueAsNumber)}
    />
    <output>{session.bpm} BPM</output>
  </label>

  <!-- Attenuation is the whole of what this is for. The sum is hot by decision
       — eight tracks at unity reach 5.66 — so a full grid sits on the limiter
       and the useful travel is downward. The engine accepts up to 2 and this
       stops at unity: above it there is nothing to reach that the limiter is not
       already holding, and a range the UI keeps itself inside is the UI's own
       business. -->
  <label class="field">
    <span class="name">master</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={session.masterGain}
      oninput={(event) => session.setMasterGain(event.currentTarget.valueAsNumber)}
    />
    <output>{session.masterGain.toFixed(2)}</output>
    <Meters {session} />
  </label>

  <!-- The engine comes up with the click on, and it is in the way of hearing
       anything else. Off is a command like any other, which is why the box
       follows what was accepted rather than what was clicked. -->
  <label class="field switch">
    <input
      type="checkbox"
      checked={session.metronome}
      onchange={(event) => session.setMetronome(event.currentTarget.checked)}
    />
    click
  </label>
</div>

<style>
  .transport {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4) var(--space-6);
  }

  /* A name, a control, a reading — in that order, every time. The tempo had a
     name only because its unit happened to need spelling out and the master had
     none at all, so the row read as one labelled control and one loose number. */
  .field {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .name {
    color: var(--dim);
    font-size: var(--text-sm);
  }

  /* Sized, so the row wraps where this file decides rather than wherever a
     browser's default track length happens to put the break. */
  input[type='range'] {
    width: 8rem;
  }

  output {
    min-width: 3.5rem;
    font-variant-numeric: tabular-nums;
  }

  .switch {
    color: var(--dim);
  }

  button {
    min-width: 6rem;
  }
</style>
