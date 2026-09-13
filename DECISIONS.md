# Decisions

Why each decision in `ARCHITECTURE.md` was taken, and what it turned down, in the
order the decisions were made.

**This file is append-only and is not meant to be read through.** It is opened at
one entry, the way a commit is. What is *true* lives in `ARCHITECTURE.md`: the
prose of a section is the current answer, and the short dated block beside it
carries the alternatives that were refused, so that nobody proposes one again.
What lives here is the derivation behind that — needed while a decision is being
made or revisited, and archaeology afterwards.

Split out of `ARCHITECTURE.md` on 2026-09-11. A log kept inside the document it
governs makes that document grow with every decision taken, and that document is
the one that has to be read to be current. Entries are never edited: a decision
that is overturned gets a new entry that says so, and the old one stays where it
is.

---

<a id="d1"></a>

## D1 — 2026-08-25 — LICENSE is PolyForm Shield 1.0.0

*Governs §5.1. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

`LICENSE` is **PolyForm Shield 1.0.0**, not Apache. The
leaning it replaced — Apache 2.0 and a CLA on the engine, with the service kept
closed — rests on an assumption that does not survive inspection: that the
value sits in the service and the engine can be given away. It is the other way
round. The engine — graph, DSP, sampler with voice allocation, warp, CRDT model,
WebGL2 renderer — is years of work; the relay is a websocket server broadcasting
document updates, plus asset storage and accounts, and that is weeks. Apache would
hand a competitor the expensive half and leave them the cheap half to build.

Shield rather than Noncommercial, and the reason is specific to a DAW.
Noncommercial permits personal use only "without any anticipated commercial
application" — which excludes a beatmaker who intends to sell the track. That
restriction lands on the target user rather than on the threat. Shield permits
every purpose except providing a competing product, so music made with the DAW
is unrestricted while the DAW itself cannot be resold or re-hosted.

`LICENSE` carries a `Licensor Line of Business:` line, without which Shield's
Discontinued Products clause would let a competitor in on anything that stops
being offered.

The cost is accepted knowingly: this is not open source by the OSI definition,
and few contributors come to a repository they may not compete with. The CLA
half of the leaning stands unchanged.

---

<a id="d2"></a>

## D2 — 2026-08-26 — File-level copyleft is admissible

*Governs §5.1. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

The rule above splits in two, because copyleft does.
**Whole-program copyleft — GPL, AGPL, SSPL — never**, for the reason already
given. **File-level copyleft — MPL, EPL, CDDL — is accepted**, and an
attribution page is its price.

Forced by Loro, which depends on `im` unconditionally and brings `bitmaps` and
`sized-chunks` with it, all three under MPL-2.0. Dropping them means forking
Loro, which is out of proportion to what they cost.

The two kinds differ in the unit of contagion, not in degree. MPL 1.7 defines a
Larger Work as one combining covered software with other material *"in a
separate file or files"*, and 3.3 permits distributing that Larger Work *"under
terms of Your choice"*. So those three crates keep their license and Escapement
keeps PolyForm. The GPL has no such clause, which is precisely why it stays
refused — the distinction is the whole reason this is a decision rather than an
exception.

The price is 3.2(a), with 3.1 behind it: whoever receives the bundle must be
told, per package, that it is under MPL, where its source is, and where the
license text is. That is a page inside the product rather than a file in the
repository — the recipient of the executable form is a person with a browser,
who has no reason to know the repository exists. Generated from the dependency
tree at build time rather than written by hand: a hand-written list drifts as
dependencies change, and it drifts silently.

---

<a id="d3"></a>

## D3 — 2026-08-29 — A position is an integer count of ticks

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A position is an integer count of ticks, at
**5 765 760 ticks to the quarter** (2^7 · 3^2 · 5 · 7 · 11 · 13). The
alternative on the table was a rational fraction of a bar.

Precision did not decide it. The two differ there by hundredths of a
millisecond, and the error does not accumulate: positions are absolute, so the
hundredth copy of a pattern lands exactly as far out as the first. **The
document decided it.** A rational position is a pair, and (3,2) and (6,4) are
different pairs holding the same number — so two people placing a note on the
same beat can write two different values, which is the class of failure §2.4
exists to avoid. Normalizing on construction fixes that and leaves an invariant which
must then hold through serialization, across the network, and in a client
version not yet written. An integer tick is canonical by construction and has
no such invariant to break.

Two smaller reasons point the same way. Rational addition multiplies
denominators, so it needs reduction — and on the audio thread, checked
arithmetic with invented behaviour on overflow, where `escapement-core` may
not panic. And the conversion running every quantum is samples to position,
which has one natural answer on a fixed grid and none at all without one.

**Rejected: `f64` beats**, as Ableton and Reaper store it. Not among the two
above, and worse than either here — a third of a beat is not representable at
all, and equality of positions is precisely what the document needs.

