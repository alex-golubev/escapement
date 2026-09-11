//! What the interface asks the engine to do.

use escapement_time::tempo::Curve;
use escapement_time::{Position, Span};

use crate::ring::{Slot, MAX_SLOT_WORDS};
use crate::{get_i64, get_u64, put_i64, put_u64};

const _: () = assert!(Command::WORDS <= MAX_SLOT_WORDS);

// 3 and 4 were the oscillator's frequency and a master gain that was one number
// rather than a route. They are burnt rather than reused: the handshake catches
// a half built against another [`VERSION`](crate::VERSION), but a code read as
// the wrong variant inside one version is a misread rather than a message.
const START: u32 = 1;
const STOP: u32 = 2;
const AUDIO: u32 = 5;
const SET_STRIP: u32 = 6;
const SET_TEMPO: u32 = 7;
const PLACE_CLIP: u32 = 8;
const CLEAR_CLIP: u32 = 9;

/// Which strip of the route a [`CommandKind::SetStrip`] is about.
///
/// Its own type rather than the engine's `Stage`, because this is the wire and
/// the two must be able to differ: `escapement-core` is not linked by the
/// interface, and a discriminant chosen by the compiler is exactly the drift
/// the version in the header cannot catch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// The source's own strip.
    Channel,
    /// The strip it feeds.
    Insert,
    /// What everything is finally heard through.
    Master,
}

impl Stage {
    const fn code(self) -> u32 {
        match self {
            Self::Channel => 0,
            Self::Insert => 1,
            Self::Master => 2,
        }
    }

    /// `None` for a stage this half does not know, which the engine counts
    /// rather than acts on.
    const fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(Self::Channel),
            1 => Some(Self::Insert),
            2 => Some(Self::Master),
            _ => None,
        }
    }
}

/// What a tempo does on the way to the next mark, on the wire.
///
/// Apart from [`Curve`] for the reason [`Stage`] is apart from the engine's
/// enum, and converted at this boundary rather than carried.
const CURVE_HOLD: u32 = 0;
const CURVE_RAMP: u32 = 1;

const fn curve_code(curve: Curve) -> u32 {
    match curve {
        Curve::Hold => CURVE_HOLD,
        Curve::Ramp => CURVE_RAMP,
    }
}

/// Anything that is not a ramp is a hold: the two forms are a straight stretch
/// and a curve, and a stretch is what a half that knows neither should hear
/// (§2.5).
const fn curve_from_code(code: u32) -> Curve {
    match code {
        CURVE_RAMP => Curve::Ramp,
        _ => Curve::Hold,
    }
}

/// One command, with the moment it takes effect.
///
/// Every command carries the moment, not just transport: automation will want to
/// schedule a parameter the same way, and the transport has to be drivable from
/// outside — "start at position P at time T", not only "play now"
/// (ARCHITECTURE.md §2.4). The engine ignores `when` until there is a clock to
/// compare it against.
///
/// That phrasing is two values, and only one of them is here. `when` is T, a
/// moment on the engine's clock; P is where in the song, and it crosses as the
/// payload of the commands that need one, never as their schedule (§3).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Command {
    /// Samples since the engine started, and never a musical position (§3).
    ///
    /// `0` means as soon as it is seen — a sentinel that works because zero is
    /// not a moment this clock will reach again. On a musical scale it would be
    /// bar one, which is a position people use.
    pub when: u64,
    /// What to do then.
    pub kind: CommandKind,
}

impl Command {
    /// As soon as the engine sees it.
    #[must_use]
    pub const fn now(kind: CommandKind) -> Self {
        Self { when: 0, kind }
    }
}

