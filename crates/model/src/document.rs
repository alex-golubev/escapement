//! The document the project lives in, and the only thing that writes to it.
//!
//! The shape is settled elsewhere and not re-argued here: every collection is a
//! map keyed by identity and the order is a rank (D19), an entity is a map of
//! registers (D15), a name is spelled as 22 base64 characters (D17), and the
//! version is written by the first transaction because it cannot be added
//! afterwards (D13). `.claude/rules/model.md` says what each of them costs when
//! it is broken.
//!
//! **Every write goes through [`Document::edit`] or [`Document::apply`], and
//! nothing else opens a transaction.** Undo is scoped by transaction origin,
//! and a write not carrying ours is simply not on the stack — nothing reports
//! that, at the time or afterwards. One gate is what keeps the two kinds
//! tellable apart: what this user did, and what merely arrived.
//!
//! **Nothing read here refuses a document.** An unreadable field makes its
//! entity absent (D16), and the timeline — which cannot be absent — falls back
//! to its default instead. The single refusal is the version, and it is the
//! caller's to make: a document from a later build holds fields this one would
//! drop, so it is not opened at all (D13).

use std::collections::HashSet;
use std::sync::Arc;

use escapement_time::meter::Meter;
use escapement_time::tempo::Curve;
use yrs::sync::time::{Clock, Timestamp};
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact, TransactionMut, Update,
};

use crate::project::Version;
use crate::timeline::{Tempo, Timeline};

/// The root map, and the only thing in the document reached by name rather than
/// through something else.
const ROOT: &str = "project";

/// What marks a transaction as this user's own doing.
const OURS: &str = "local";

/// The keys, in one place, because a key misspelled at the write is a field
/// absent at the read and neither end says anything.
mod key {
    pub const VERSION: &str = "version";
    pub const NAME: &str = "name";
    pub const TIMELINE: &str = "timeline";
    pub const BEATS_PER_MINUTE: &str = "bpm";
    pub const CURVE: &str = "curve";
    pub const NUMERATOR: &str = "numerator";
    pub const DENOMINATOR: &str = "denominator";
}

/// The tags a [`Curve`] is spelled with. A variant is a word and not a number,
/// so a document written where there are more of them reads as a tag this build
/// does not know, rather than as an index into a list that has moved.
const HOLD: &str = "hold";
const RAMP: &str = "ramp";

/// Why somebody else's update did not go in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejected {
    /// Not an update at all: the bytes did not decode.
    Unreadable,
    /// An update, naming a place in this document that cannot hold it.
    Unusable,
}

/// The clock the undo manager is given, which never reads one.
///
/// Yrs groups edits into one undo step by wall-clock time, and there is no wall
/// clock in this crate to hand it — `UndoManager::new` and `Options::default`
/// are `cfg(not(target_family = "wasm"))` for that reason alone. Nothing here
/// needs one: with the window at zero no two transactions are ever grouped, so
/// the number below is never compared against anything. Grouping a gesture into
/// one step belongs to the interface, which is where a drag has an end.
struct Motionless;

impl Clock for Motionless {
    fn now(&self) -> Timestamp {
        0
    }
}

/// The project, as the thing that is edited rather than the thing that is read.
pub struct Document {
    doc: Doc,
    root: MapRef,
    undo: UndoManager<()>,
}

impl Document {
    /// A new project: a version, a name and a clock that runs at 120.
    ///
    /// Written without our origin, like an update from somebody else and for
    /// the same reason — the document coming into existence is not a thing this
    /// user did that they might take back.
    #[must_use]
    pub fn create(name: &str) -> Self {
        let document = Self::attach(Doc::new());
        document.apply(|txn, root| {
            root.insert(txn, key::VERSION, i64::from(Version::CURRENT.number()));
            root.insert(txn, key::NAME, name);
            let timeline = timeline_map(txn, root);
            write_tempo(txn, &timeline, Tempo::DEFAULT);
            write_meter(txn, &timeline, Meter::FOUR_FOUR);
        });
        document
    }