The resolution is generous on purpose, and the asymmetry is the argument: a
finer grid is always reachable from a coarser one by multiplication, while a
coarser one has already lost what it cannot hold. MIDI's usual values and FL's
— 96, 480, 960 — all divide it exactly, so nothing is lost on import. At `i64`
the ceiling is around a trillion quarter notes, and the cost in the document
is a few bytes per position.

**What this closes is the document, not the type.** The door shuts when the
first project is saved, and §7's slice 2 puts two stages before that: the type
in use with no document, then entities as plain structs with no CRDT beneath
them. So the position is a type with a private field and nothing outside its
crate doing arithmetic on the raw integer — the same cheap insurance §4 buys
for the renderer. Worth revisiting once, before the CRDT goes underneath;
after that it is a migration.

---

<a id="d4"></a>

## D4 — 2026-08-29 — A tempo ramp is linear in beats per minute

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A tempo ramp is **linear in beats per minute**, not in
the period those beats imply.

Not a matter of taste: a ramp is a curve either way, and only one of the two
can be the straight one. The same two tempo marks over the same eight bars —
60 to 180 — part by three and three quarter seconds depending on which. That
is a different place in the song, not a different shade of a curve.

Precision did not decide this one either, though it was expected to. The
closed form for a linear-bpm ramp is a logarithm and its inverse an
exponential, which looked like a threat to the sample-accurate conversion
demanded above. Measured, the round trip through samples costs about 2 x 10^-8
of a sample, and the linear-period form is no better. The objection was
withdrawn rather than answered.

What decides it is that the curve is **drawn**. Tempo is a parameter in beats
per minute, automated like any other, and an automation curve interpolates its
parameter — so a straight line between two tempo marks is straight in beats
per minute. Make the period linear instead and the line someone drew is no
longer the tempo but a curve nobody asked for. The same rule that settled the
representation above: the data means what it says.

**Rejected: linear in the period.** It integrates to a quadratic rather than a
logarithm and inverts through a square root rather than an exponential, which
is marginally cheaper and buys nothing — `escapement-core` already carries
`libm` for the oscillator.

**A segment with no ramp in it is a second formula, not an edge case.** The
integral of a period over position takes one form while the tempo moves and
another while it stands still, and the moving one divides by the rate of
change. At a rate of zero that is not an error to be handled: `f64` division
does not trap, so it gives an infinity, the infinity meets a logarithm of one,
and the result is a NaN — which compares false to everything, sorts nowhere,
and saturates to tick zero on its way to an integer. The start of the project,
silently — the value the oscillator in `escapement-core` already refuses for
the same reason.

So the two kinds of segment are told apart **when the map is built**, in the
model, where allocating and deciding are both allowed; the audio thread reads
which form applies instead of comparing a float against a threshold. A
threshold does exist — the logarithmic form loses precision well before the
rate reaches zero — and choosing where it falls is not a judgement to make
once per quantum.

The time-signature map is not interpolated at all. A signature steps at a bar
line; there is no ramp from 4/4 to 7/8 to have an opinion about.

---

<a id="d5"></a>

## D5 — 2026-09-05 — A tempo is quarter notes per minute

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A tempo is **quarter notes per minute**, whatever the
time signature says. The signature gets no vote in it.

That is what keeps the two maps independent, and the independence is the whole
argument. Let a beat be the signature's denominator instead — the notation
reading, where 6/8 at 120 is counted in dotted quarters — and every conversion
from a position to seconds has to consult the signature map first. Worse, a
signature change then moves every later moment in the song in time: edit one
bar into 7/8 halfway through and the audio after it slides. Nobody editing a
signature is asking for that.

The convention agrees and so does the interchange format: MIDI stores tempo as
microseconds per quarter note, in a message that knows nothing about the
signature beside it. A file that comes in at 120 goes out at 120.

**Rejected: the beat the denominator implies.** It is the musician's reading of
the word, and the wrong one to build on — it couples two maps that otherwise
never have to meet.

The price is one collision of vocabulary, worth naming because it reads as a
mistake: `beat` in the tempo map is a quarter note, `beat` in the bar map is
one unit of the denominator. They are different things on purpose, and the day
they become the same thing is the day the maps stop being independent.

---

<a id="d6"></a>

## D6 — 2026-09-05 — A signature mark is addressed by its bar

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A signature mark is addressed by **the bar it starts
at**, never by a position. Where that bar falls in ticks is counted from the
origin.

The map lives in the CRDT document (§2.4), so the question is not which reads
better but which survives a merge. Take a project in 4/4: one person changes
the opening signature to 7/8 while another adds a signature at bar 5. Addressed
by position, that second mark sits at tick 92 252 160 — but under 7/8 the bar
lines stand 20 180 160 ticks apart, and that tick is 4.571 bars in, which is not
a bar line at all. Both replicas converge, on a document that will not build.
Addressed by a bar, the same two edits merge into four bars of 7/8 followed by
whatever was put at bar 5: perhaps not what either person pictured, but a
project that opens.

