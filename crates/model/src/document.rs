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
//!
//! **A collection is a map and the order is a rank, so a reorder writes one
//! register** (D19). Nothing here deletes an entity and builds it again, which
//! is the operation a list would need and the one that drops whatever somebody
//! else was writing to the old map.

use std::collections::HashSet;
use std::sync::Arc;

use escapement_time::meter::Meter;
use escapement_time::tempo::Curve;
use yrs::sync::time::{Clock, Timestamp};
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact, Transaction,
    TransactionMut, Update,
};

use crate::asset::AssetHash;
use crate::mixer::{Channel, ChannelSource, Gain, Insert, Pan};
use crate::project::Version;
use crate::rank::Rank;
use crate::timeline::{Tempo, Timeline};
use crate::{Entropy, Id};

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
    pub const MASTER: &str = "master";
    pub const TIMELINE: &str = "timeline";
    pub const BEATS_PER_MINUTE: &str = "bpm";
    pub const CURVE: &str = "curve";
    pub const NUMERATOR: &str = "numerator";
    pub const DENOMINATOR: &str = "denominator";
    pub const INSERTS: &str = "inserts";
    pub const CHANNELS: &str = "channels";
    // The registers an entity is made of. `NAME` above is one of these too: in
    // the root it is the project's, in an entity's map it is the entity's, and
    // one key spelled twice is one key to misspell.
    pub const GAIN: &str = "gain";
    pub const PAN: &str = "pan";
    pub const MUTE: &str = "mute";
    pub const RANK: &str = "rank";
    pub const KIND: &str = "kind";
    pub const HASH: &str = "hash";
    pub const OUTPUT: &str = "output";
}

/// The tags a [`Curve`] is spelled with. A variant is a word and not a number,
/// so a document written where there are more of them reads as a tag this build
/// does not know, rather than as an index into a list that has moved.
const HOLD: &str = "hold";
const RAMP: &str = "ramp";

/// The one tag a [`ChannelSource`] has so far. A word rather than a number for
/// the reason above, and an enum rather than a bare hash so that the
/// instruments of §2.3 arrive as a second tag instead of as a change to every
/// channel that was ever written.
const SAMPLER: &str = "sampler";

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
    /// Where the name of a new entity comes from.
    ///
    /// Held here rather than passed to each call that makes one: naming an
    /// entity belongs to whatever owns it, and a source reaching every call
    /// site is a source somebody eventually reaches for twice.
    entropy: Box<dyn Entropy>,
}

