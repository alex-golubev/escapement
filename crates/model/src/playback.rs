//! What the audio thread needs out of the document, and nothing else.
//!
//! The document is a graph of names, and every one of them may resolve to
//! nothing (§2.6). The audio thread cannot follow names and has no answer for
//! an absence, so the following is done here, on the side where a `Vec` is
//! allowed and an `Option` is ordinary: resolve the clip, its channel, the
//! insert that channel feeds and the master, and hand over a value in which
//! every name is already gone.
//!
//! **An absence anywhere is silence, never a substitute.** A channel that was
//! deleted does not fall back to the master, and a master that was deleted does
//! not leave the insert as the output — a merge that reroutes audio nobody
//! rerouted is worse than one that stops it audibly (`.claude/rules/model.md`).
//!
//! **What is here is one audio clip**, which is what slice 1 plays. Patterns,
//! notes and curves resolve through the same names and are slice 3's; the
//! shape that carries many of these across the thread boundary at once is the
//! snapshot of §3, and it arrives with slice 2.

use crate::asset::Frames;
use crate::mixer::{Channel, ChannelSource, Gain, Insert, Pan};
use crate::playlist::{Clip, ClipSource};
use crate::project::Project;
use crate::timeline::Tempo;
use crate::{AssetHash, Id};
use escapement_time::{Position, Span};

/// What a channel or an insert does to the signal passing through it.
///
/// One type for both, because at this point they are the same three numbers:
/// what makes a channel a channel is that it has a source, and what makes an
/// insert an insert is that several channels reach it — and both of those are
/// answered by the time anything gets here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Strip {
    gain: Gain,
    pan: Pan,
    mute: bool,
}

impl Strip {
    #[must_use]
    pub const fn gain(self) -> Gain {
        self.gain
    }

    #[must_use]
    pub const fn pan(self) -> Pan {
        self.pan
    }

    #[must_use]
    pub const fn mute(self) -> bool {
        self.mute
    }

    fn of_channel(channel: &Channel) -> Self {
        Self {
            gain: channel.gain(),
            pan: channel.pan(),
            mute: channel.mute(),
        }
    }

    fn of_insert(insert: &Insert) -> Self {
        Self {
            gain: insert.gain(),
            pan: insert.pan(),
            mute: insert.mute(),
        }
    }
}

/// One audio clip with every name it stood on resolved: what it plays, where on
/// the timeline, and the strips it is heard through.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Audible {
    asset: AssetHash,
    start: Position,
    length: Span,
    trim: Frames,
    channel: Strip,
    insert: Strip,
    master: Option<Strip>,
}

impl Audible {
    /// The file, by the hash of its bytes. What puts those bytes where the
    /// engine can read them is not this crate's (§3).
    #[must_use]
    pub const fn asset(self) -> AssetHash {
        self.asset
    }

    /// Where it starts on the timeline, in musical time — samples are the
    /// engine's, and appear where it meets the clock (§2.5).
    #[must_use]
    pub const fn start(self) -> Position {
        self.start
    }

    /// How long it sounds for, which is the clip's and not the file's.
    #[must_use]
    pub const fn length(self) -> Span {
        self.length
    }

    /// How far into the file it begins, in the file's own frames — the third
    /// count, and the one that must not be spelled in ticks (§2.5).
    #[must_use]
    pub const fn trim(self) -> Frames {
        self.trim
    }

    /// The channel it sounds on.
    #[must_use]
    pub const fn channel(self) -> Strip {
        self.channel
    }

    /// The insert that channel feeds.
    #[must_use]
    pub const fn insert(self) -> Strip {
        self.insert
    }

    /// The master, or nothing when the insert above already is it.
    ///
    /// Nothing rather than a second copy of the same strip: applied twice, a
    /// master at half gain is a quarter, and the project is quiet for a reason
    /// nothing in the document says.
    #[must_use]
    pub const fn master(self) -> Option<Strip> {
        self.master
    }
}

/// What the document is playing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Playback {
    tempo: Tempo,
    clip: Option<Audible>,
}

impl Playback {
    /// Reads one clip out of `project`.
    ///
    /// The clip is named rather than searched for: which of them is being
    /// played is the caller's business, and picking "the first audio clip"
    /// here would be an arrangement decision taken by a projection.
    #[must_use]
    pub fn of(project: &Project, clip: Id<Clip>) -> Self {
        Self {
            tempo: project.timeline().tempo(),
            clip: audible(project, clip),
        }
    }