The same argument as the tick above, one level up — take the representation in
which the invalid state cannot be written down, because the alternative is an
invariant that has to survive serialization, the network, and a client version
nobody has written yet.

**Rejected: addressed by position, validated when the map is built.** That
validation is exactly the invariant a merge breaks. **Rejected: addressed by
position, repaired on load** — it moves somebody's edit silently, and where it
moves to depends on which client opened the file.

Three consequences, which are the design rather than details of it.

**The document keys its marks; it does not list them.** Two people can put a
signature at bar 5, and a map cannot have two marks in one place. Keyed by bar,
the duplicate cannot be spelled at all and the CRDT settles the conflict per
key. The tempo map goes the same way, keyed by position.

**Bars count from one and keep counting backwards.** A count-in sits before the
first bar — which is why a position is signed — so bar zero and the ones below
it hold the first signature, the rule the tempo map already follows behind its
first mark.

**Nothing in the bar map is floating point.** A bar is a whole number of ticks,
the running total is exact, and a position that goes out as a bar and a beat
comes back the tick it was. The constraint that buys it lands on the
denominator, which has to divide a whole note: the resolution grants every
power of two through 512, and thirds, fifths, sevenths, elevenths and
thirteenths besides. A signature outside that is refused rather than rounded.

And a beat in the display is **one unit of the denominator** — 6/8 has six of
them. The grouping a compound signature is felt in, 6/8 as two dotted quarters,
is accent and drawing rather than time: it wants a field this type does not
have, and adding one moves no bar line.

---

<a id="d7"></a>

## D7 — 2026-09-05 — A position converts to the sample it falls in

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A position converts to **the sample it falls in** —
`floor(seconds x rate)` — and the sample rate is a parameter of the
conversion, never a field of the map.

**Two sample counts exist and they are not the same number.** The engine's
clock counts samples since the engine was built: unsigned, monotonic, running
whether or not the transport is. A converted position counts samples from the
timeline's origin, and it is signed, because a count-in sits before bar one.
Different origins, different types, and nothing may quietly turn one into the
other.

**The rate is not part of the tempo map**, because the map is physical — it
answers in seconds — and because the offline render for export (§7) drives the
same engine at a rate of its own choosing. A map that knew the rate could not
serve both, and the one place where the multiplier and the rounding live is a
type that carries the rate rather than the map.

The rounding is not a preference among three. Sample *n* covers the half-open
interval from `n/rate` to `(n+1)/rate`, so "which sample is this moment in"
has exactly one answer, and `floor` is it.

**Rejected: truncation toward zero**, which is what an unguarded cast does.
The scale is signed for the count-in, and truncation folds the two samples
either side of the origin into one of double width — so everything before bar
one lands a sample late, silently, in the region the sign exists for.

**Rejected: the nearest sample.** It moves the boundary to the middle of a
sample, and the question every block asks — is this event inside `[start,
end)` — then admits an event whose position is before the block began.

**The two directions are not each other's inverse, and that is not a defect to
repair.** A tick is a fraction of a sample: 240 of them at 48 kHz and 120
quarters to the minute. Going the other way lands on the nearest tick, which
can sit just behind a sample boundary, and `floor` then answers with the
sample before. What holds is monotonicity and an error below one sample; an
exact round trip is not available and pretending otherwise would cost a second
rounding rule. The scheduler's question — the first sample **not before** a
position — is a different question, and it gets its own name on the day the
sequencer asks it rather than a rounding mode today.

---

<a id="d8"></a>

## D8 — 2026-09-05 — An audio clip's trim is a third count

*Governs §2.5. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An audio clip's trim into its source is a **third
count, in the source's own frames**, and never a musical span.

Two sample counts already exist and turning one into the other is a bug
(above). A point inside a file is a third: its zero is the start of the file,
its rate is the file's own, and nothing relates it to the timeline until the
clip is warped, which is what slice 4 builds (§7). Spell the trim as a span of
ticks and every audio clip is stretched by whatever the project tempo happens
to be — with no stretching code anywhere to blame for it.

---

<a id="d9"></a>

## D9 — 2026-09-05 — A one-ended edge is a register on the many side

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An edge that must have exactly one end lives as a
**register on the many side**, never as a list on the one side. A channel
holds the insert it feeds; a clip holds the lane it sits on.

The three entities above are distinct, but the arrow between two of them is
many-to-one: several channels share an insert, and no channel is in two. Put
the edge on the insert instead, as a list of the channels it takes, and that
stops being true the moment two people move one channel to two different
inserts — the merge keeps both, and a channel feeding two inserts is a state
the audio graph has no reading of. As a register the same pair of edits
converges on one of the two, which is a choice somebody made rather than a
state nobody can mean.