/// What a command asks for. The wire code lives here rather than in the enum —
/// a discriminant is chosen by the compiler and would change under an edit that
/// looks harmless, which is exactly the drift the version in the header cannot
/// catch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CommandKind {
    /// Run the transport from `at`.
    ///
    /// The position is P of "start at position P at host time T" (§2.4); T is
    /// [`Command::when`], and is still ignored.
    Start {
        /// Where on the timeline to run from.
        at: Position,
    },
    /// Stop the transport, leaving its position where it is. The engine's
    /// clock ([`EngineState::clock`](crate::EngineState::clock)) is not the
    /// transport's and keeps running; what stops is the sound.
    Stop,
    /// What one strip of the route is set to. Gain is linear, pan runs from
    /// `-1.0` hard left to `1.0` hard right, and all three arrive together
    /// because they are one entity's three fields in the document (§2.6).
    SetStrip {
        /// Which of the three.
        stage: Stage,
        /// Linear, and above unity is not an error.
        gain: f32,
        /// `-1.0` hard left to `1.0` hard right.
        pan: f32,
        /// Silent, which is a property of the mix and not of who is listening
        /// (§2.4).
        mute: bool,
    },
    /// The tempo the project opens at. One mark, which is the whole of the map
    /// slice 1 carries (§2.5).
    SetTempo {
        /// Quarter notes a minute, whatever the signature says (§2.5).
        beats_per_minute: f64,
        /// What it does on the way to a mark that does not exist yet.
        curve: Curve,
    },
    /// What is on the timeline: where it starts, how long it sounds, and how
    /// far into the published frames it begins.
    ///
    /// The trim is in frames and fits a word, unlike the two musical values —
    /// it indexes the buffer in the region, and that buffer is addressed by a
    /// word (§3).
    PlaceClip {
        /// Where it starts on the timeline.
        start: Position,
        /// How long it sounds, which is the clip's and not the file's.
        length: Span,
        /// Frames into the published source at which it begins.
        trim: u32,
    },
    /// Nothing on the timeline, which is silence and not a stopped transport.
    ClearClip,
    /// What the audio buffer now holds: `frames` frames of `channels`
    /// channels, interleaved, starting `offset` words into it.
    ///
    /// The frames are there before this is sent, which is what makes the ring's
    /// release the thing that publishes them (see [`audio`](crate::audio)). A
    /// descriptor naming more than the buffer holds is refused rather than
    /// read — it crossed a memory the other half also writes to, and the engine
    /// has no error to answer with.
    Audio {
        /// The interface's count of publications, echoed back in
        /// [`EngineState::audio_publication`](crate::EngineState::audio_publication)
        /// once this one has been accepted.
        ///
        /// What makes the buffer's words owned rather than only written in
        /// order: until the echo names this publication, the engine is still
        /// reading the words the last one named, and the interface may not
        /// write there.
        publication: u32,
        /// Words into the buffer at which the frames start.
        offset: u32,
        /// How many frames, which is not how many words: a frame is one sample
        /// per channel.
        frames: u32,
        /// Interleaved, so this is the stride as well as the count.
        channels: u32,
    },
    /// Sent by a half that knows something this one does not. Kept as a value
    /// rather than an error so that decoding cannot fail on the audio thread.
    Unknown(u32),
}

impl Slot for Command {
    /// Eight words — a note event will want most of them, and an unused word
    /// costs one copy of nothing.
    const WORDS: usize = 8;

    fn encode(&self, into: &mut [u32]) {
        // Narrowed to the array once, so that every index below is one the
        // compiler can discharge. A bounds check it cannot is a panic, and a
        // panic on this path formats its message — which is how a `String` and
        // an allocator reach the module that must not have one
        // (`.claude/rules/rt-safety.md`).
        let Ok(into) = <&mut [u32; Command::WORDS]>::try_from(into) else {
            return;
        };
        // Gathered here and copied in one go, rather than written in place: a
        // variant that touches fewer words than the last one would otherwise
        // leave the difference standing, and the words behind a command are
        // read by whichever variant it turned out to be.
        let mut payload = [0u32; Command::WORDS - 3];
        let code = match self.kind {
            CommandKind::Start { at } => {
                put_i64(&mut payload, 0, at.ticks());
                START
            }
            CommandKind::Stop => STOP,
            CommandKind::SetStrip {
                stage,
                gain,
                pan,
                mute,
            } => {
                payload[0] = stage.code();
                payload[1] = gain.to_bits();
                payload[2] = pan.to_bits();
                payload[3] = u32::from(mute);
                SET_STRIP
            }
            CommandKind::SetTempo {
                beats_per_minute,
                curve,
            } => {
                put_u64(&mut payload, 0, beats_per_minute.to_bits());
                payload[2] = curve_code(curve);
                SET_TEMPO
            }
            CommandKind::PlaceClip {
                start,
                length,
                trim,
            } => {
                put_i64(&mut payload, 0, start.ticks());
                put_i64(&mut payload, 2, length.ticks());
                payload[4] = trim;
                PLACE_CLIP
            }
            CommandKind::ClearClip => CLEAR_CLIP,
            CommandKind::Audio {
                publication,
                offset,
                frames,
                channels,
            } => {
                payload[0] = publication;
                payload[1] = offset;
                payload[2] = frames;
                payload[3] = channels;
                AUDIO
            }
            CommandKind::Unknown(code) => code,
        };
        into[0] = code;
        put_u64(into, 1, self.when);
        into[3..].copy_from_slice(&payload);
    }

