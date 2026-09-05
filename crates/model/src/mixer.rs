//! What makes a sound, what it is heard through, and how the two are joined.
//!
//! Two entities rather than one fused strip (ARCHITECTURE.md §2.6): a channel
//! is a source, an insert is a strip, and several channels share an insert.
//!
//! **The edge lives on the channel**, and that is a merge decision rather than
//! a preference (§2.6). An insert holding a list of the channels it takes turns
//! two people's moves into a channel feeding two inserts, which the audio graph
//! has no reading of; held as one field on the channel, the same pair of edits
//! converges on one insert, which somebody chose.
//!
//! **Mute is here and solo is not.** Mute is a property of the mix and shared;
//! solo is how one person is listening right now, and it belongs with the zoom
//! and the playhead outside the document (§2.4).

use crate::bounded::within;
use crate::{AssetHash, Id};

/// How loud, as a multiplier on the signal.
///
/// **Linear rather than decibels**, for two reasons that point the same way.
/// Silence in decibels is negative infinity, and a document holding an infinity
/// is one every reader has to have an opinion about. And the audio thread
/// multiplies by this number: stored as decibels it would be converted back on
/// the processing path, every quantum, from a logarithm. What a fader's travel
/// looks like is the interface's business and does not belong in the document.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Gain(f32);

impl Gain {
    /// Untouched — the signal as it arrived.
    pub const UNITY: Self = Self(1.0);

    /// Silence, which is a gain and not the absence of one.
    pub const SILENT: Self = Self(0.0);

    /// `None` for what is not a gain: negative, infinite, or not a number.
    ///
    /// Above unity is allowed and is not an error — a quiet recording is
    /// brought up, and inventing a ceiling here would be a limit nobody asked
    /// for. Below zero is refused because it is not quieter than silence; it is
    /// the signal inverted, which is a different operation wearing this one's
    /// name.
    #[must_use]
    pub fn new(amplitude: f32) -> Option<Self> {
        if amplitude.is_finite() && amplitude >= 0.0 {
            Some(Self(amplitude))
        } else {
            None
        }
    }

    /// What the signal is multiplied by.
    #[must_use]
    pub fn amplitude(self) -> f32 {
        self.0
    }
}

/// Where between the speakers, from `-1.0` hard left to `1.0` hard right.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Pan(f32);

impl Pan {
    /// Equally between the two.
    pub const CENTRE: Self = Self(0.0);

    /// `None` for anything outside the two ends, and for what is not a number.
    ///
    /// Refused rather than clamped, which is the choice `Meter::new` makes for
    /// the same reason: a document holding `3.0` was not written by anybody, so
    /// answering "hard right" hides a merge that went wrong behind a plausible
    /// mix.
    #[must_use]
    pub fn new(position: f32) -> Option<Self> {
        within(position, -1.0..=1.0).map(Self)
    }

    /// Where between the two ends.
    #[must_use]
    pub fn position(self) -> f32 {
        self.0
    }
}

/// What a channel makes its sound out of.
///
/// One variant, because the instruments and effects that would fill the rest
/// are the device interface of §2.3 and are slice 3's to draft. An enum and not
/// a bare hash so that the second one is a variant rather than a change to
/// every channel that ever existed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChannelSource {
    /// A file, played back — the sampler of §5, which is the instrument this
    /// product is mostly made of.
    Sampler(AssetHash),
}

/// A source of sound, and the strip it is heard through.
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    name: String,
    source: ChannelSource,
    output: Id<Insert>,
    gain: Gain,
    pan: Pan,
    mute: bool,
}