Genuine many-to-many appears only between inserts, where a send is an entity
of its own. Deferred, and with it the question of a cycle — which on the audio
thread is not a wrong mix but a call that does not return.

---

<a id="d10"></a>

## D10 — 2026-09-05 — Ordered only where the order is the data

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

The document is a **movable list only where the order
is itself the data**, and a **map keyed by identity everywhere else**.

Lanes, channels and inserts are ordered because a person arranged them, and
preserving that arrangement under a concurrent reorder is what §2.4 weighed
the libraries on. Clips, notes and automation points are not
ordered at all; they have a position. Hold them in a list and every insertion
has to be merged at an index that means nothing, so two people adding a note
to the same bar conflict over a place neither of them chose. Held in a map
they cannot conflict, and moving a note is editing two registers.

The two maps of §2.5 arrived here from the other end and with a sharper
reason: `build` refuses two marks in one place, so a list of marks can hold a
document that stops opening.

---

<a id="d11"></a>

## D11 — 2026-09-05 — Identity is 128 random bits

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An entity's identity is **128 random bits**, minted
locally, behind an opaque type — a private field and two methods at the
serialization boundary, as `Position` has (§2.5).

A counter needs somebody to hand out the numbers, and §2.4 promises a document
that survives a wifi drop: two people offline both reach four, and the merge
is one entry carrying the fields of two patterns with nothing left to record
that there were two. A pair of "who I am" and a private counter repairs that
and halves the key — about eleven characters against twenty-two, a hundred
kilobytes on ten thousand notes — but the counter has to survive a reload, and
a counter that does not produces the same unrepairable collision in silence.
Randomness has no state to get wrong.

**Rejected: the library's own identifiers.** They save writing any of this,
and they make the entities unable to exist without the CRDT — while §7 puts
them as plain structs one stage *before* it, precisely so that slice 2 tests
the bet instead of assuming it. The bet was tested and the library changed
(§2.4, 2026-09-07); this is the block that made that a swap rather than a
rewrite.

**An asset is the exception: its identity is the hash of its bytes** (§2.4).
Mint one and the same loop imported by two people becomes two entries, which
is the deduplication of a content-addressed store thrown away at the only
point where it was free.

What the opaque type buys is a change of shape up to the first saved project;
after that it is a migration, the same door §2.5 describes. So the weight is
worth measuring in slice 2, while the door is still open.

---

<a id="d12"></a>

## D12 — 2026-09-05 — A dangling reference is legal

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A **dangling reference is a legal state of the
document**, and every read of one answers with an absence rather than a value.

A deletes a pattern while B places its twenty-first instance. Both edits are
legal, both merge, and the result is a clip pointing at nothing. No CRDT
prevents this — the two edits never met — so the model does not pretend it
cannot happen: resolving a reference returns an option, the sequencer skips
what does not resolve, and the interface draws the hole.

**A channel whose insert is gone is silent, and does not fall back to the
master.** A merge that reroutes audio nobody rerouted is worse than one that
stops it where somebody can hear that it stopped.

This is a decision about every read site rather than about a type, which is
why it belongs here. Found later, it is a signature change through the whole
model.

---

<a id="d13"></a>

## D13 — 2026-09-05 — The document carries its own version

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

The document carries **its own version number**, from
the first struct.

§3 puts a version in the header of the shared region because a fresh reader
meeting a stale writer otherwise parts company as a misread rather than as a
message. A project outlives a client version by years, so the same argument
applies with more force. Every shape §2.5 and this section leave revisitable
shuts at the first saved project, and what makes that door openable again is a
document that says which shape it was written in. One integer now; it cannot
be added later, because the documents that would need it are exactly the ones
already written.

---

<a id="d14"></a>

## D14 — 2026-09-05 — A command's moment is a sample count

*Governs §3, under “What lives in that memory”. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A command's moment is a **sample count on the engine's
clock**, not a musical position. Musical time crosses this boundary as the
payload of the commands that carry a place in the song, never as their
schedule.

The requirement this comes from already separates the two: *start at position
P at time T*. P is where in the song the transport should land; T is when the
instruction takes effect. `when` is T, and it is a question about the audio
device rather than about music.

Three things follow, and each is enough on its own. The audio thread cannot
resolve a musical moment without the tempo map, and the map does not cross
this boundary yet — a musical `when` would make every command undeliverable
until it does. Resolving one costs a search and a logarithm, per command per
quantum, against an integer comparison. And `0` already means *as soon as it
is seen*, a sentinel that works only because zero is not a moment the clock
will reach again; on a musical scale zero is bar one, a position people
actually use.

**The objection is that the tempo may change between sending and firing**, and
it holds only against a long horizon. This is not one: the ring is drained
before every quantum, so the horizon is a block or two. The long horizon
belongs to the sequencer, which the split below puts on the model thread with
the document.

