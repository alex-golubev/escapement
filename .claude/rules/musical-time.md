---
paths:
  - "crates/time/**"
  - "crates/model/**"
  - "crates/core/**"
---

# Musical time

- **Positions are stored in musical time, never in samples.** Tempo is a map with
  ramps, not a number. Samples appear where the engine meets the clock and are
  not stored anywhere.
- **A position is one integer of ticks — never a pair, never a float** (§2.5).
  A rational is two numbers spelling one position, `(3,2)` and `(6,4)`, so two
  people placing a note on the same beat write different values: the failure
  §2.4 chose Loro to avoid. Normalizing on construction only turns it into an
  invariant that must then survive serialization, the network and a client
  version not yet written. The resolution is generous for the same reason — a
  finer grid is reachable from a coarser one by multiplication, and a coarser one
  has already lost what it cannot hold.
- **A tempo ramp is linear in beats per minute, never in the period** (§2.5).
  Tempo is an automated parameter, and an automation curve interpolates its
  parameter — so the line someone drew is straight in beats per minute. Backwards
  it is still a plausible curve through the same two marks, and over eight bars
  from 60 to 180 it ends three and three quarter seconds elsewhere: a different
  place in the song, arrived at by something that sounds like music.
- **A stretch with no ramp in it is a second formula, not an edge case.** The
  moving form divides by the rate of change, and at zero `f64` does not trap —
  the infinity meets a logarithm of one and makes a NaN, which compares false to
  everything and sorts nowhere (§2.5). The two forms agree where they meet, which
  is the property that makes the map continuous; the pair of surviving mutants
  listed in `.cargo/mutants.toml` is that agreement rather than a missing test.
- **What this closes is the document, not the type** (§2.5). Both shapes stay
  revisitable until the first project is saved. Once Loro is underneath the
  entities, changing either is a migration.
