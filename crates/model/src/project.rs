//! The document itself: everything the project is, and the ways of reading it.
//!
//! **Ordered where the order is the data, keyed everywhere else** (§2.6). The
//! inserts, the channels and the lanes were arranged by a person, so they are
//! held in the order they were arranged in — which is what Loro's movable list
//! will be underneath, and the reason it was taken over Yrs (§2.4). Patterns,
//! clips, curves and assets have no order at all; they are found by name.
//!
//! **The order is where they live, not a second list beside them.** An order
//! kept apart from the entities is a second thing to keep true, and a merge
//! that adds to one and not the other leaves a lane in the arrangement that is
//! nowhere, or one nowhere that is in the arrangement.
//!
//! **Every reference resolves to an absence rather than a value** (§2.6). A
//! clip can name a pattern somebody deleted, a channel can name an insert
//! somebody deleted, and the master itself is a name like any other. None of
//! that is prevented by anything: the two edits never met.

use std::collections::BTreeMap;

use crate::automation::Automation;
use crate::mixer::{Channel, Insert};
use crate::pattern::Pattern;
use crate::playlist::{Clip, Lane};
use crate::{Asset, AssetHash, Id};

/// Which shape the document was written in.
///
/// §3 puts one of these in the header of the shared region because a fresh
/// reader meeting a stale writer otherwise parts company as a misread rather
/// than as a message. A project outlives a client version by years, so the same
/// argument applies with more force — and it cannot be added afterwards,
/// because the documents that would need it are the ones already written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version(u32);

impl Version {
    /// What this build writes.
    pub const CURRENT: Self = Self(1);

    /// From a number — what a document says about itself.
    #[must_use]
    pub const fn new(number: u32) -> Self {
        Self(number)
    }

    /// The number.
    #[must_use]
    pub const fn number(self) -> u32 {
        self.0
    }

    /// Whether this build can read it.
    ///
    /// A document from the future is refused rather than opened: the fields it
    /// gained are ones this build would drop, and a project silently emptied of
    /// what a newer client put in it is worse than one that would not open.
    #[must_use]
    pub const fn is_readable(self) -> bool {
        self.0 <= Self::CURRENT.0
    }
}

/// What a [`Project`] is made of, before it is one.
///
/// Public fields and no methods, on purpose. A project has readers only, and a
/// `with_clip` on it would be a way to change the document that is not the
/// document — the second source of truth `model.md` exists to prevent. Filling
/// this in is how the document layer projects Loro's state into a value, and
/// how a test writes a project down.
#[derive(Clone, Debug, PartialEq)]
pub struct Parts {
    pub name: String,
    /// The insert everything is finally heard through. A name like any other:
    /// it can be one nothing answers to, and then the project is silent.
    pub master: Id<Insert>,
    pub inserts: Vec<(Id<Insert>, Insert)>,
    pub channels: Vec<(Id<Channel>, Channel)>,
    pub lanes: Vec<(Id<Lane>, Lane)>,
    pub patterns: BTreeMap<Id<Pattern>, Pattern>,
    pub clips: BTreeMap<Id<Clip>, Clip>,
    pub automation: BTreeMap<Id<Automation>, Automation>,
    pub assets: BTreeMap<AssetHash, Asset>,
}

impl Parts {
    /// A project with a master and nothing else in it.
    #[must_use]
    pub fn new(name: String, master: Id<Insert>) -> Self {
        Self {
            name,
            master,
            inserts: Vec::new(),
            channels: Vec::new(),
            lanes: Vec::new(),
            patterns: BTreeMap::new(),
            clips: BTreeMap::new(),
            automation: BTreeMap::new(),
            assets: BTreeMap::new(),
        }
    }
}

/// The whole document, read-only.
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    version: Version,
    parts: Parts,
}

impl Project {
    /// Built from its parts, at the version this build writes.
    #[must_use]
    pub fn new(parts: Parts) -> Self {
        Self {
            version: Version::CURRENT,
            parts,
        }
    }

    /// Built from its parts at the version a document claimed.
    ///
    /// Nothing is refused here. A version this build cannot read is a question
    /// for whoever opened the file, and a master naming an insert that is gone
    /// is an ordinary merge (§2.6) rather than a document to reject — a project
    /// that stops opening is the failure both of those rules exist to avoid.
    #[must_use]
    pub fn at_version(version: Version, parts: Parts) -> Self {
        Self { version, parts }
    }

    /// Which shape it was written in.
    #[must_use]
    pub fn version(&self) -> Version {
        self.version
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.parts.name
    }