**Rejected: a tagged moment** — samples or a position, told apart by a
discriminant. It buys a branch on the audio thread and complicates a decode
deliberately built so that it cannot fail.

A consequence rather than a doubt: should the sequencer later move onto the
audio thread — where most DAWs end up, because a descheduled worker cannot
deliver a sample-accurate event — `when` does not change, since the schedule
of an instruction stays physical. What changes is that the tempo map has to
cross the boundary regardless.

---

<a id="d15"></a>

## D15 — 2026-09-06 — An entity is a map of registers

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An entity in the document is a **map of registers, one
per field**, never one value holding the whole entity.

Two people at one mixer change different things about one channel far more
often than they change the same thing, and a whole-entity value cannot keep
both: the merge picks a writer, and the other edit is gone with nothing left
to say it was made. Per field both survive, and the pair that genuinely
collides converges the way a register always does. The identity block above
already assumes this where it says moving a note is editing two registers;
this makes it the rule for every entity rather than for that one.

**The price is memory, and it falls the opposite way from the fear.** §2.4
names automation as where naive CRDT use explodes "in memory and traffic".
Measured: registers cost 1.6x the saved document and a little over twice the
memory, and 2.6x *less* traffic while a curve is drawn — a moved point sends
the field that moved rather than the point that holds it. Only one of the two
axes gets worse, and it is the one with room.

**Rejected: the whole entity as one value.** It is smaller, and it loses
edits.

A consequence worth having: how often the document is committed does not
reach the wire. A drag exports the same bytes committed once at the end as
committed after every point, so the rate a curve is drawn at is the
interface's business and nobody else's.

---

<a id="d16"></a>

## D16 — 2026-09-06 — An unreadable field makes its entity absent

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A field the document holds but no constructor accepts
takes its entity with it: **the entity reads as absent.**

A gain outside its range, a denominator that does not divide a whole note, a
tempo of zero. Nothing writing through this model produces one — every edit
takes a type that was checked when it was constructed, and a merge chooses
between two values that were both legal when written — so the source is a
bug, a damaged file, or a client version the version number already turns
away. What matters is therefore not preventing it but what the reader does,
and one answer costs nothing at all: absence is a state every read site
already handles, because a dangling reference is legal (above). Refusing the
document instead is the failure this whole section is written to avoid.

**The timeline is the exception, because absence is not available to it.** It
is the one part of the document that cannot be empty, so a tempo or a
signature that will not read falls back to the default rather than taking the
clock away with it. That is the guarantee the opening marks already carry, met
from the other side: no document that can be written yields a map that
refuses to build.

**Rejected: clamping into range.** It invents a value nobody wrote and hides
the bug that wrote the other one, and where it lands depends on which client
opened the file — the objection that already rejected repairing a signature on
load (§2.5).

---

<a id="d17"></a>

## D17 — 2026-09-06 — Identity is spelled as 22 base64 characters

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

Identity stays 128 random bits, spelled in the
document as **22 base64 characters**. The weight left to be measured above is
measured.

Ten thousand notes: halving the width, which is what the peer and counter buy,
saves 19% of the saved document; changing only the alphabet at full width — 32
hexadecimal characters against 22 — costs 2.1%. The width is worth something
and the spelling is not, which leaves the spelling to be chosen on legibility.

**The estimate above was low by half, for a structural reason.** It counted a
key once. A key is stored once per occurrence, and every reference between
entities is a name: a note carries its own and its channel's, a clip its own
and its lane's and its source's. The multiplier is the number of references,
so it grows with the shape of the document rather than with the count of
things in it.

Nineteen per cent does not buy back what the counter costs. One that fails to
survive a reload gives the same unrepairable collision in the same silence,
and the door this measurement was to be taken through stays where it is.

---

<a id="d18"></a>

## D18 — 2026-09-07 — Yrs over Loro, and order as a rank

*Governs §2.4. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

**Yrs**, and what it does not have — an operation for
moving an element — is bought back by holding the order **as a rank inside the
entity** rather than as a place in a list (§2.6).

Measured under this build — `build-std`, `+atomics`, shared memory, then
`wasm-opt -Oz` and brotli, which is what a browser is actually sent. The
document is 32 channels, 32 inserts, 16 lanes, 8 patterns of 500 notes, 200
clips and 4 curves of 500 points, written in the shapes §2.6 fixes.

| | added to the bundle | project on the wire | live heap |
|---|---|---|---|
| Yrs 0.27 | **+146 KiB** | **152 KiB** | 10.5 MiB |
| Loro 1.16 | **+630 KiB** | 264 KiB | 9.4 MiB |

The weight is the visible difference and it is not the argument. Three things
are.

**The movable list had shrunk to three collections.** §2.6 puts lanes,
channels and inserts in a list because a person arranged them, and everything
there are thousands of — clips, notes, automation points, both time maps — in
a map keyed by identity. So Loro's one exclusive feature covers three
collections of tens of items, and the rank covers them at the cost named
below. The criterion above predates that decision by twelve days.