    /// The tempo the project opens at.
    ///
    /// One mark, which is what slice 1 carries across the boundary. The rest of
    /// the map is in the timeline and reaches the engine when more than one of
    /// them does.
    #[must_use]
    pub const fn tempo(self) -> Tempo {
        self.tempo
    }

    /// The clip, or nothing — and nothing is what a project plays when any name
    /// along the route is gone.
    #[must_use]
    pub const fn clip(self) -> Option<Audible> {
        self.clip
    }
}

/// Every name on the route, resolved in the order the signal takes.
fn audible(project: &Project, name: Id<Clip>) -> Option<Audible> {
    let clip = project.clip(name)?;
    let ClipSource::Audio { trim, .. } = clip.source() else {
        return None;
    };
    let channel = project.channel_of(clip)?;
    let ChannelSource::Sampler(asset) = channel.source();
    // A file the document does not know is one nothing can be read from: the
    // bytes are found by this hash, and an asset removed while a clip still
    // names it is an ordinary merge rather than a broken document.
    project.asset(asset)?;

    let insert = project.output_of(channel)?;
    let master = if channel.output() == project.master() {
        None
    } else {
        Some(Strip::of_insert(project.master_insert()?))
    };

    Some(Audible {
        asset,
        start: clip.start(),
        length: clip.length(),
        trim,
        channel: Strip::of_channel(channel),
        insert: Strip::of_insert(insert),
        master,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Counter;
    use crate::playlist::Lane;
    use crate::project::Parts;
    use crate::timeline::Timeline;
    use crate::Asset;
    use escapement_time::meter::Meter;
    use escapement_time::tempo::Curve;
    use escapement_time::SampleRate;

    const SAMPLE: AssetHash = AssetHash::from_bytes([7; 32]);

    /// Distinct on purpose: a strip read off the wrong entity passes a test
    /// where all three are unity.
    const CHANNEL_GAIN: f32 = 0.5;
    const INSERT_GAIN: f32 = 0.25;
    const MASTER_GAIN: f32 = 0.75;

    struct Names {
        master: Id<Insert>,
        drums: Id<Insert>,
        kick: Id<Channel>,
        clip: Id<Clip>,
        notes: Id<Clip>,
    }

    fn gain(amplitude: f32) -> Gain {
        Gain::new(amplitude).expect("a fraction is a gain")
    }

    /// A clip on a channel into a sub-insert into the master: the longest route
    /// slice 1 can be asked for, so that dropping any one name has somewhere to
    /// drop from. Handed back unbuilt, because half the tests here are about a
    /// name that is missing.
    fn song() -> (Parts, Names) {
        let mut entropy = Counter::new();
        let names = Names {
            master: Id::mint(&mut entropy),
            drums: Id::mint(&mut entropy),
            kick: Id::mint(&mut entropy),
            clip: Id::mint(&mut entropy),
            notes: Id::mint(&mut entropy),
        };
        let lane: Id<Lane> = Id::mint(&mut entropy);
        let pattern = Id::mint(&mut entropy);

        let mut parts = Parts::new("Song".to_owned(), names.master);
        parts.inserts.push((
            names.master,
            Insert::new("Master".to_owned(), gain(MASTER_GAIN), Pan::CENTRE, false),
        ));
        parts.inserts.push((
            names.drums,
            Insert::new("Drums".to_owned(), gain(INSERT_GAIN), Pan::CENTRE, false),
        ));
        parts.channels.push((
            names.kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                names.drums,
                gain(CHANNEL_GAIN),
                Pan::new(-1.0).expect("hard left is a pan"),
                false,
            ),
        ));
        parts.lanes.push((lane, Lane::new("Drums".to_owned())));
        parts.clips.insert(
            names.clip,
            Clip::new(
                lane,
                Position::quarters(4),
                Span::quarters(2),
                ClipSource::Audio {
                    channel: names.kick,
                    trim: Frames::new(240),
                },
            ),
        );
        parts.clips.insert(
            names.notes,
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

        (parts, names)
    }

    fn playing(parts: Parts, names: &Names) -> Playback {
        Playback::of(&Project::new(parts), names.clip)
    }

    #[test]
    fn a_clip_arrives_with_every_name_on_its_route_resolved() {
        let (parts, names) = song();
        let audible = playing(parts, &names).clip().expect("it plays");

        assert_eq!(audible.asset(), SAMPLE);
        assert_eq!(audible.start(), Position::quarters(4));
        assert_eq!(audible.length(), Span::quarters(2));
        assert_eq!(audible.trim(), Frames::new(240));
        assert_eq!(audible.channel().gain(), gain(CHANNEL_GAIN));
        assert_eq!(audible.channel().pan().position(), -1.0);
        assert_eq!(audible.insert().gain(), gain(INSERT_GAIN));
        assert_eq!(
            audible.master().map(Strip::gain),
            Some(gain(MASTER_GAIN)),
            "the sub-insert is not the master, so both are on the route"
        );
    }

    /// Mute is carried, never acted on: which strip falls silent is the
    /// engine's, and a projection that dropped the flag would leave a muted
    /// channel audible with nothing in the document to explain it.
    #[test]
    fn a_mute_on_any_strip_comes_over_as_it_was_written() {
        for muted in [false, true] {
            let (mut parts, names) = song();
            parts.inserts = vec![
                (
                    names.master,
                    Insert::new("Master".to_owned(), gain(MASTER_GAIN), Pan::CENTRE, muted),
                ),
                (
                    names.drums,
                    Insert::new("Drums".to_owned(), gain(INSERT_GAIN), Pan::CENTRE, muted),
                ),
            ];
            parts.channels = vec![(
                names.kick,
                Channel::new(
                    "Kick".to_owned(),
                    ChannelSource::Sampler(SAMPLE),
                    names.drums,
                    gain(CHANNEL_GAIN),
                    Pan::CENTRE,
                    muted,
                ),
            )];
            let audible = playing(parts, &names).clip().expect("it plays");

            assert_eq!(audible.channel().mute(), muted, "channel");
            assert_eq!(audible.insert().mute(), muted, "insert");
            assert_eq!(audible.master().map(Strip::mute), Some(muted), "master");
        }
    }

    /// Applied twice a master at half gain is a quarter, and nothing in the
    /// document says so.
    #[test]
    fn a_channel_straight_into_the_master_carries_it_once() {
        let (mut parts, names) = song();
        parts.channels.clear();
        parts.channels.push((
            names.kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                names.master,
                gain(CHANNEL_GAIN),
                Pan::CENTRE,
                false,
            ),
        ));
        let audible = playing(parts, &names).clip().expect("it plays");

        assert_eq!(audible.insert().gain(), gain(MASTER_GAIN));
        assert_eq!(audible.master(), None);
    }

    /// Four names and one answer. Each is dropped on its own, because a guard
    /// covering three of them passes every test that only tries the fourth.
    #[test]
    fn a_name_that_is_gone_anywhere_on_the_route_is_silence() {
        let (mut parts, names) = song();
        parts.channels.clear();
        assert!(
            playing(parts, &names).clip().is_none(),
            "the channel is gone, and the clip does not fall back to the master"
        );

        let (mut parts, names) = song();
        parts.inserts.retain(|(name, _)| *name != names.drums);
        assert!(
            playing(parts, &names).clip().is_none(),
            "the insert it feeds is gone, and silence is not the master either"
        );

        let (mut parts, names) = song();
        parts.inserts.retain(|(name, _)| *name != names.master);
        assert!(
            playing(parts, &names).clip().is_none(),
            "the master is gone, and the sub-insert does not become the output"
        );

        let (mut parts, names) = song();
        parts.assets.clear();
        assert!(
            playing(parts, &names).clip().is_none(),
            "the file is not in the document, so there is nothing to read"
        );
    }

    #[test]
    fn a_clip_that_is_not_audio_and_a_clip_that_is_not_there_both_read_as_silence() {
        let (parts, names) = song();
        let project = Project::new(parts);

        assert!(Playback::of(&project, names.notes).clip().is_none());
        assert!(Playback::of(&project, Id::from_bits(u128::MAX))
            .clip()
            .is_none());
    }

    /// The tempo comes over whether or not anything is playing: an empty
    /// project still has a clock, and the engine is driven by it.
    #[test]
    fn the_tempo_comes_from_the_timeline_even_when_nothing_plays() {
        let (mut parts, names) = song();
        parts.timeline = Timeline::new(
            Tempo::new(90.0, Curve::Ramp).expect("a tempo is a tempo"),
            Meter::new(3, 4).expect("three quarters is a signature"),
        );
        parts.clips.clear();
        let playback = playing(parts, &names);

        assert_eq!(playback.tempo().beats_per_minute(), 90.0);
        assert_eq!(playback.tempo().curve(), Curve::Ramp);
        assert!(playback.clip().is_none());
    }
}