impl Channel {
    /// Built whole, and never afterwards adjusted. There is no method here that
    /// changes anything: what edits the document is the document, and a second
    /// way to change a channel is a second source of truth (`model.md`).
    #[must_use]
    pub fn new(
        name: String,
        source: ChannelSource,
        output: Id<Insert>,
        gain: Gain,
        pan: Pan,
        mute: bool,
    ) -> Self {
        Self {
            name,
            source,
            output,
            gain,
            pan,
            mute,
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn source(&self) -> ChannelSource {
        self.source
    }

    /// The insert this is heard through — one, always, and the whole of the
    /// routing this entity holds.
    ///
    /// The name may resolve to nothing: the insert can have been deleted by
    /// somebody while this channel was pointed at it, and no CRDT prevents that
    /// (§2.6). A channel whose insert is gone is silent, and does not fall back
    /// to the master — a merge that reroutes audio nobody rerouted is worse
    /// than one that stops it where it can be heard to have stopped.
    #[must_use]
    pub fn output(&self) -> Id<Insert> {
        self.output
    }

    #[must_use]
    pub fn gain(&self) -> Gain {
        self.gain
    }

    #[must_use]
    pub fn pan(&self) -> Pan {
        self.pan
    }

    #[must_use]
    pub fn mute(&self) -> bool {
        self.mute
    }
}

/// A strip of the mixer: what several channels are summed into.
///
/// The device chain that would sit on it is §2.3 and not here yet, and neither
/// are sends — which are the one genuinely many-to-many edge in the mixer, and
/// bring the question of a cycle with them (§2.6).
#[derive(Clone, Debug, PartialEq)]
pub struct Insert {
    name: String,
    gain: Gain,
    pan: Pan,
    mute: bool,
}

impl Insert {
    /// Built whole, as a channel is, and for the same reason.
    ///
    /// Nothing here says whether this is the master. Exactly one insert is, the
    /// project names it, and a flag on the entity would let a merge produce two
    /// of them or none.
    #[must_use]
    pub fn new(name: String, gain: Gain, pan: Pan, mute: bool) -> Self {
        Self {
            name,
            gain,
            pan,
            mute,
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn gain(&self) -> Gain {
        self.gain
    }

    #[must_use]
    pub fn pan(&self) -> Pan {
        self.pan
    }

    #[must_use]
    pub fn mute(&self) -> bool {
        self.mute
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Counter;

    fn source() -> ChannelSource {
        ChannelSource::Sampler(AssetHash::from_bytes([7; 32]))
    }

    fn channel(output: Id<Insert>) -> Channel {
        Channel::new(
            "Kick".to_owned(),
            source(),
            output,
            Gain::UNITY,
            Pan::CENTRE,
            false,
        )
    }

    #[test]
    fn unity_leaves_the_signal_alone_and_silence_is_a_gain() {
        assert_eq!(Gain::UNITY.amplitude(), 1.0);
        assert_eq!(Gain::SILENT.amplitude(), 0.0);
        assert_eq!(Gain::new(1.0), Some(Gain::UNITY));
        assert_eq!(Gain::new(0.0), Some(Gain::SILENT));
    }

    /// Each separately: one guard covering three of the four would pass a test
    /// that only tried the fourth.
    #[test]
    fn what_is_not_a_gain_is_refused() {
        assert_eq!(Gain::new(f32::NAN), None, "not a number");
        assert_eq!(Gain::new(f32::INFINITY), None, "infinite");
        assert_eq!(Gain::new(f32::NEG_INFINITY), None, "infinite");
        assert_eq!(Gain::new(-0.5), None, "inverted, not quieter");
    }

    /// Bringing a quiet recording up is ordinary, and a ceiling invented here
    /// would be one nobody asked for.
    #[test]
    fn a_gain_above_unity_is_allowed() {
        assert_eq!(Gain::new(2.0).map(Gain::amplitude), Some(2.0));
    }

    #[test]
    fn a_pan_reaches_both_ends_and_stops_there() {
        assert_eq!(Pan::CENTRE.position(), 0.0);
        assert_eq!(Pan::new(-1.0).map(Pan::position), Some(-1.0), "hard left");
        assert_eq!(Pan::new(1.0).map(Pan::position), Some(1.0), "hard right");
        assert_eq!(Pan::new(0.25).map(Pan::position), Some(0.25));
    }

    #[test]
    fn a_pan_outside_the_two_ends_is_refused_rather_than_clamped() {
        assert_eq!(Pan::new(1.5), None, "past hard right");
        assert_eq!(Pan::new(-1.5), None, "past hard left");
        assert_eq!(Pan::new(f32::NAN), None, "not a number");
        assert_eq!(Pan::new(f32::INFINITY), None, "infinite");
    }

    #[test]
    fn a_channel_holds_what_it_was_built_from() {
        let mut entropy = Counter::new();
        let output = Id::mint(&mut entropy);
        let channel = channel(output);

        assert_eq!(channel.name(), "Kick");
        assert_eq!(channel.source(), source());
        assert_eq!(channel.output(), output);
        assert_eq!(channel.gain(), Gain::UNITY);
        assert_eq!(channel.pan(), Pan::CENTRE);
        assert!(!channel.mute());
    }

    /// The shape §2.6 is about, in the only form a test can state it: the edge
    /// is one field on the channel, so two channels naming one insert is what
    /// sharing looks like, and a channel naming two is not expressible at all.
    #[test]
    fn several_channels_share_one_insert() {
        let mut entropy = Counter::new();
        let insert = Id::mint(&mut entropy);

        assert_eq!(channel(insert).output(), channel(insert).output());
    }

    /// Both ways round, for both entities. A test that only ever builds one of
    /// the two cannot tell a field that is carried from an accessor answering
    /// with the same constant every time — which is what cargo-mutants found
    /// here, once for each.
    #[test]
    fn mute_is_carried_either_way() {
        let mut entropy = Counter::new();
        let output = Id::mint(&mut entropy);
        let muted = Channel::new(
            "Kick".to_owned(),
            source(),
            output,
            Gain::UNITY,
            Pan::CENTRE,
            true,
        );

        assert!(!channel(output).mute());
        assert!(muted.mute());

        let heard = Insert::new("Drums".to_owned(), Gain::UNITY, Pan::CENTRE, false);
        assert!(!heard.mute());
    }

    #[test]
    fn an_insert_holds_what_it_was_built_from() {
        let insert = Insert::new(
            "Drums".to_owned(),
            Gain::new(0.5).expect("half is a gain"),
            Pan::new(-0.5).expect("half left is a pan"),
            true,
        );

        assert_eq!(insert.name(), "Drums");
        assert_eq!(insert.gain().amplitude(), 0.5);
        assert_eq!(insert.pan().position(), -0.5);
        assert!(insert.mute());
    }
}