**What the missing move actually costs is not duplicates.** Two people
dragging one track under delete-plus-insert do produce the duplicate §2.4
named, and a reader can collapse it. The sharper failure has no reader-side
repair: a list holds entities, an entity is a map of registers, and
re-inserting it means building a **new** map — so a concurrent edit to the old
one lands on a tombstone and is gone. Over 2000 random rounds of two replicas
each moving and editing, the list shape lost **432 of 3474 edits**; both
replicas converged on every one of them, so a convergence property would have
passed. With the rank, the same 2000 rounds lost **none**.

**The retreat is asymmetric, and that is what settles it.** Leaving Loro means
rewriting the model, which §2.4 has said from the start. Finding the rank
insufficient means migrating three small collections, because the order is a
field we own — the same insurance §2.6 bought by minting our own identities
instead of taking the library's, and the reason that block is now load-bearing
rather than fastidious.

**Rejected: Loro.** It is right by construction on the one thing this trades
away, and that is worth saying plainly: taking Yrs means owning a rank
generator and its properties, roughly a hundred and fifty lines, where Loro
ships them tested. It also has the more compact update encoding (475 KiB of
full history against 704) and shallow snapshots, which a project accumulating
years of history will eventually want. What it does not have is a second
implementation of its format, and §2.6 requires a document that opens years
after the client that wrote it.

**What does not separate them.** Author-scoped undo — both have it, measured
on both. Automation — a 600-edit drag costs 15 bytes an edit on the wire and
kilobytes an edit in heap **on both**, so the soft lock below is needed either
way and is not an argument for either library.

---

<a id="d19"></a>

## D19 — 2026-09-07 — An ordered collection is a map plus a rank

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An ordered collection is a **map keyed by identity
whose entities carry a rank**, and there is **no list in the document at
all**. Reading one in order is sorting by rank, ties broken by identity;
moving something is writing one register.

This replaces "a movable list" in the block above with the same guarantee
spelled differently, and it follows §2.4 taking a library with no move
operation. Without a move, a reorder is a delete and an insert; the entity is
a map of registers, so the insert has to build a **new** map, and whatever
somebody else was writing to the old one lands on a tombstone. Measured: 432
of 3474 edits gone over 2000 random rounds, with both replicas agreeing every
time. As a rank the same 2000 rounds lose nothing, because the operation that
loses them cannot be spelled.

What makes this cheap rather than a concession is that §2.6 had already put
everything numerous in a map. Three collections change shape — lanes,
channels, inserts — and the document comes out **more** uniform than it was:
every collection is a map, and order is a field like gain is a field.

The rank is an opaque type, as `Position` and the identity are, and it is
the one place in the document where a value's *ordering* is its meaning —
so it is compared, never parsed, and never read as a number.

---

<a id="d20"></a>

## D20 — 2026-09-07 — The sample buffer is a fourth section

*Governs §3, under “What lives in that memory”. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

A sample buffer is **a fourth section of the region**,
described by two words of the header, filled by the interface through a typed
array of its own and named by a command.

---

<a id="d21"></a>

## D21 — 2026-09-07 — The MPL entry leaves the allow-list

*Governs §5.1. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

The dependency that forced this left with Loro (§2.4).
The Yrs tree is MIT and Apache-2.0 throughout: `cargo deny check licenses`
passes with `MPL-2.0` struck from the allow-list, checked before the entry was
removed.

**The distinction above stands; the allow-list does not keep an entry nothing
uses.** File-level copyleft is still admissible and is added back the day
something is worth taking under it, with the attribution page as its price —
the argument was general and the decision was not a one-off exception. What
the entry costs while unused is the wrong signal: an allow-list is read as a
statement about what the product contains.

**The attribution page does not go away with it.** MIT and Apache-2.0 require
the notice too, so it was always owed; 3.2(a)'s link to the source was the
sharpest version of an obligation the tree already carried, not the only one.
What does go away is the open question of 3.2(b) against PolyForm, which no
longer has anything to be asked about.

One point is left open on purpose. MPL 3.2(b) permits sublicensing the
executable form under other terms *"provided that the license for the Executable
Form does not attempt to limit or alter the recipients' rights in the Source
Code Form"*. PolyForm restricts competing use of Escapement, not of `im`, which
remains available to the recipient under MPL untouched — so on a plain reading
there is no conflict. It is still a sentence worth a lawyer before the first
public build, and not one to settle here.

Unlike the rest of this section, the rule no longer rests on remembering it.
`deny.toml` is the allow-list, and CI refuses a license that is not on it.

---

<a id="d22"></a>

## D22 — 2026-09-10 — The state block carries the engine's own reading

*Governs §3, under “What lives in that memory”. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