    /// The name of the insert everything is heard through.
    #[must_use]
    pub fn master(&self) -> Id<Insert> {
        self.parts.master
    }

    /// The inserts, in the order they were arranged in.
    pub fn inserts(&self) -> impl Iterator<Item = (Id<Insert>, &Insert)> {
        self.parts
            .inserts
            .iter()
            .map(|(name, insert)| (*name, insert))
    }

    /// The channels, in the order they were arranged in — which is the order
    /// the step sequencer shows them in.
    pub fn channels(&self) -> impl Iterator<Item = (Id<Channel>, &Channel)> {
        self.parts
            .channels
            .iter()
            .map(|(name, channel)| (*name, channel))
    }

    /// The lanes, top to bottom.
    pub fn lanes(&self) -> impl Iterator<Item = (Id<Lane>, &Lane)> {
        self.parts.lanes.iter().map(|(name, lane)| (*name, lane))
    }

    pub fn patterns(&self) -> impl Iterator<Item = (Id<Pattern>, &Pattern)> {
        self.parts
            .patterns
            .iter()
            .map(|(name, pattern)| (*name, pattern))
    }

    pub fn clips(&self) -> impl Iterator<Item = (Id<Clip>, &Clip)> {
        self.parts.clips.iter().map(|(name, clip)| (*name, clip))
    }

    pub fn automation(&self) -> impl Iterator<Item = (Id<Automation>, &Automation)> {
        self.parts
            .automation
            .iter()
            .map(|(name, curve)| (*name, curve))
    }

    pub fn assets(&self) -> impl Iterator<Item = (AssetHash, &Asset)> {
        self.parts.assets.iter().map(|(hash, asset)| (*hash, asset))
    }

    /// One insert by name, or nothing.
    ///
    /// A scan, because the inserts live in the order they are arranged in and
    /// there is no second structure to look them up by — that structure would
    /// be a thing to keep true rather than a thing to read. An index over it is
    /// derived state and belongs to whoever is drawing.
    #[must_use]
    pub fn insert(&self, name: Id<Insert>) -> Option<&Insert> {
        Self::find(&self.parts.inserts, name)
    }

    /// One channel by name, or nothing.
    #[must_use]
    pub fn channel(&self, name: Id<Channel>) -> Option<&Channel> {
        Self::find(&self.parts.channels, name)
    }

    /// One lane by name, or nothing.
    #[must_use]
    pub fn lane(&self, name: Id<Lane>) -> Option<&Lane> {
        Self::find(&self.parts.lanes, name)
    }

    #[must_use]
    pub fn pattern(&self, name: Id<Pattern>) -> Option<&Pattern> {
        self.parts.patterns.get(&name)
    }

    #[must_use]
    pub fn clip(&self, name: Id<Clip>) -> Option<&Clip> {
        self.parts.clips.get(&name)
    }

    #[must_use]
    pub fn curve(&self, name: Id<Automation>) -> Option<&Automation> {
        self.parts.automation.get(&name)
    }

    #[must_use]
    pub fn asset(&self, hash: AssetHash) -> Option<&Asset> {
        self.parts.assets.get(&hash)
    }

    /// The insert everything is finally heard through, if it is still there.
    #[must_use]
    pub fn master_insert(&self) -> Option<&Insert> {
        self.insert(self.master())
    }

    /// What a channel is heard through, or nothing — in which case it is
    /// silent, and does not fall back to the master (§2.6).
    #[must_use]
    pub fn output_of(&self, channel: &Channel) -> Option<&Insert> {
        self.insert(channel.output())
    }

    /// The channels feeding one insert.
    ///
    /// The many-to-one edge read from its far end, which is a scan by
    /// construction: the edge is a field on each channel, so the answer is
    /// whichever of them name this insert. Held the other way it would be one
    /// lookup and a merge that puts a channel in two inserts (§2.6).
    pub fn channels_into(
        &self,
        insert: Id<Insert>,
    ) -> impl Iterator<Item = (Id<Channel>, &Channel)> {
        self.channels()
            .filter(move |(_, channel)| channel.output() == insert)
    }

    /// The clips on one lane, for the same reason and in the same way.
    pub fn clips_on(&self, lane: Id<Lane>) -> impl Iterator<Item = (Id<Clip>, &Clip)> {
        self.clips().filter(move |(_, clip)| clip.lane() == lane)
    }

    fn find<T>(entities: &[(Id<T>, T)], name: Id<T>) -> Option<&T> {
        entities
            .iter()
            .find(|(held, _)| *held == name)
            .map(|(_, entity)| entity)
    }
}