impl Document {
    /// A new project: a version, a name, a clock that runs at 120, and the
    /// master everything is heard through.
    ///
    /// Written without our origin, like an update from somebody else and for
    /// the same reason — the document coming into existence is not a thing this
    /// user did that they might take back.
    ///
    /// The master is made here because a project without one is silent, and a
    /// document that says which insert it is beats one that leaves it to be
    /// assumed (D13). It is a name like any other afterwards: deletable,
    /// and then the project is silent in a way the document accounts for.
    #[must_use]
    pub fn create(name: &str, entropy: impl Entropy + 'static) -> Self {
        let mut document = Self::attach(Doc::new(), Box::new(entropy));
        let master: Id<Insert> = Id::mint(&mut *document.entropy);
        let rank = Rank::after(None, document.peer());
        document.apply(|txn, root| {
            root.insert(txn, key::VERSION, i64::from(Version::CURRENT.number()));
            root.insert(txn, key::NAME, name);
            root.insert(txn, key::MASTER, master.spell());
            let timeline = map_under(txn, root, key::TIMELINE);
            write_tempo(txn, &timeline, Tempo::DEFAULT);
            write_meter(txn, &timeline, Meter::FOUR_FOUR);
            let inserts = map_under(txn, root, key::INSERTS);
            let fields = write_entity(txn, &inserts, master, &rank, "Master");
            write_strip(txn, &fields, Gain::UNITY, Pan::CENTRE, false);
            map_under(txn, root, key::CHANNELS);
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
    pub fn open(update: &[u8], entropy: impl Entropy + 'static) -> Result<Self, Rejected> {
        let document = Self::attach(Doc::new(), Box::new(entropy));
        document.merge(update)?;
        Ok(document)
    }

    /// The undo manager around a document, which is the half of it that cannot
    /// be built twice.
    fn attach(doc: Doc, entropy: Box<dyn Entropy>) -> Self {
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
        Self {
            doc,
            root,
            undo,
            entropy,
        }
    }

    /// Which replica this is, which is what goes on the end of a rank so that
    /// two people filling one gap do not mint one key (D26). Yrs mints it at
    /// random, from the browser's generator on the platform that has one.
    fn peer(&self) -> u64 {
        self.doc.client_id().get()
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
            let timeline = map_under(txn, root, key::TIMELINE);
            write_tempo(txn, &timeline, tempo);
        });
    }

    /// The name of the insert everything is finally heard through.
    ///
    /// A name nothing answers to when the register is gone or unreadable, which
    /// is a project that is silent rather than a document to refuse: the master
    /// is a name like any other and a merge may leave it dangling (§2.6).
    #[must_use]
    pub fn master(&self) -> Id<Insert> {
        let txn = self.doc.transact();
        text(&self.root, &txn, key::MASTER)
            .and_then(|name| Id::read(&name))
            .unwrap_or(Id::from_bits(0))
    }

    /// The inserts, in the order they were arranged in.
    #[must_use]
    pub fn inserts(&self) -> Vec<(Id<Insert>, Insert)> {
        self.arranged(key::INSERTS, read_insert)
    }

    /// The channels, in the order they were arranged in.
    #[must_use]
    pub fn channels(&self) -> Vec<(Id<Channel>, Channel)> {
        self.arranged(key::CHANNELS, read_channel)
    }

    /// A new insert, at the end, under a name nobody else will mint.
    pub fn add_insert(&mut self, insert: &Insert) -> Id<Insert> {
        let name = Id::mint(&mut *self.entropy);
        let rank = self.appended(key::INSERTS);
        self.edit(|txn, root| {
            let inserts = map_under(txn, root, key::INSERTS);
            let fields = write_entity(txn, &inserts, name, &rank, insert.name());
            write_strip(txn, &fields, insert.gain(), insert.pan(), insert.mute());
        });
        name
    }

    /// A new channel, at the end, under a name nobody else will mint.
    pub fn add_channel(&mut self, channel: &Channel) -> Id<Channel> {
        let name = Id::mint(&mut *self.entropy);
        let rank = self.appended(key::CHANNELS);
        self.edit(|txn, root| {
            let channels = map_under(txn, root, key::CHANNELS);
            let fields = write_entity(txn, &channels, name, &rank, channel.name());
            let ChannelSource::Sampler(hash) = channel.source();
            fields.insert(txn, key::KIND, SAMPLER);
            fields.insert(txn, key::HASH, hash.spell());
            fields.insert(txn, key::OUTPUT, channel.output().spell());
            write_strip(txn, &fields, channel.gain(), channel.pan(), channel.mute());
        });
        name
    }

    pub fn set_insert_gain(&self, name: Id<Insert>, gain: Gain) {
        self.write(key::INSERTS, name, key::GAIN, amplitude(gain));
    }

    pub fn set_insert_pan(&self, name: Id<Insert>, pan: Pan) {
        self.write(key::INSERTS, name, key::PAN, position(pan));
    }

    pub fn set_insert_mute(&self, name: Id<Insert>, mute: bool) {
        self.write(key::INSERTS, name, key::MUTE, Any::from(mute));
    }

    pub fn set_channel_gain(&self, name: Id<Channel>, gain: Gain) {
        self.write(key::CHANNELS, name, key::GAIN, amplitude(gain));
    }

    pub fn set_channel_pan(&self, name: Id<Channel>, pan: Pan) {
        self.write(key::CHANNELS, name, key::PAN, position(pan));
    }

    pub fn set_channel_mute(&self, name: Id<Channel>, mute: bool) {
        self.write(key::CHANNELS, name, key::MUTE, Any::from(mute));
    }

    /// What a channel makes its sound out of — which is what loading another
    /// file into the same strip is.
    ///
    /// The tag and the hash are one value written as two registers, so they go
    /// in one transaction: a merge that took the tag from one writer and the
    /// hash from another would name a file with the wrong kind of source.
    pub fn set_channel_source(&self, name: Id<Channel>, source: ChannelSource) {
        let ChannelSource::Sampler(hash) = source;
        self.edit(|txn, root| {
            let channels = map_under(txn, root, key::CHANNELS);
            if let Some(Out::YMap(fields)) = channels.get(txn, name.spell().as_str()) {
                fields.insert(txn, key::KIND, SAMPLER);
                fields.insert(txn, key::HASH, hash.spell());
            }
        });
    }

    /// Take an insert out. Whatever named it is left naming nothing, which is
    /// legal and reads as an absence everywhere (§2.6).
    pub fn remove_insert(&self, name: Id<Insert>) {
        self.forget(key::INSERTS, name);
    }

    /// Take a channel out. See [`Document::remove_insert`].
    pub fn remove_channel(&self, name: Id<Channel>) {
        self.forget(key::CHANNELS, name);
    }

    /// Put an insert after another one, or at the front when there is none.
    pub fn move_insert(&self, name: Id<Insert>, after: Option<Id<Insert>>) {
        self.rearrange(key::INSERTS, name, after);
    }

    /// Put a channel after another one, or at the front when there is none.
    pub fn move_channel(&self, name: Id<Channel>, after: Option<Id<Channel>>) {
        self.rearrange(key::CHANNELS, name, after);
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

    /// A collection, read in the order a person arranged it.
    ///
    /// Empty for a collection that is not there, which is what a document from
    /// a build without it looks like — and what an empty one looks like too,
    /// which is the same answer either way.
    fn arranged<K, E>(
        &self,
        collection: &str,
        read: impl Fn(&MapRef, &Transaction) -> Option<E>,
    ) -> Vec<(Id<K>, E)> {
        let txn = self.doc.transact();
        let Some(Out::YMap(entities)) = self.root.get(&txn, collection) else {
            return Vec::new();
        };
        places(&entities, &txn)
            .into_iter()
            .filter_map(|(_, name, fields)| Some((name, read(&fields, &txn)?)))
            .collect()
    }

    /// The key a new entity goes in at, which is after everything already
    /// there. There is always room above, so this cannot fail to find one.
    fn appended(&self, collection: &str) -> Rank {
        let txn = self.doc.transact();
        let last = match self.root.get(&txn, collection) {
            Some(Out::YMap(entities)) => last_rank(&entities, &txn),
            _ => None,
        };
        Rank::after(last.as_ref(), self.peer())
    }

    /// One register of one entity.
    ///
    /// A register and not the entity: two people change different fields of one
    /// channel far more often than they change the same one, and writing the
    /// whole thing would keep only the later writer — silently, and in a field
    /// nobody was arguing over (D15).
    ///
    /// **A value the register already holds is not written**, which is not an
    /// optimisation. A write is an assertion that the field is this now, so one
    /// carrying the value already there can still beat somebody else's real
    /// change — and a control that sends all of its numbers whenever one of
    /// them moves, which is what a page does, would do it on every drag.
    ///
    /// Nothing is written when the entity is not there either. Remaking its map
    /// would bring back a channel somebody deleted, holding one field of it.
    fn write<K>(&self, collection: &str, name: Id<K>, field: &str, value: Any) {
        self.edit(|txn, root| {
            let entities = map_under(txn, root, collection);
            if let Some(Out::YMap(fields)) = entities.get(txn, name.spell().as_str()) {
                fields.try_update(txn, field, value);
            }
        });
    }

    fn forget<K>(&self, collection: &str, name: Id<K>) {
        self.edit(|txn, root| {
            map_under(txn, root, collection).remove(txn, name.spell().as_str());
        });
    }

    /// A reorder, which is one register and nothing else (D19).
    ///
    /// The neighbours are read out of the collection as it stands, so what is
    /// written is a key between two that are really there — and a drag whose
    /// landmark somebody deleted in the meantime leaves the thing where it was
    /// rather than at an end nobody chose.
    fn rearrange<K>(&self, collection: &str, name: Id<K>, after: Option<Id<K>>) {
        let minted = {
            let txn = self.doc.transact();
            let Some(Out::YMap(entities)) = self.root.get(&txn, collection) else {
                return;
            };
            let others: Vec<(Rank, Id<K>)> = places(&entities, &txn)
                .into_iter()
                .filter(|(_, held, _)| *held != name)
                .map(|(rank, held, _)| (rank, held))
                .collect();
            let at = match after {
                None => 0,
                Some(after) => match others.iter().position(|(_, held)| *held == after) {
                    Some(place) => place + 1,
                    None => return,
                },
            };
            let lower = at
                .checked_sub(1)
                .and_then(|place| others.get(place))
                .map(|(rank, _)| rank);
            match others.get(at) {
                Some((upper, _)) => Rank::between(lower, upper, self.peer()),
                None => Some(Rank::after(lower, self.peer())),
            }
        };
        // Two neighbours holding one key have nothing between them. Nothing
        // this build writes produces that pair, and a document that arrived
        // holding it is one where this drag has no answer — so it does not
        // happen rather than happening somewhere else.
        let Some(rank) = minted else {
            return;
        };
        self.write(collection, name, key::RANK, Any::from(rank.spell()));
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

/// One of the root's own maps, made if it is not there.
///
/// A document this build wrote has all of them. One that arrived might not, and
/// a tempo dropped on the floor would be a control that does nothing — the
/// timeline is the part of the document that cannot be absent (§2.5).
fn map_under(txn: &mut TransactionMut, root: &MapRef, key: &str) -> MapRef {
    match root.get(txn, key) {
        Some(Out::YMap(map)) => map,
        _ => root.insert(txn, key, MapPrelim::default()),
    }
}

/// An entity's own map, with the two registers every entity has.
///
/// The name is a register like the rest rather than the key: the key is the
/// identity, and a display name is a thing two people rename at once.
fn write_entity<K>(
    txn: &mut TransactionMut,
    collection: &MapRef,
    name: Id<K>,
    rank: &Rank,
    display: &str,
) -> MapRef {
    let fields = collection.insert(txn, name.spell(), MapPrelim::default());
    fields.insert(txn, key::NAME, display);
    fields.insert(txn, key::RANK, rank.spell());
    fields
}

/// The three registers a channel and an insert both have.
fn write_strip(txn: &mut TransactionMut, fields: &MapRef, gain: Gain, pan: Pan, mute: bool) {
    fields.insert(txn, key::GAIN, amplitude(gain));
    fields.insert(txn, key::PAN, position(pan));
    fields.insert(txn, key::MUTE, mute);
}

/// A collection as a sorted list, each entity with its key and its map.
///
/// **The rank decides and identity breaks the tie.** Two peers arrive at one
/// key only by minting it in the same gap at the same moment, which the peer on
/// the end is there to prevent — but a document that arrived holding the pair
/// still has to draw, and in the same order on both screens (D19).
///
/// An entity whose rank is not one is left out here rather than sorted
/// somewhere: a default would be a key colliding with real ones, and last is a
/// place somebody would have to have chosen.
fn places<K, T: ReadTxn>(collection: &MapRef, txn: &T) -> Vec<(Rank, Id<K>, MapRef)> {
    let mut held: Vec<_> = collection
        .iter(txn)
        .filter_map(|(name, value)| {
            let Out::YMap(fields) = value else {
                return None;
            };
            let rank = Rank::read(&text(&fields, txn, key::RANK)?)?;
            Some((rank, Id::read(name)?, fields))
        })
        .collect();
    held.sort_by(|(rank, name, _), (other, other_name, _)| {
        rank.cmp(other).then(name.cmp(other_name))
    });
    held
}

/// The key of the last thing in a collection, which is what a new one goes
/// after. Nothing for a collection with nothing readable in it.
fn last_rank<T: ReadTxn>(collection: &MapRef, txn: &T) -> Option<Rank> {
    collection
        .iter(txn)
        .filter_map(|(_, value)| {
            let Out::YMap(fields) = value else {
                return None;
            };
            Rank::read(&text(&fields, txn, key::RANK)?)
        })
        .max()
}

/// An insert, or nothing if one of its registers is not one (D16).
///
/// The name is the exception, and the reason is that `String` has no
/// constructor to refuse it: an entity nobody named is called nothing, exactly
/// as a project nobody named is. A gain or a pan that no constructor accepts
/// comes from a bug or a damaged file, and absence is what every read site
/// already handles.
fn read_insert(fields: &MapRef, txn: &Transaction<'_>) -> Option<Insert> {
    Some(Insert::new(
        called(fields, txn),
        gain(fields, txn)?,
        pan(fields, txn)?,
        flag(fields, txn, key::MUTE),
    ))
}

/// A channel, or nothing if one of its registers is not one. See
/// [`read_insert`].
fn read_channel(fields: &MapRef, txn: &Transaction<'_>) -> Option<Channel> {
    Some(Channel::new(
        called(fields, txn),
        source(fields, txn)?,
        Id::read(&text(fields, txn, key::OUTPUT)?)?,
        gain(fields, txn)?,
        pan(fields, txn)?,
        flag(fields, txn, key::MUTE),
    ))
}

/// What a channel makes its sound out of, or nothing for a tag this build does
/// not know — which is a channel written by a newer client, and a channel this
/// one cannot play is one it must not play as something else.
fn source<T: ReadTxn>(fields: &MapRef, txn: &T) -> Option<ChannelSource> {
    if text(fields, txn, key::KIND).as_deref() != Some(SAMPLER) {
        return None;
    }
    let hash = AssetHash::read(&text(fields, txn, key::HASH)?)?;
    Some(ChannelSource::Sampler(hash))
}

fn called<T: ReadTxn>(fields: &MapRef, txn: &T) -> String {
    text(fields, txn, key::NAME).map_or_else(String::new, |name| name.to_string())
}

fn gain<T: ReadTxn>(fields: &MapRef, txn: &T) -> Option<Gain> {
    Gain::new(number(fields, txn, key::GAIN)? as f32)
}

fn pan<T: ReadTxn>(fields: &MapRef, txn: &T) -> Option<Pan> {
    Pan::new(number(fields, txn, key::PAN)? as f32)
}

fn amplitude(gain: Gain) -> Any {
    Any::from(f64::from(gain.amplitude()))
}

fn position(pan: Pan) -> Any {
    Any::from(f64::from(pan.position()))
}

/// A register that is not a flag reads as a flag that was never set, which is
/// what a strip nobody touched is at. Absence is not right here: a channel
/// written before mute existed is not a channel to drop.
fn flag<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> bool {
    matches!(map.get(txn, key), Some(Out::Any(Any::Bool(true))))
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
    use proptest::prelude::*;

    use super::*;
    use crate::fixtures::Counter;

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
            let timeline = map_under(txn, root, key::TIMELINE);
            timeline.insert(txn, key, value.into());
        });
    }

    #[test]
    fn a_new_document_says_which_shape_it_is_in() {
        let document = Document::create("Ours", Counter::new());

        assert_eq!(document.version(), Some(Version::CURRENT));
        assert_eq!(document.name(), "Ours");
        assert_eq!(document.timeline(), Timeline::default());
    }

    #[test]
    fn the_tempo_a_control_set_is_what_the_document_says() {
        let document = Document::create("Ours", Counter::new());
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
        let document = Document::create("Ours", Counter::new());
        let ramping = Tempo::new(90.0, Curve::Ramp).expect("a tempo is a tempo");
        document.set_tempo(ramping);

        assert_eq!(document.timeline().tempo(), ramping);
    }

    /// The timeline cannot be absent, so every unreadable field here falls back
    /// rather than emptying it — and the fields beside it are still read.
    #[test]
    fn an_unreadable_tempo_falls_back_rather_than_emptying_the_timeline() {
        let document = Document::create("Ours", Counter::new());
        document.set_tempo(tempo(90.0));
        scribble(&document, key::BEATS_PER_MINUTE, "fast");

        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
        assert_eq!(document.timeline().meter(), Meter::FOUR_FOUR);
    }

    /// Not a missing field but a present one holding what is not a tempo, which
    /// is the case the constructor exists for.
    #[test]
    fn a_tempo_no_clock_could_run_at_falls_back() {
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::BEATS_PER_MINUTE, 0.0);

        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
    }

