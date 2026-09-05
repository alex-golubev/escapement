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
- **A signature mark is addressed by the bar it starts at, never by a position**
  (§2.5). Where that bar falls in ticks is counted from the origin. A mark held
  at a tick is one that a concurrent edit to an earlier bar can leave off a bar
  line, and the map then refuses to build — for both people at once, because
  they converged on it. A bar has no invalid spelling.
- **`beat` means two different things in this crate, and that is load-bearing.**
  In `tempo` it is a quarter note whatever the signature says; in `meter` it is
  one unit of the denominator, so 6/8 has six. Collapse them into one meaning and
  the maps are coupled: every conversion to seconds needs the signature, and
  editing a signature moves the audio after it (§2.5).
- **Bars count from one, and keep counting backwards.** Bar zero and the ones
  below it hold the first signature, the way the tempo map holds its first tempo
  behind its first mark. A count-in is the reason a position is signed, and it
  has to be somewhere.
- **Nothing in the bar map is floating point, and it must not acquire any.** Bar
  lengths are whole ticks, which is what makes a position converted to a bar and
  a beat come back the tick it was. The price is `Meter::new` turning away a
  denominator that does not divide a whole note — turning away rather than
  rounding, because a bar length off by a tick is off by a hundred ticks a
  hundred bars later, and the ruler and the audio disagree with nothing to
  point at.
- **In the document both maps are keyed, never listed** (§2.5). Signatures by
  bar, tempi by position. A merge can put two marks in one place, and neither
  `build` takes two — under a list that duplicate is representable, and what it
  produces is a project that stops opening.
- **What this closes is the document, not the type** (§2.5). Both shapes stay
  revisitable until the first project is saved. Once Loro is underneath the
  entities, changing either is a migration.