    /// Somebody else's project, from everything they have.
    ///
    /// Nothing is refused here beyond bytes that are not an update: a document
    /// this build cannot read is one [`Document::version`] answers about, and a
    /// project that will not open is the outcome none of §2.6's rules permit.
    ///
    /// # Errors
    ///
    /// If the bytes are not an update, or name a place this document cannot
    /// hold them in.
    pub fn open(update: &[u8]) -> Result<Self, Rejected> {
        let document = Self::attach(Doc::new());
        document.merge(update)?;
        Ok(document)
    }

    /// The undo manager around a document, which is the half of it that cannot
    /// be built twice.
    fn attach(doc: Doc) -> Self {
        let root = doc.get_or_insert_map(ROOT);
        let mut undo = UndoManager::with_options(UndoOptions {
            // Zero, so that one transaction is one step and the clock above is
            // never consulted.
            capture_timeout_millis: 0,
            tracked_origins: HashSet::new(),
            capture_transaction: None,
            timestamp: Arc::new(Motionless),
            init_undo_stack: Vec::new(),
            init_redo_stack: Vec::new(),
        });
        // The scope first: expanding it is also what puts the manager's own
        // origin in the tracked set, and with ours beside it an untagged
        // transaction is skipped. With ours missing the set holds one origin,
        // and Yrs reads that as "track what carries none" — the untagged writes
        // would go on the stack and this user's own would not.
        undo.expand_scope(&doc, &root);
        undo.include_origin(OURS);
        Self { doc, root, undo }
    }

    /// A change this user made, and can take back.
    fn edit<R>(&self, change: impl FnOnce(&mut TransactionMut, &MapRef) -> R) -> R {
        change(&mut self.doc.transact_mut_with(OURS), &self.root)
    }

    /// A change that arrived: deliberately not on this user's undo stack, since
    /// "undo my last action" is not "undo the last action" (§3).
    fn apply<R>(&self, change: impl FnOnce(&mut TransactionMut, &MapRef) -> R) -> R {
        change(&mut self.doc.transact_mut(), &self.root)
    }

    /// Which shape the document says it was written in, or nothing if it does
    /// not say.
    ///
    /// Both answers are the caller's to refuse on, and this is the one place in
    /// the crate where refusing is right (D13).
    #[must_use]
    pub fn version(&self) -> Option<Version> {
        let txn = self.doc.transact();
        u32::try_from(whole(&self.root, &txn, key::VERSION)?)
            .ok()
            .map(Version::new)
    }

    /// What the project is called. A project nobody has named is called
    /// nothing, which is a name and not an absence.
    #[must_use]
    pub fn name(&self) -> String {
        let txn = self.doc.transact();
        text(&self.root, &txn, key::NAME).map_or_else(String::new, |name| name.to_string())
    }

    /// What the project's clock does.
    #[must_use]
    pub fn timeline(&self) -> Timeline {
        let txn = self.doc.transact();
        let Some(Out::YMap(timeline)) = self.root.get(&txn, key::TIMELINE) else {
            return Timeline::default();
        };
        Timeline::new(read_tempo(&timeline, &txn), read_meter(&timeline, &txn))
    }

    /// The tempo the project opens at.
    pub fn set_tempo(&self, tempo: Tempo) {
        self.edit(|txn, root| {
            let timeline = timeline_map(txn, root);
            write_tempo(txn, &timeline, tempo);
        });
    }

    /// Everything this document is, as an update somebody else can apply.
    #[must_use]
    pub fn state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// Somebody else's update.
    ///
    /// # Errors
    ///
    /// If the bytes are not an update, or name a place this document cannot
    /// hold them in.
    pub fn merge(&self, update: &[u8]) -> Result<(), Rejected> {
        let update = Update::decode_v1(update).map_err(|_| Rejected::Unreadable)?;
        self.apply(|txn, _| txn.apply_update(update))
            .map_err(|_| Rejected::Unusable)
    }