#[cfg(test)]
mod tests {
    use escapement_time::{Position, Span};

    use super::*;
    use crate::asset::Frames;
    use crate::automation::{Address, Level, Parameter, Point, Target};
    use crate::fixtures::Counter;
    use crate::mixer::{ChannelSource, Gain, Pan};
    use crate::playlist::ClipSource;
    use escapement_time::SampleRate;

    const SAMPLE: AssetHash = AssetHash::from_bytes([1; 32]);

    struct Song {
        project: Project,
        master: Id<Insert>,
        drums: Id<Insert>,
        kick: Id<Channel>,
        snare: Id<Channel>,
        lane: Id<Lane>,
        pattern: Id<Pattern>,
        clip: Id<Clip>,
        curve: Id<Automation>,
    }

    /// Two channels into one insert, one clip on one lane: the smallest project
    /// in which every edge of §2.6 is present exactly once.
    fn song() -> Song {
        let mut entropy = Counter::new();
        let master = Id::mint(&mut entropy);
        let drums = Id::mint(&mut entropy);
        let kick = Id::mint(&mut entropy);
        let snare = Id::mint(&mut entropy);
        let lane = Id::mint(&mut entropy);
        let pattern = Id::mint(&mut entropy);
        let clip = Id::mint(&mut entropy);
        let curve = Id::mint(&mut entropy);

        let mut parts = Parts::new("Song".to_owned(), master);
        parts.inserts.push((
            master,
            Insert::new("Master".to_owned(), Gain::UNITY, Pan::CENTRE, false),
        ));
        parts.inserts.push((
            drums,
            Insert::new("Drums".to_owned(), Gain::UNITY, Pan::CENTRE, false),
        ));
        for (name, label) in [(kick, "Kick"), (snare, "Snare")] {
            parts.channels.push((
                name,
                Channel::new(
                    label.to_owned(),
                    ChannelSource::Sampler(SAMPLE),
                    drums,
                    Gain::UNITY,
                    Pan::CENTRE,
                    false,
                ),
            ));
        }
        parts.lanes.push((lane, Lane::new("Drums".to_owned())));
        parts
            .patterns
            .insert(pattern, Pattern::new("Verse".to_owned(), []));
        parts.clips.insert(
            clip,
            Clip::new(
                lane,
                Position::ZERO,
                Span::quarters(4),
                ClipSource::Pattern {
                    pattern,
                    offset: Span::ZERO,
                },
            ),
        );

        parts.automation.insert(
            curve,
            Automation::new(
                Address::new(Target::Insert(drums), Parameter::Gain),
                [(
                    Id::mint(&mut entropy),
                    Point::new(Position::ZERO, Level::TOP),
                )],
            ),
        );
        parts.assets.insert(
            SAMPLE,
            Asset::new(
                "kick.wav".to_owned(),
                Frames::new(4_800),
                SampleRate::new(48_000.0).expect("48 kHz is a rate"),
                1,
            )
            .expect("mono is audio"),
        );

        Song {
            project: Project::new(parts),
            master,
            drums,
            kick,
            snare,
            lane,
            pattern,
            clip,
            curve,
        }
    }

    #[test]
    fn a_new_document_is_written_at_the_version_this_build_reads() {
        let song = song();

        assert_eq!(song.project.version(), Version::CURRENT);
        assert!(song.project.version().is_readable());
        assert_eq!(song.project.name(), "Song");
    }

    /// The whole reason the field exists: what a newer client wrote is refused
    /// rather than opened and silently stripped of what this build has no
    /// fields for.
    #[test]
    fn a_document_from_the_future_is_not_readable() {
        let ahead = Version::new(Version::CURRENT.number() + 1);
        let behind = Version::new(0);

        assert!(!ahead.is_readable());
        assert!(behind.is_readable(), "an older document still opens");
        assert_eq!(ahead.number(), Version::CURRENT.number() + 1);

        let song = song();
        let old = Project::at_version(behind, Parts::new("Old".to_owned(), song.master));
        assert_eq!(old.version(), behind);
    }

    #[test]
    fn every_entity_is_found_by_its_name() {
        let song = song();
        let project = &song.project;

        assert_eq!(project.insert(song.drums).map(Insert::name), Some("Drums"));
        assert_eq!(project.channel(song.kick).map(Channel::name), Some("Kick"));
        assert_eq!(project.lane(song.lane).map(Lane::name), Some("Drums"));
        assert_eq!(
            project.pattern(song.pattern).map(Pattern::name),
            Some("Verse")
        );
        assert!(project.clip(song.clip).is_some());
        assert_eq!(
            project.curve(song.curve).map(|curve| curve.address()),
            Some(Address::new(Target::Insert(song.drums), Parameter::Gain))
        );
        assert_eq!(project.asset(SAMPLE).map(Asset::name), Some("kick.wav"));
        assert_eq!(project.master_insert().map(Insert::name), Some("Master"));
    }