The block carries **the engine's own reading of what it
was told**, not only what it produced. Gain and the oscillator's frequency join
the meter, the clock and the transport there, and the offline render for export
is built from the block rather than from the numbers the interface sent.

They are not the same numbers. `set_gain` clamps, the oscillator refuses a
frequency it cannot produce, and both leave the value before them standing — so
what is heard is a function of every command so far, and the value a refusal
fell back to is history the interface never kept. An engine rebuilt from the
last command starts at its own default instead: 440 Hz against the 330 Hz that
is playing, in a file offered as what was heard, with nothing anywhere to point
at.

**Rejected: acknowledgement counters.** The interface knows what it sent and
the block already reports how many commands were applied, so the export could
have waited for the two to agree and then trusted its own numbers. They agree
in exactly the case that breaks — a refused command is an applied one.

**This is not a licence to echo every parameter.** What belongs here is what
the engine alone knows. A mixer channel does not: it comes from the document,
and the export will render from the same snapshot the engine plays from. The
frequency leaves with the oscillator.

---

<a id="d23"></a>

## D23 — 2026-09-11 — An audio clip names the channel it is heard through

*Governs §2.6. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

An audio clip in the playlist holds **the channel it plays through**, and the
hash of the bytes stays in `ChannelSource` alone. Dropping a file on the
timeline therefore makes a channel, the way it does in FL.

What it replaces was not another design but the absence of one.
`ClipSource::Audio` named an asset, `ChannelSource::Sampler` named an asset, and
that was the only place the two met — so the route from a clip to a mixer insert
would have had to be **inferred from a hash**, and two channels may hold the same
one. Read one way the clip plays twice, read the other it plays through neither;
both readings are defensible, which is what makes the inference a decision
nobody took.

The shape of the rest of the document is what settles it. A note names the
channel it sounds on. A curve addresses a channel or an insert. Only an audio
clip addressed nothing — so it had no gain, no pan, no mute and no output, and
automation could not reach it at all, because `Target` has no variant for a
clip. Naming a channel gives it all five at once, from entities that already
have them, and adds nothing to `Target`.

It also answers the edge rule (D9), which a shared hash does not. Many clips to
one channel is a register on the many side: the clip holds the name, and two
people dropping the same file in two places write two clips rather than one
contested entity.

**Rejected: a channel reference beside the asset** — `Audio { asset, trim,
channel }`. The clip stays readable without a hop through the channel, which is
the whole of what it buys. The cost is two names for one file in one document,
and therefore a state where they disagree: a clip naming `kick.wav` on a channel
playing `snare.wav`. Which of them is heard is a third decision, and unlike the
first two it would be taken by a merge rather than by a person.

**Why no test found this, and none could.** The entities have no reader. A test
can say that `Clip::source()` returns what was put in it, and every test here
did. What finds it is the first consumer that has to decide where an audio
clip's samples go — the sequencer — and that consumer is what slice 1's tail is
now building. The question stood open from 2026-09-05 to 2026-09-11 with 5082
lines of tests in the tree and no way for any of them to reach it.

---

<a id="d24"></a>

## D24 — 2026-09-11 — Both paths are driven from one projection of the document

*Governs §3 and §7. The answer and what it refused are in `ARCHITECTURE.md`;
this is the argument.*

What is played and what is exported both come from **`Playback`, the projection
of the document** — the engine is told what it says, and the file is rendered
from the same value. Neither reads a control, and neither reads a parameter back
out of the state block.

D22 put the engine's own reading of what it was told into the state block, and
closed by saying what does not belong there: a mixer channel comes from the
document, and the export will render from the same snapshot the engine plays
from. This is that sentence arriving. `gain` and `frequency_hz` leave the block,
which keeps what the engine alone knows — the clock, the transport position, the
peak, the counters and the publication echo.

**The divergence D22 was guarding against cannot happen on this path**, and
that is why the echo is not needed. A gain crossed `mixer::Gain` before it
reached the document, a pan crossed `mixer::Pan`, a tempo crossed
`timeline::Tempo`; each of them refuses what is not a value, and what the
document holds is therefore something the engine has no reason to turn away.
The refusals that mattered in D22 were the oscillator's Nyquist check and a
gain clamp on a control wired straight to the wire — both of which left with
the oscillator.

**Rejected: echoing the mixer back through the state block.** Three strips of
three fields each is nine more words, published every quantum, for a divergence
that the document's own constructors have already made unrepresentable. D22
named this and refused it in advance.

**Rejected: the page keeping its own copy of what it sent.** That is where slice
1 started, and `.claude/rules/interface.md` has the failure: a control is an
input, a page in a background tab sends fifteen frames in three minutes, and the
copy and the engine part company with nothing to point at.

What this does cost: a control now sends the document rather than its own
argument, so one slider movement is five commands instead of one. The ring is
sized for a burst and drains sixteen a quantum, so a person dragging a fader at
sixty frames a second is using a twentieth of it.