    #[test]
    fn a_curve_this_build_does_not_know_holds() {
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::CURVE, "wobble");

        assert_eq!(document.timeline().tempo().curve(), Curve::Hold);
    }

    #[test]
    fn a_signature_this_grid_cannot_hold_falls_back() {
        let document = Document::create("Ours", Counter::new());
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
        let document = Document::create("Ours", Counter::new());
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
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::NUMERATOR, 3.0);
        document.set_tempo(tempo(90.0));

        assert_eq!(document.timeline().meter(), three_four());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
    }

    /// A client with a bigint type writes `3n` as one whatever its size, so
    /// this is an ordinary document rather than a damaged one.
    #[test]
    fn a_number_written_as_a_big_integer_is_a_number() {
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::NUMERATOR, Any::BigInt(3));
        scribble(&document, key::BEATS_PER_MINUTE, Any::BigInt(90));

        assert_eq!(document.timeline().meter(), three_four());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
    }

    /// A count is whole or it is not a count: three and a half beats to the bar
    /// is a field holding something else, not a signature to round.
    #[test]
    fn a_count_that_is_not_whole_falls_back() {
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::NUMERATOR, 3.5);

        assert_eq!(document.timeline().meter(), Meter::FOUR_FOUR);
    }

    /// A count written as a float by a client with one number type is a count.
    #[test]
    fn a_whole_number_is_read_however_it_was_spelled() {
        let document = Document::create("Ours", Counter::new());
        scribble(&document, key::NUMERATOR, 3.0);

        assert_eq!(document.timeline().meter(), three_four());
    }

    /// The question of the slice, in the smallest form it has: two people edit
    /// the same field and neither loses the other's document. Which of the two
    /// tempos wins is not this test's business — that both replicas say the
    /// same thing afterwards is.
    #[test]
    fn two_replicas_that_have_seen_each_other_say_the_same_thing() {
        let mine = Document::create("Ours", Counter::new());
        let theirs =
            Document::open(&mine.state(), Counter::new()).expect("a document like this one");

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
        let mut mine = Document::create("Ours", Counter::new());
        let theirs =
            Document::open(&mine.state(), Counter::new()).expect("a document like this one");
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
        let mut document = Document::create("Ours", Counter::new());
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
        let mut document = Document::create("Ours", Counter::new());
        document.set_tempo(tempo(90.0));
        document.set_tempo(tempo(140.0));

        assert!(document.undo());
        assert_eq!(document.timeline().tempo(), tempo(90.0));
        assert!(document.undo());
        assert_eq!(document.timeline().tempo(), Tempo::DEFAULT);
    }

    fn gain_of(amplitude: f32) -> Gain {
        Gain::new(amplitude).expect("a fraction is a gain")
    }

    fn pan_of(place: f32) -> Pan {
        Pan::new(place).expect("a place between the speakers is a pan")
    }

    fn channel_of(name: &str, output: Id<Insert>) -> Channel {
        Channel::new(
            name.to_owned(),
            ChannelSource::Sampler(AssetHash::from_bytes([7; 32])),
            output,
            Gain::UNITY,
            Pan::CENTRE,
            false,
        )
    }

    /// What a damaged document holds inside one entity, which nothing in the
    /// interface can produce — every value crosses a constructor on the way in.
    fn deface(
        document: &Document,
        collection: &str,
        name: &str,
        field: &str,
        value: impl Into<Any>,
    ) {
        document.apply(|txn, root| {
            let entities = map_under(txn, root, collection);
            if let Some(Out::YMap(fields)) = entities.get(txn, name) {
                fields.insert(txn, field, value.into());
            }
        });
    }

    fn erase(document: &Document, collection: &str, name: &str, field: &str) {
        document.apply(|txn, root| {
            let entities = map_under(txn, root, collection);
            if let Some(Out::YMap(fields)) = entities.get(txn, name) {
                fields.remove(txn, field);
            }
        });
    }

    /// Three channels in both replicas, arranged, and everything each of them
    /// has seen of the other already applied.
    fn arranged_by_two() -> (Document, Document, Vec<Id<Channel>>) {
        let mut mine = Document::create("Ours", Counter::new());
        let master = mine.master();
        let names = ["a", "b", "c"]
            .map(|name| mine.add_channel(&channel_of(name, master)))
            .to_vec();
        let theirs = Document::open(&mine.state(), Counter::starting_at(1 << 96))
            .expect("a document like this one");
        (mine, theirs, names)
    }

    fn settle(mine: &Document, theirs: &Document) {
        mine.merge(&theirs.state()).expect("their update");
        theirs.merge(&mine.state()).expect("ours");
    }

    fn named(channels: &[(Id<Channel>, Channel)]) -> Vec<&str> {
        channels.iter().map(|(_, channel)| channel.name()).collect()
    }

    #[test]
    fn a_new_document_is_heard_through_a_master_it_says_the_name_of() {
        let document = Document::create("Ours", Counter::new());
        let inserts = document.inserts();

        assert_eq!(inserts.len(), 1, "the master and nothing else");
        assert_eq!(inserts[0].0, document.master(), "and the project names it");
        assert_eq!(inserts[0].1.gain(), Gain::UNITY);
        assert_eq!(inserts[0].1.pan(), Pan::CENTRE);
        assert!(!inserts[0].1.mute());
        assert!(document.channels().is_empty());
    }

    #[test]
    fn what_was_added_is_what_comes_back() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master));

        assert_eq!(
            document.channels(),
            vec![(name, channel_of("Kick", master))]
        );
    }

    /// Each register on its own, so that one written into the wrong field has
    /// somewhere to show.
    #[test]
    fn a_register_written_is_the_one_that_moved() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master));

        document.set_channel_gain(name, gain_of(0.5));
        document.set_channel_pan(name, pan_of(-0.25));
        document.set_channel_mute(name, true);

        let channels = document.channels();
        let (_, channel) = channels.first().expect("the channel is still there");
        assert_eq!(channel.gain(), gain_of(0.5));
        assert_eq!(channel.pan(), pan_of(-0.25));
        assert!(channel.mute());
        assert_eq!(channel.name(), "Kick", "and its name did not move");
        assert_eq!(channel.output(), master, "nor its route");
    }

    #[test]
    fn a_collection_comes_back_in_the_order_it_was_arranged() {
        let (mine, _, names) = arranged_by_two();

        assert_eq!(named(&mine.channels()), ["a", "b", "c"]);

        mine.move_channel(names[2], None);
        assert_eq!(named(&mine.channels()), ["c", "a", "b"], "to the front");

        mine.move_channel(names[2], Some(names[1]));
        assert_eq!(
            named(&mine.channels()),
            ["a", "b", "c"],
            "and back to the end"
        );

        mine.move_channel(names[0], Some(names[1]));
        assert_eq!(
            named(&mine.channels()),
            ["b", "a", "c"],
            "and into the middle"
        );
    }

    /// Each thing added has a key of its own, so there is room between any two
    /// of them.
    ///
    /// The test above does not say this: after one reorder the keys are spread
    /// out whatever they started as, and everything after that works. This one
    /// reaches between two that have only ever been appended.
    #[test]
    fn everything_added_gets_a_key_of_its_own() {
        let (mine, _, names) = arranged_by_two();

        mine.move_channel(names[2], Some(names[0]));

        assert_eq!(named(&mine.channels()), ["a", "c", "b"]);
    }

    /// The peer on the end, from the far side: two replicas appending without
    /// having seen each other mint into the same gap, from the same key, at the
    /// same moment. Only the peer tells the two keys apart — and two things
    /// holding one key have nowhere between them, which is what the drag at the
    /// end of this asks for.
    #[test]
    fn two_replicas_appending_at_once_do_not_mint_one_key() {
        let (mut mine, mut theirs, names) = arranged_by_two();
        let master = mine.master();

        mine.add_channel(&channel_of("d", master));
        theirs.add_channel(&channel_of("e", master));
        settle(&mine, &theirs);

        let arranged = mine.channels();
        assert_eq!(arranged.len(), 5, "both of them arrived");
        let (fourth, fifth) = (arranged[3].0, arranged[4].0);

        mine.move_channel(names[0], Some(fourth));

        let places: Vec<Id<Channel>> = mine.channels().iter().map(|(name, _)| *name).collect();
        assert_eq!(places, [names[1], names[2], fourth, names[0], fifth]);
    }

    /// An insert is the same entity with one register fewer, and everything
    /// that works on a channel works on it. Written out rather than left to the
    /// channel's tests: the two collections are two key strings, and a setter
    /// pointed at the wrong one writes into a map that answers.
    #[test]
    fn an_insert_is_edited_arranged_and_taken_out_the_way_a_channel_is() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let strip = Insert::new("Reverb".to_owned(), Gain::UNITY, Pan::CENTRE, false);
        let reverb = document.add_insert(&strip);

        document.set_insert_gain(reverb, gain_of(0.5));
        document.set_insert_pan(reverb, pan_of(0.25));
        document.set_insert_mute(reverb, true);

        let inserts = document.inserts();
        let called: Vec<&str> = inserts.iter().map(|(_, held)| held.name()).collect();
        assert_eq!(called, ["Master", "Reverb"], "added at the end");
        assert_eq!(inserts[1].1.gain(), gain_of(0.5));
        assert_eq!(inserts[1].1.pan(), pan_of(0.25));
        assert!(inserts[1].1.mute());

        document.move_insert(reverb, None);
        assert_eq!(document.inserts()[0].0, reverb, "and moved to the front");

        document.remove_insert(reverb);
        assert_eq!(document.inserts().len(), 1, "leaving the master");
        assert_eq!(document.master(), master, "which the project still names");
    }

    /// Loading another file into one strip: the source moves and nothing else
    /// does.
    #[test]
    fn a_channel_pointed_at_another_file_keeps_the_strip_it_had() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master));
        document.set_channel_gain(name, gain_of(0.5));

        let other = AssetHash::from_bytes([9; 32]);
        document.set_channel_source(name, ChannelSource::Sampler(other));

        let channels = document.channels();
        assert_eq!(channels[0].1.source(), ChannelSource::Sampler(other));
        assert_eq!(channels[0].1.gain(), gain_of(0.5), "and the strip stayed");
        assert_eq!(channels[0].1.output(), master, "and so did the route");
    }

    /// The register nobody asked to change stays where it was, which is the
    /// whole of what a reorder costing one register means.
    #[test]
    fn a_reorder_leaves_every_other_field_alone() {
        let (mine, _, names) = arranged_by_two();
        mine.set_channel_gain(names[1], gain_of(0.25));

        mine.move_channel(names[1], None);

        let channels = mine.channels();
        assert_eq!(named(&channels), ["b", "a", "c"]);
        assert_eq!(channels[0].1.gain(), gain_of(0.25));
    }

    /// The question of the slice, in the smallest form that states it: one
    /// replica reorders while the other edits, and both have to survive.
    ///
    /// Under a list this is the failure D19 measured. A reorder there is a
    /// delete and an insert, the insert builds a new map, and the edit lands on
    /// a tombstone — while **both replicas agree on the result**, which is what
    /// makes the property below the weaker half of this test.
    #[test]
    fn a_reorder_and_an_edit_at_once_lose_neither() {
        let (mine, theirs, names) = arranged_by_two();

        mine.move_channel(names[2], None);
        theirs.set_channel_gain(names[1], gain_of(0.25));
        theirs.set_channel_mute(names[2], true);
        settle(&mine, &theirs);

        for document in [&mine, &theirs] {
            let channels = document.channels();
            assert_eq!(named(&channels), ["c", "a", "b"], "the reorder");
            assert_eq!(channels[2].1.gain(), gain_of(0.25), "the edit beside it");
            assert!(channels[0].1.mute(), "and the edit on the thing that moved");
        }
    }

    /// What the shape refused, in the operations a list would have forced.
    ///
    /// Without a move, a reorder is a delete and an insert — and this is the
    /// same pair of edits as the test above, spelled that way. The entity the
    /// other replica was writing to is a tombstone by the time the write
    /// arrives, so the edit is gone; **both replicas agree that it never
    /// happened**, which is why a convergence test passes on the wrong shape
    /// (D19). It is here so that the test above is known to be about something.
    #[test]
    fn the_reorder_a_list_would_have_forced_loses_the_edit_beside_it() {
        let (mut mine, theirs, names) = arranged_by_two();
        let moved = mine.channels()[1].1.clone();

        mine.remove_channel(names[1]);
        mine.add_channel(&moved);
        theirs.set_channel_gain(names[1], gain_of(0.25));
        settle(&mine, &theirs);

        let channels = mine.channels();
        assert_eq!(channels, theirs.channels(), "the replicas agree");
        assert_eq!(channels.len(), 3, "and there are still three channels");
        assert!(
            !channels
                .iter()
                .any(|(_, held)| held.gain() == gain_of(0.25)),
            "but the edit is simply not in any of them"
        );
    }

    /// Both replicas reordering the same collection at once, which is the case
    /// §2.4 traded the movable list for.
    #[test]
    fn two_people_reordering_at_once_lose_nothing() {
        let (mine, theirs, names) = arranged_by_two();

        mine.move_channel(names[0], Some(names[2]));
        theirs.move_channel(names[2], None);
        theirs.set_channel_gain(names[0], gain_of(0.75));
        settle(&mine, &theirs);

        let ours = mine.channels();
        assert_eq!(ours, theirs.channels(), "one order on both screens");
        assert_eq!(ours.len(), 3, "and all three are still here");
        let moved = ours
            .iter()
            .find(|(held, _)| *held == names[0])
            .expect("the one both of them touched");
        assert_eq!(moved.1.gain(), gain_of(0.75), "the edit under the reorders");
    }

    /// D16, register by register. Each of these is a document nothing in the
    /// interface could have written, and each makes its entity absent rather
    /// than taking the collection with it.
    #[test]
    fn a_register_no_constructor_accepts_makes_its_entity_absent() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master)).spell();

        for (field, value) in [
            (key::GAIN, Any::from(f64::from(f32::NAN))),
            (key::PAN, Any::from(9.0)),
            (key::KIND, Any::from("theremin")),
            (key::HASH, Any::from("not a hash")),
            (key::OUTPUT, Any::from("not a name")),
            (key::RANK, Any::from("not a key")),
        ] {
            let mut sound = Document::create("Ours", Counter::new());
            let master = sound.master();
            let name = sound.add_channel(&channel_of("Kick", master)).spell();
            deface(&sound, key::CHANNELS, &name, field, value);

            assert!(
                sound.channels().is_empty(),
                "{field} left the channel readable"
            );
            assert_eq!(sound.inserts().len(), 1, "{field} took the master with it");
        }

        erase(&document, key::CHANNELS, &name, key::MUTE);
        let channels = document.channels();
        assert_eq!(channels.len(), 1, "a register that was never written");
        assert!(!channels[0].1.mute(), "reads as a strip nobody touched");
    }

    #[test]
    fn a_master_nothing_answers_to_is_a_silent_project_rather_than_a_refusal() {
        let document = Document::create("Ours", Counter::new());
        document.apply(|txn, root| {
            root.remove(txn, key::MASTER);
        });

        assert_eq!(document.master(), Id::from_bits(0));
        assert_eq!(document.inserts().len(), 1, "the insert is still there");
    }

    /// Half an entity is worse than none: the map was deleted, and a register
    /// written into a fresh one would bring back a channel with a gain and
    /// nothing else.
    #[test]
    fn a_register_written_to_something_removed_does_not_bring_it_back() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master));

        document.remove_channel(name);
        document.set_channel_gain(name, gain_of(0.5));

        assert!(document.channels().is_empty());
    }

    #[test]
    fn a_move_whose_landmark_is_gone_leaves_the_thing_where_it_was() {
        let (mine, theirs, names) = arranged_by_two();

        theirs.remove_channel(names[1]);
        settle(&mine, &theirs);
        mine.move_channel(names[0], Some(names[1]));

        assert_eq!(named(&mine.channels()), ["a", "c"], "nothing moved");
    }

    /// Two keys that are the same key have nothing between them, and a drag
    /// aimed there does not happen rather than happening somewhere else.
    #[test]
    fn two_neighbours_holding_one_key_have_nowhere_between_them() {
        let (mine, _, names) = arranged_by_two();
        let held = mine
            .channels()
            .iter()
            .position(|(name, _)| *name == names[0])
            .expect("a is in there");
        assert_eq!(held, 0);

        // A pair no generator makes: the peer on the end is what stops it.
        let key = "80";
        deface(&mine, key::CHANNELS, &names[0].spell(), key::RANK, key);
        deface(&mine, key::CHANNELS, &names[1].spell(), key::RANK, key);
        mine.move_channel(names[2], Some(names[0]));

        assert_eq!(named(&mine.channels()), ["a", "b", "c"], "nothing moved");
    }

    /// A register told what it already holds is not a change at all, and the
    /// undo stack is where that is visible: the last thing this user did is
    /// still the thing before it.
    ///
    /// What it is for is the concurrent case — an assertion that the field is
    /// this now can beat somebody else's real edit, and a page sending all of
    /// its numbers whenever one moves would make that assertion constantly.
    /// That case has no deterministic outcome to assert on, since which writer
    /// wins is the merge's business; this says the write did not happen.
    #[test]
    fn a_register_told_what_it_already_holds_is_not_a_change() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        let name = document.add_channel(&channel_of("Kick", master));

        document.set_channel_gain(name, Gain::UNITY);
        document.set_channel_pan(name, Pan::CENTRE);
        document.set_channel_mute(name, false);

        assert!(document.undo(), "there was something to take back");
        assert!(
            document.channels().is_empty(),
            "and it was the channel, because nothing happened after it"
        );
    }

    #[test]
    fn a_channel_this_user_added_is_theirs_to_take_back() {
        let mut document = Document::create("Ours", Counter::new());
        let master = document.master();
        document.add_channel(&channel_of("Kick", master));

        assert!(document.undo());
        assert!(document.channels().is_empty());
        assert!(document.redo());
        assert_eq!(document.channels().len(), 1);
    }

    /// The origin trap again, on the half of the document that has collections
    /// in it: a channel that arrived is not ours to take back.
    #[test]
    fn a_channel_that_arrived_is_not_ours_to_take_back() {
        let (mine, mut theirs, _) = arranged_by_two();
        let master = theirs.master();
        theirs.add_channel(&channel_of("d", master));

        let mut mine = mine;
        mine.merge(&theirs.state()).expect("their update");

        assert_eq!(mine.channels().len(), 4, "their channel arrived");
        assert!(mine.undo(), "ours are still ours");
        assert_eq!(
            named(&mine.channels()),
            ["a", "b", "d"],
            "and taking one back took ours rather than theirs"
        );
    }

    /// One move in a session with two people in it, the flag saying which of
    /// them makes it.
    #[derive(Clone, Copy, Debug)]
    enum Step {
        Add(bool),
        Gain(bool, usize, u8),
        Mute(bool, usize),
        Move(bool, usize, Option<usize>),
        Remove(bool, usize),
        /// Where the two exchange what they have. Sparse on purpose: what is
        /// under test is what happens to edits made while they had not.
        Meet,
    }

    fn any_step() -> impl Strategy<Value = Step> {
        prop_oneof![
            any::<bool>().prop_map(Step::Add),
            (any::<bool>(), 0..8usize, any::<u8>())
                .prop_map(|(side, which, gain)| Step::Gain(side, which, gain)),
            (any::<bool>(), 0..8usize).prop_map(|(side, which)| Step::Mute(side, which)),
            (any::<bool>(), 0..8usize, prop::option::of(0..8usize))
                .prop_map(|(side, which, after)| Step::Move(side, which, after)),
            (any::<bool>(), 0..8usize).prop_map(|(side, which)| Step::Remove(side, which)),
            Just(Step::Meet),
        ]
    }

    /// The name at `which`, counted round, or nothing when there is nothing to
    /// count.
    fn nth(document: &Document, which: usize) -> Option<Id<Channel>> {
        let channels = document.channels();
        channels
            .get(which % channels.len().max(1))
            .map(|(name, _)| *name)
    }

    fn play(step: Step, sides: &mut [Document; 2]) {
        match step {
            Step::Add(side) => {
                let document = &mut sides[usize::from(side)];
                let master = document.master();
                document.add_channel(&channel_of("one of many", master));
            }
            Step::Gain(side, which, amplitude) => {
                let document = &sides[usize::from(side)];
                if let Some(name) = nth(document, which) {
                    document.set_channel_gain(name, gain_of(f32::from(amplitude) / 128.0));
                }
            }
            Step::Mute(side, which) => {
                let document = &sides[usize::from(side)];
                if let Some(name) = nth(document, which) {
                    document.set_channel_mute(name, true);
                }
            }
            Step::Move(side, which, after) => {
                let document = &sides[usize::from(side)];
                if let Some(name) = nth(document, which) {
                    document.move_channel(name, after.and_then(|after| nth(document, after)));
                }
            }
            Step::Remove(side, which) => {
                let document = &sides[usize::from(side)];
                if let Some(name) = nth(document, which) {
                    document.remove_channel(name);
                }
            }
            Step::Meet => {
                let [mine, theirs] = sides;
                settle(mine, theirs);
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        /// Any session at all, and the one thing true of every one of them:
        /// once the two have seen each other they are looking at the same
        /// document, in the same order, with the same values in it.
        ///
        /// **This is the weaker half of the slice's question** and is here for
        /// the sequences nobody thought of. What it cannot tell is whether an
        /// edit went missing on the way — the tests above are for that, and
        /// `the_reorder_a_list_would_have_forced_loses_the_edit_beside_it` is
        /// the one that shows this property passing while the document is
        /// wrong.
        #[test]
        fn two_people_editing_at_once_arrive_at_one_document(
            steps in prop::collection::vec(any_step(), 1..24),
        ) {
            let first = Document::create("Ours", Counter::new());
            let second = Document::open(&first.state(), Counter::starting_at(1 << 96))
                .expect("a document like this one");
            let mut sides = [first, second];

            for step in steps {
                play(step, &mut sides);
            }

            let [mine, theirs] = &sides;
            settle(mine, theirs);

            prop_assert_eq!(mine.channels(), theirs.channels());
            prop_assert_eq!(mine.inserts(), theirs.inserts());
            prop_assert_eq!(mine.master(), theirs.master());
        }
    }

    #[test]
    fn what_is_not_an_update_is_refused_rather_than_applied() {
        let document = Document::create("Ours", Counter::new());

        assert_eq!(document.merge(&[0xff; 8]), Err(Rejected::Unreadable));
        assert_eq!(
            document.timeline(),
            Timeline::default(),
            "and nothing moved"
        );
    }
}