    /// Take back the last thing this user did, and say whether there was one.
    pub fn undo(&mut self) -> bool {
        self.undo.undo_blocking()
    }

    /// Put back the last thing taken back, and say whether there was one.
    pub fn redo(&mut self) -> bool {
        self.undo.redo_blocking()
    }
}

/// The timeline's own map, made if it is not there.
///
/// A document this build wrote always has one. One that arrived might not, and
/// a tempo dropped on the floor would be a control that does nothing — the
/// timeline is the part of the document that cannot be absent (§2.5).
fn timeline_map(txn: &mut TransactionMut, root: &MapRef) -> MapRef {
    match root.get(txn, key::TIMELINE) {
        Some(Out::YMap(timeline)) => timeline,
        _ => root.insert(txn, key::TIMELINE, MapPrelim::default()),
    }
}

fn write_tempo(txn: &mut TransactionMut, timeline: &MapRef, tempo: Tempo) {
    timeline.insert(txn, key::BEATS_PER_MINUTE, tempo.beats_per_minute());
    timeline.insert(
        txn,
        key::CURVE,
        match tempo.curve() {
            Curve::Hold => HOLD,
            Curve::Ramp => RAMP,
        },
    );
}

fn write_meter(txn: &mut TransactionMut, timeline: &MapRef, meter: Meter) {
    timeline.insert(txn, key::NUMERATOR, i64::from(meter.numerator()));
    timeline.insert(txn, key::DENOMINATOR, i64::from(meter.denominator()));
}

/// Field by field, each falling back on its own, and the whole falling back
/// once more if what came out is still not a tempo.
fn read_tempo<T: ReadTxn>(timeline: &MapRef, txn: &T) -> Tempo {
    let beats_per_minute = number(timeline, txn, key::BEATS_PER_MINUTE)
        .unwrap_or_else(|| Tempo::DEFAULT.beats_per_minute());
    // A tag this build does not know holds, which is the reading that invents
    // no ramp nobody asked for.
    let curve = if text(timeline, txn, key::CURVE).as_deref() == Some(RAMP) {
        Curve::Ramp
    } else {
        Curve::Hold
    };
    Tempo::new(beats_per_minute, curve).unwrap_or(Tempo::DEFAULT)
}

/// See [`read_tempo`].
fn read_meter<T: ReadTxn>(timeline: &MapRef, txn: &T) -> Meter {
    let numerator = count(timeline, txn, key::NUMERATOR).unwrap_or(Meter::FOUR_FOUR.numerator());
    let denominator =
        count(timeline, txn, key::DENOMINATOR).unwrap_or(Meter::FOUR_FOUR.denominator());
    Meter::new(numerator, denominator).unwrap_or(Meter::FOUR_FOUR)
}

/// A whole number, however it was spelled.
///
/// Both spellings are accepted because a client with one number type writes a
/// count as a float, and a document that is not wrong should not be read as
/// though it were.
fn whole<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<i64> {
    match map.get(txn, key)? {
        Out::Any(Any::BigInt(number)) => Some(number),
        Out::Any(Any::Number(number)) if number.fract() == 0.0 => Some(number as i64),
        _ => None,
    }
}

/// See [`whole`].
fn number<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<f64> {
    match map.get(txn, key)? {
        Out::Any(Any::Number(number)) => Some(number),
        Out::Any(Any::BigInt(number)) => Some(number as f64),
        _ => None,
    }
}

fn count<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<u16> {
    u16::try_from(whole(map, txn, key)?).ok()
}