    /// The rule that shapes every read: a name nothing answers to is an
    /// absence, not a panic and not a substitute.
    ///
    /// Spelled out six times rather than once, and not for want of trying — a
    /// single binding here does not compile, because the kind on a name is not
    /// decoration. That is the marker doing the job it is carried for.
    #[test]
    fn a_name_nothing_answers_to_resolves_to_nothing() {
        let song = song();
        let project = &song.project;

        assert!(project.insert(Id::from_bits(u128::MAX)).is_none());
        assert!(project.channel(Id::from_bits(u128::MAX)).is_none());
        assert!(project.lane(Id::from_bits(u128::MAX)).is_none());
        assert!(project.pattern(Id::from_bits(u128::MAX)).is_none());
        assert!(project.clip(Id::from_bits(u128::MAX)).is_none());
        assert!(project.curve(Id::from_bits(u128::MAX)).is_none());
        assert!(project.asset(AssetHash::from_bytes([9; 32])).is_none());
    }

    /// A project whose master was deleted is silent, and opens.
    #[test]
    fn a_master_that_is_gone_is_an_absence_and_not_a_refusal() {
        let song = song();
        let orphan = Project::new(Parts::new("Orphan".to_owned(), song.master));

        assert_eq!(orphan.master(), song.master, "it still names one");
        assert!(orphan.master_insert().is_none());
    }

    /// Both ways round: a name that resolves and one that does not. Only the
    /// second was written first, and an `output_of` answering nothing to
    /// everything passed the whole suite — cargo-mutants found it.
    #[test]
    fn a_channel_is_heard_through_the_insert_it_names() {
        let song = song();
        let project = &song.project;
        let kick = project.channel(song.kick).expect("the channel is here");

        assert_eq!(project.output_of(kick).map(Insert::name), Some("Drums"));
    }

    #[test]
    fn a_channel_whose_insert_is_gone_is_silent_rather_than_rerouted() {
        let song = song();
        let mut parts = Parts::new("Song".to_owned(), song.master);
        parts.inserts.push((
            song.master,
            Insert::new("Master".to_owned(), Gain::UNITY, Pan::CENTRE, false),
        ));
        parts.channels.push((
            song.kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                song.drums,
                Gain::UNITY,
                Pan::CENTRE,
                false,
            ),
        ));
        let project = Project::new(parts);
        let kick = project.channel(song.kick).expect("the channel is here");

        assert!(
            project.output_of(kick).is_none(),
            "and not the master, which is right there"
        );
    }

    /// The many-to-one edge read from its far end. Both channels name one
    /// insert, and that is what sharing looks like from the insert's side.
    #[test]
    fn the_channels_of_an_insert_are_the_ones_naming_it() {
        let song = song();
        let project = &song.project;

        let into_drums: Vec<_> = project
            .channels_into(song.drums)
            .map(|(name, _)| name)
            .collect();

        assert_eq!(into_drums, [song.kick, song.snare]);
        assert_eq!(project.channels_into(song.master).count(), 0);
    }

    #[test]
    fn the_clips_of_a_lane_are_the_ones_naming_it() {
        let song = song();
        let project = &song.project;

        assert_eq!(project.clips_on(song.lane).count(), 1);
        assert_eq!(project.clips_on(Id::from_bits(u128::MAX)).count(), 0);
    }

    /// Arranged order is the data for these three, so it is what comes back —
    /// not the order their names happen to sort in.
    #[test]
    fn the_arranged_collections_come_back_in_the_order_they_were_arranged() {
        let song = song();
        let project = &song.project;

        assert_eq!(
            project.inserts().map(|(name, _)| name).collect::<Vec<_>>(),
            [song.master, song.drums]
        );
        assert_eq!(
            project
                .channels()
                .map(|(_, c)| c.name())
                .collect::<Vec<_>>(),
            ["Kick", "Snare"]
        );
        assert_eq!(project.lanes().count(), 1);
    }

    #[test]
    fn the_keyed_collections_come_back_whole() {
        let song = song();
        let project = &song.project;

        assert_eq!(project.patterns().count(), 1);
        assert_eq!(project.clips().count(), 1);
        assert_eq!(project.automation().count(), 1);
        assert_eq!(project.assets().count(), 1);
    }
}
