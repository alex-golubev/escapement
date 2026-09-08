//! What the interface asks the engine to do.

use crate::ring::{Slot, MAX_SLOT_WORDS};
use crate::{get_u64, put_u64};

const _: () = assert!(Command::WORDS <= MAX_SLOT_WORDS);

const START: u32 = 1;
const STOP: u32 = 2;
const SET_FREQUENCY: u32 = 3;
const SET_GAIN: u32 = 4;
const AUDIO: u32 = 5;

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
    /// Run the transport from wherever it stands.
    Start,
    /// Stop the transport, leaving its position where it is. The engine's
    /// clock ([`EngineState::clock`](crate::EngineState::clock)) is not the
    /// transport's and keeps running; what stops is the sound.
    Stop,
    /// Slice 1 only: the engine is one oscillator. Goes when a graph arrives and
    /// parameters get addresses.
    SetFrequency(f32),
    /// Master gain, linear. Slice 1 only, as above.
    SetGain(f32),
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
        // Gathered here and copied in one go, rather than written in place: a
        // variant that touches fewer words than the last one would otherwise
        // leave the difference standing, and the words behind a command are
        // read by whichever variant it turned out to be.
        let mut payload = [0u32; Command::WORDS - 3];
        let code = match self.kind {
            CommandKind::Start => START,
            CommandKind::Stop => STOP,
            CommandKind::SetFrequency(hz) => {
                payload[0] = hz.to_bits();
                SET_FREQUENCY
            }
            CommandKind::SetGain(gain) => {
                payload[0] = gain.to_bits();
                SET_GAIN
            }
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
        let when = get_u64(from, 1);
        let kind = match from[0] {
            START => CommandKind::Start,
            STOP => CommandKind::Stop,
            SET_FREQUENCY => CommandKind::SetFrequency(f32::from_bits(from[3])),
            SET_GAIN => CommandKind::SetGain(f32::from_bits(from[3])),
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
            CommandKind::Start,
            CommandKind::Stop,
            CommandKind::SetFrequency(440.0),
            CommandKind::SetGain(0.2),
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
            kind: CommandKind::Start,
        };
        assert_eq!(round_trip(command).when, u64::MAX - 1);
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