    fn decode(from: &[u32]) -> Self {
        // See `encode`. A slot of the wrong width cannot be a command, and the
        // honest answer to one is the same as to a code this half does not
        // know.
        let Ok(from) = <&[u32; Command::WORDS]>::try_from(from) else {
            return Self {
                when: 0,
                kind: CommandKind::Unknown(0),
            };
        };
        let when = get_u64(from, 1);
        let kind = match from[0] {
            START => CommandKind::Start {
                at: Position::from_ticks(get_i64(from, 3)),
            },
            STOP => CommandKind::Stop,
            // A stage this half does not know is the whole command being
            // unknown: the alternative is moving a strip somebody meant to
            // leave alone.
            SET_STRIP => match Stage::from_code(from[3]) {
                Some(stage) => CommandKind::SetStrip {
                    stage,
                    gain: f32::from_bits(from[4]),
                    pan: f32::from_bits(from[5]),
                    mute: from[6] != 0,
                },
                None => CommandKind::Unknown(SET_STRIP),
            },
            SET_TEMPO => CommandKind::SetTempo {
                beats_per_minute: f64::from_bits(get_u64(from, 3)),
                curve: curve_from_code(from[5]),
            },
            PLACE_CLIP => CommandKind::PlaceClip {
                start: Position::from_ticks(get_i64(from, 3)),
                length: Span::from_ticks(get_i64(from, 5)),
                trim: from[7],
            },
            CLEAR_CLIP => CommandKind::ClearClip,
            AUDIO => CommandKind::Audio {
                publication: from[3],
                offset: from[4],
                frames: from[5],
                channels: from[6],
            },
            code => CommandKind::Unknown(code),
        };
        Self { when, kind }
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use super::*;

    fn round_trip(command: Command) -> Command {
        let mut words = [0u32; Command::WORDS];
        command.encode(&mut words);
        Command::decode(&words)
    }

    #[test]
    fn every_kind_round_trips() {
        for kind in [
            CommandKind::Start {
                at: Position::quarters(-3),
            },
            CommandKind::Stop,
            CommandKind::SetStrip {
                stage: Stage::Insert,
                gain: 0.2,
                pan: -0.5,
                mute: true,
            },
            CommandKind::SetTempo {
                beats_per_minute: 137.5,
                curve: Curve::Ramp,
            },
            CommandKind::PlaceClip {
                start: Position::quarters(-2),
                length: Span::quarters(6),
                trim: 4_800,
            },
            CommandKind::ClearClip,
            CommandKind::Audio {
                publication: 4,
                offset: 1,
                frames: 2,
                channels: 3,
            },
        ] {
            let command = Command { when: 0, kind };
            assert_eq!(round_trip(command), command);
        }
    }

    #[test]
    fn the_moment_survives_the_upper_half() {
        let command = Command {
            when: u64::MAX - 1,
            kind: CommandKind::Stop,
        };
        assert_eq!(round_trip(command).when, u64::MAX - 1);
    }

    /// Every stage separately, because one of the three standing in for the
    /// others passes a test that only sends the first.
    #[test]
    fn each_stage_arrives_as_the_one_that_was_sent() {
        for stage in [Stage::Channel, Stage::Insert, Stage::Master] {
            let command = Command::now(CommandKind::SetStrip {
                stage,
                gain: 1.0,
                pan: 0.0,
                mute: false,
            });
            assert_eq!(round_trip(command), command, "{stage:?}");
        }
    }

    /// Moving a strip nobody named is worse than moving none: this half has no
    /// way to ask which one was meant.
    #[test]
    fn a_stage_this_half_does_not_know_makes_the_whole_command_unknown() {
        let mut words = [0u32; Command::WORDS];
        words[0] = SET_STRIP;
        words[3] = 9;
        assert_eq!(
            Command::decode(&words).kind,
            CommandKind::Unknown(SET_STRIP)
        );
    }

    /// Both curves separately: one code standing in for the other survives a
    /// round trip that only ever sends one of them.
    #[test]
    fn each_curve_arrives_as_the_one_that_was_sent() {
        for curve in [Curve::Hold, Curve::Ramp] {
            let command = Command::now(CommandKind::SetTempo {
                beats_per_minute: 120.0,
                curve,
            });
            assert_eq!(round_trip(command), command, "{curve:?}");
        }
    }

    /// A curve neither half knows is the steady stretch, which is the form
    /// that needs no second mark to mean something (§2.5).
    #[test]
    fn a_curve_this_half_does_not_know_is_a_hold() {
        let mut words = [0u32; Command::WORDS];
        words[0] = SET_TEMPO;
        put_u64(&mut words, 3, 120.0f64.to_bits());
        words[5] = 77;

        assert_eq!(
            Command::decode(&words).kind,
            CommandKind::SetTempo {
                beats_per_minute: 120.0,
                curve: Curve::Hold,
            }
        );
    }

    /// A clip's bounds are ticks and reach past what a word holds; the trim is
    /// frames into a buffer a word addresses.
    #[test]
    fn a_clip_carries_ticks_wider_than_a_word() {
        let start = Position::from_ticks(i64::from(u32::MAX) + 7);
        let command = Command::now(CommandKind::PlaceClip {
            start,
            length: Span::from_ticks(i64::from(u32::MAX) * 2),
            trim: u32::MAX,
        });

        assert_eq!(round_trip(command), command);
    }

    #[test]
    fn an_unknown_code_decodes_to_a_value_not_a_failure() {
        let mut words = [0u32; Command::WORDS];
        words[0] = 4242;
        assert_eq!(Command::decode(&words).kind, CommandKind::Unknown(4242));
    }

    #[test]
    fn an_untouched_slot_is_not_mistaken_for_a_command() {
        let words = [0u32; Command::WORDS];
        assert_eq!(Command::decode(&words).kind, CommandKind::Unknown(0));
    }

    #[test]
    fn encoding_leaves_nothing_of_the_previous_command_behind() {
        let mut words = [0xFFFF_FFFFu32; Command::WORDS];
        Command::now(CommandKind::Stop).encode(&mut words);
        assert_eq!(words[3..], [0; Command::WORDS - 3]);
    }
}