---

<a id="d25"></a>

## D25 — 2026-09-11 — A channel and an insert pan by different laws

*Governs §2.6, in the engine rather than in the document. The answer and what it
refused are in `ARCHITECTURE.md`; this is the argument.*

A **channel** places a mono source between the speakers, so its law is **equal
power**: the two sides are the cosine and the sine of one angle, their squares
sum to one, and the centre is −3 dB on each side. An **insert** is handed a
stereo signal and can only lean it, so its law is a **balance**: the centre is
untouched, and hard over silences the far side.

One law for both is the obvious simplification and it is wrong in opposite
directions. Give the insert the channel's law and every neutral strip on the
route costs 3 dB — a project through a channel, a bus and a master comes out 9 dB
down, and nothing in the document says why. Give the channel the insert's law and
a source panned hard over is as loud on one side as it was in the middle on two,
so panning a sound makes it louder.

**The document holds neither law.** `mixer::Pan` is a position between the
speakers, and what that position does to a signal is the engine's — which is
what lets a stereo channel, when one arrives, take the balance law without the
document changing at all.

---

<a id="d26"></a>

## D26 — 2026-09-13 — A rank is a base-256 fraction with the peer on the end

*Governs §2.4 and §2.6. The answer and what it refused are in
`ARCHITECTURE.md`; this is the argument.*

§2.4 says the rank generator is ours and names its three properties: a key
strictly between two keys, a longer key when there is no room, and the peer on
the end. This is how they are met, and why the off-the-shelf answer was not
taken after all.

**The representation.** A non-empty string of bytes, compared the way two
strings are — a fraction written in base 256 after the point. One invariant:
**the last byte is never zero.** It is not tidiness. Without it the pair
`[0x40]` and `[0x40, 0x00]` is representable, those are the same fraction
written twice, and there is no key strictly between them at all — so the
generator would need an answer for "these two neighbours have no room", which
is an ordinary drag with nothing to do. Refused at the reader instead, the pair
cannot arise.

**Minting between two keys.** Walk the two in step while their bytes agree,
copying them. At the first place they differ: if there is a byte strictly
between the two, take the middle of them and stop; if they are adjacent, take
the lower one and go on past the end of the lower key, which is the "longer key
when there is no room" case. Below a key with no lower bound, halve its last
byte — or, when that byte is 1, replace it with zero and append. Above a key
with no upper bound, raise its last byte, and only widen when the byte is full:
a collection built by appending stays one byte wide for 127 entries instead of
growing a byte an entry.

**The peer, and why appending it is safe.** The client identifier goes on the
end of the minted key — eight bytes, the whole of it, because a truncated one
would collide by construction rather than by chance and the width is nothing
against a collection a person arranged by hand. That it leaves the key where it
was put is not obvious and is the reason this entry exists: in **every** branch
above, the minted key is made **strictly** smaller than the upper bound at a
position inside its own length, so anything appended after that position keeps
it below; and it is above the lower bound either at such a position or by having
the lower bound as a proper prefix, which appending cannot undo either. The one
adjustment is a client identifier ending in a zero byte, which would break the
invariant above — a `1` goes after it, and the mapping from identifier to tail
stays one-to-one because the two cases have different lengths.

**The peer rather than random bytes**, which is what Loro's fork uses. A peer
cannot collide with itself, and it does not need to: two mints into one gap from
one replica happen one after the other, and the second sees the first as its
neighbour. Only concurrent mints can agree, and those come from different
replicas by definition. Taking the peer also costs no plumbing — yrs already
mints a 53-bit client identifier per document, from the browser's generator on
the platform that has one — and it makes a rank deterministic, so a test can
write one down.

**Why not the ready-made crate.** `fractional_index` (jamsocket, MIT, no runtime
dependencies) has no peer on the end, and one cannot be added from outside: its
keys end in a terminator byte, so bytes appended after it are read as part of
the fraction, and its `new_between` leaves no room reserved for them. Loro's
fork solves exactly that — it moved the terminator into the middle and gave
`new_between` a minimum gap — but it reaches its randomness through `rand 0.8`
in its public API, which brings `getrandom` without the `js` feature and does
not compile for `wasm32-unknown-unknown` at all; and its decoder accepts any
bytes, so the panics inside its generator become reachable from a document that
arrived. The whole of what was taken instead is 110 lines.

**What the properties are worth is in the tests, not here.** The generator is
shaken by `proptest`: a key lands between whichever ends it was given, two peers
never mint one key, a gap can be filled sixty-four times over, and every minted
key is one the reader takes back. The document above it is shaken the same way,
and `the_reorder_a_list_would_have_forced_loses_the_edit_beside_it` is the test
that shows why a convergence property alone would have been worth nothing —
D19's measurement, in the form a test can keep.
