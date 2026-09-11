---
paths:
  - "crates/time/**"
  - "crates/model/**"
  - "crates/core/**"
---

# Musical time

Why each of these is the shape it is — and what was rejected on the way — is
`ARCHITECTURE.md` §2.5. What is here is what breaks if it is not held.

- **Positions are stored in musical time, never in samples.** Tempo is a map
  with ramps, not a number. Samples appear where the engine meets the clock and
  are not stored anywhere.
- **A position is one integer of ticks — never a pair, never a float** (§2.5).
  `(3,2)` and `(6,4)` are two spellings of one position, so two people placing a
  note on the same beat write different values — the class of failure §2.4
  exists to avoid. Normalizing on construction does not repair that; it turns it
  into an invariant that has to survive serialization, the network, and a client
  version nobody has written yet.
- **A tempo ramp is linear in beats per minute, never in the period** (§2.5).
  Backwards it is still a plausible curve through the same two marks, so nothing
  looks wrong — it just ends somewhere else in the song.
- **A segment with no ramp in it is a second formula, not an edge case** (§2.5).
  The moving form divides by the rate of change; at zero `f64` does not trap, so
  the infinity meets a logarithm of one and makes a NaN, which compares false to
  everything, sorts nowhere, and saturates to tick zero on its way to an integer.
  The two forms have to agree where they meet, which is what makes the map
  continuous — the pair of surviving mutants in `.cargo/mutants.toml` is that
  agreement rather than a missing test.
- **A signature mark is addressed by the bar it starts at, never by a position**
  (§2.5). Held at a tick, a concurrent edit to an earlier bar can leave a mark
  off a bar line and the map then refuses to build — for both people at once,
  because they converged on it. A bar has no invalid spelling.
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
  denominator that does not divide a whole note: a bar length off by a tick is
  off by a hundred ticks a hundred bars later, and the ruler and the audio then
  disagree with nothing to point at.
- **In the document both maps are keyed, never listed** (§2.5). Signatures by
  bar, tempi by position. A merge can put two marks in one place and neither
  `build` takes two, so under a list that duplicate is representable — and what
  it produces is a project that stops opening.
- **The mark that opens each map is a field of the document, not an entry in
  it.** Both builders refuse marks that do not start at the beginning, so an
  opening mark held as an entry is one a merge can move or delete. As a field
  there is nothing to delete, and with a tempo refused at the door for not being
  one, no document that can be written yields a map that refuses to build.
- **An audio clip's trim into its source is a third count, in the source's own
  frames** (§2.5). Spelled as a span of ticks, every audio clip is stretched by
  whatever the project tempo happens to be — and no stretching code exists to
  blame for it.
- **A position converts to the sample it falls in — `floor`, never a cast**
  (§2.5). A cast truncates toward zero, and the scale is signed for the
  count-in: that folds the samples either side of the origin into one of double
  width, so everything before bar one lands a sample late without saying so.
- **Two sample counts exist, and turning one into the other is a bug** (§2.5).
  The engine's clock counts from when the engine was built: unsigned, monotonic,
  running whether or not the transport is. A converted position is
  `SamplePosition` — signed, counted from the timeline's origin, and stopping
  when the transport does. Different origins, so they are different types: the
  clock stays a `u64` precisely so that the two do not add up.
- **The sample rate is a parameter of the conversion, not a field of a map or a
  document** (§2.5). The map answers in seconds, and the offline render for
  export drives the same engine at a rate of its own. One type carries the rate,
  the multiplier and the rounding; nothing else multiplies by a rate.
- **The two directions are not each other's inverse.** A tick is a fraction of a
  sample, the way back lands on the nearest tick, and `floor` after that can
  answer with the sample before. Monotonicity and an error under one sample are
  what hold — a test asking for an exact round trip is asking for a second
  rounding rule.
- **Both shapes stay revisitable until the first project is saved** (§2.5). Once
  the CRDT is underneath the entities, changing either is a migration.