fn text<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<Arc<str>> {
    match map.get(txn, key)? {
        Out::Any(Any::String(text)) => Some(text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempo(beats_per_minute: f64) -> Tempo {
        Tempo::new(beats_per_minute, Curve::Hold).expect("a tempo is a tempo")
    }

    fn three_four() -> Meter {
        Meter::new(3, 4).expect("three quarters is a signature")
    }

    /// What a damaged document holds, or one written where a field means
    /// something else. Nothing in the interface can produce these — every value
    /// crosses a constructor on the way in — so the reader's fallbacks have no
    /// other way to be reached.
    fn scribble(document: &Document, key: &str, value: impl Into<Any>) {
        document.apply(|txn, root| {
            let timeline = timeline_map(txn, root);
            timeline.insert(txn, key, value.into());
        });
    }

    #[test]
    fn a_new_document_says_which_shape_it_is_in() {
        let document = Document::create("Ours");

        assert_eq!(document.version(), Some(Version::CURRENT));
        assert_eq!(document.name(), "Ours");
        assert_eq!(document.timeline(), Timeline::default());
    }

    #[test]
    fn the_tempo_a_control_set_is_what_the_document_says() {
        let document = Document::create("Ours");
        document.set_tempo(tempo(90.0));

        assert_eq!(document.timeline().tempo(), tempo(90.0));
        assert_eq!(
            document.timeline().meter(),
            Meter::FOUR_FOUR,
            "and the signature beside it is untouched"
        );
    }

    #[test]
    fn a_ramp_survives_the_document() {
        let document = Document::create("Ours");
        let ramping = Tempo::new(90.0, Curve::Ramp).expect("a tempo is a tempo");
        document.set_tempo(ramping);

        assert_eq!(document.timeline().tempo(), ramping);
    }

    /// The timeline cannot be absent, so every unreadable field here falls back
    /// rather than emptying it — and the fields beside it are still read.
    #[test]
    fn an_unreadable_tempo_falls_back_rather_than_emptying_the_timeline() {
        let document = Document::create("Ours");
        document.set_tempo(tempo(90.0));
        scribble(&document, key::BEATS_PER_MINUTE, "fast");

        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
        assert_eq!(document.timeline().meter(), Meter::FOUR_FOUR);
    }

    /// Not a missing field but a present one holding what is not a tempo, which
    /// is the case the constructor exists for.
    #[test]
    fn a_tempo_no_clock_could_run_at_falls_back() {
        let document = Document::create("Ours");
        scribble(&document, key::BEATS_PER_MINUTE, 0.0);

        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
    }

    #[test]
    fn a_curve_this_build_does_not_know_holds() {
        let document = Document::create("Ours");
        scribble(&document, key::CURVE, "wobble");

        assert_eq!(document.timeline().tempo().curve(), Curve::Hold);
    }

    #[test]
    fn a_signature_this_grid_cannot_hold_falls_back() {
        let document = Document::create("Ours");
        scribble(&document, key::DENOMINATOR, 0_i64);

        assert_eq!(document.timeline().meter(), Meter::FOUR_FOUR);
    }

    /// A document that says what it is rather than leaving it to be assumed.
    ///
    /// Read as registers and not through the projection, because what is
    /// written here is exactly what the reader falls back to — so no timeline
    /// coming out of it can tell a document that said four four from one that
    /// said nothing. What a default is can change; what a document written
    /// today says cannot (D13).
    #[test]
    fn a_new_document_says_its_clock_rather_than_leaving_it_to_be_assumed() {
        let document = Document::create("Ours");
        let txn = document.doc.transact();
        let Some(Out::YMap(timeline)) = document.root.get(&txn, key::TIMELINE) else {
            panic!("a new document has a timeline");
        };

        assert_eq!(number(&timeline, &txn, key::BEATS_PER_MINUTE), Some(120.0));
        assert_eq!(count(&timeline, &txn, key::NUMERATOR), Some(4));
        assert_eq!(count(&timeline, &txn, key::DENOMINATOR), Some(4));
    }

    /// Two fields of one entity, and writing one leaves the other where it was
    /// — which is the whole of what finding the map rather than making it
    /// afresh decides.
    #[test]
    fn a_signature_is_not_disturbed_by_the_tempo_beside_it() {
        let document = Document::create("Ours");
        scribble(&document, key::NUMERATOR, 3.0);
        document.set_tempo(tempo(90.0));

        assert_eq!(document.timeline().meter(), three_four());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
    }

    /// A client with a bigint type writes `3n` as one whatever its size, so
    /// this is an ordinary document rather than a damaged one.
    #[test]
    fn a_number_written_as_a_big_integer_is_a_number() {
        let document = Document::create("Ours");
        scribble(&document, key::NUMERATOR, Any::BigInt(3));
        scribble(&document, key::BEATS_PER_MINUTE, Any::BigInt(90));

        assert_eq!(document.timeline().meter(), three_four());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
    }

    /// A count is whole or it is not a count: three and a half beats to the bar
    /// is a field holding something else, not a signature to round.
    #[test]
    fn a_count_that_is_not_whole_falls_back() {
        let document = Document::create("Ours");
        scribble(&document, key::NUMERATOR, 3.5);

        assert_eq!(document.timeline().meter(), Meter::FOUR_FOUR);
    }

    /// A count written as a float by a client with one number type is a count.
    #[test]
    fn a_whole_number_is_read_however_it_was_spelled() {
        let document = Document::create("Ours");
        scribble(&document, key::NUMERATOR, 3.0);

        assert_eq!(document.timeline().meter(), three_four());
    }

    /// The question of the slice, in the smallest form it has: two people edit
    /// the same field and neither loses the other's document. Which of the two
    /// tempos wins is not this test's business — that both replicas say the
    /// same thing afterwards is.
    #[test]
    fn two_replicas_that_have_seen_each_other_say_the_same_thing() {
        let mine = Document::create("Ours");
        let theirs = Document::open(&mine.state()).expect("a document like this one");

        mine.set_tempo(tempo(90.0));
        theirs.set_tempo(tempo(140.0));
        mine.merge(&theirs.state()).expect("their update");
        theirs.merge(&mine.state()).expect("ours");

        assert_eq!(mine.timeline(), theirs.timeline());
        assert_eq!(mine.name(), theirs.name());
        assert_eq!(mine.version(), theirs.version());
    }

    /// The trap `model.md` is about, from the side that fails quietly: Yrs
    /// tracks by origin, so a change that arrived is not ours to take back —
    /// and if the origins were set up wrongly this test would pass while the
    /// one below failed.
    #[test]
    fn a_change_that_arrived_is_not_ours_to_take_back() {
        let mut mine = Document::create("Ours");
        let theirs = Document::open(&mine.state()).expect("a document like this one");
        theirs.set_tempo(tempo(140.0));

        mine.merge(&theirs.state()).expect("their update");

        assert_eq!(mine.timeline().tempo(), tempo(140.0), "their tempo arrived");
        assert!(!mine.undo(), "and there is nothing of ours to take back");
        assert_eq!(
            mine.timeline().tempo(),
            tempo(140.0),
            "so it is still there"
        );
    }

    #[test]
    fn what_this_user_did_is_theirs_to_take_back() {
        let mut document = Document::create("Ours");
        document.set_tempo(tempo(90.0));

        assert!(document.undo(), "there was something to take back");
        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
        assert!(document.redo(), "and to put back");
        assert_eq!(document.timeline().tempo(), tempo(90.0));
    }

    /// One transaction is one step, which is what the window of zero buys and
    /// what the interface will later group into gestures.
    #[test]
    fn each_change_is_taken_back_on_its_own() {
        let mut document = Document::create("Ours");
        document.set_tempo(tempo(90.0));
        document.set_tempo(tempo(140.0));

        assert!(document.undo());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
        assert!(document.undo());
        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
    }

    #[test]
    fn what_is_not_an_update_is_refused_rather_than_applied() {
        let document = Document::create("Ours");

        assert_eq!(document.merge(&[0xff; 8]), Err(Rejected::Unreadable));
        assert_eq!(
            document.timeline(),
            Timeline::default(),
            "and nothing moved"
        );
    }
}
