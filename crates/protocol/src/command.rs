//! What the interface asks the engine to do.

use crate::ring::{Slot, MAX_SLOT_WORDS};
use crate::{get_u64, put_u64};

const _: () = assert!(Command::WORDS <= MAX_SLOT_WORDS);

const START: u32 = 1;
const STOP: u32 = 2;
const SET_FREQUENCY: u32 = 3;
const SET_GAIN: u32 = 4;

/// One command, with the moment it takes effect.
///
/// Every command carries the moment, not just transport: automation will want to
/// schedule a parameter the same way, and the transport has to be drivable from
/// outside — "start at position P at time T", not only "play now"
/// (ARCHITECTURE.md §2.4). The engine ignores `when` until there is a clock to
/// compare it against.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Command {
    /// Samples since the engine started. `0` means as soon as it is seen.
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
    /// Stop it, leaving the playhead where it is.
    Stop,
    /// Slice 1 only: the engine is one oscillator. Goes when a graph arrives and
    /// parameters get addresses.
    SetFrequency(f32),
    /// Master gain, linear. Slice 1 only, as above.
    SetGain(f32),
    /// Sent by a half that knows something this one does not. Kept as a value
    /// rather than an error so that decoding cannot fail on the audio thread.
    Unknown(u32),
}

impl Slot for Command {
    /// Eight words — a note event will want most of them, and an unused word
    /// costs one copy of nothing.
    const WORDS: usize = 8;

    fn encode(&self, into: &mut [u32]) {
        let (code, payload) = match self.kind {
            CommandKind::Start => (START, 0),
            CommandKind::Stop => (STOP, 0),
            CommandKind::SetFrequency(hz) => (SET_FREQUENCY, hz.to_bits()),
            CommandKind::SetGain(gain) => (SET_GAIN, gain.to_bits()),
            CommandKind::Unknown(code) => (code, 0),
        };
        into[0] = code;
        put_u64(into, 1, self.when);
        into[3] = payload;
        into[4..].fill(0);
    }

    fn decode(from: &[u32]) -> Self {
        let when = get_u64(from, 1);
        let payload = from[3];
        let kind = match from[0] {
            START => CommandKind::Start,
            STOP => CommandKind::Stop,
            SET_FREQUENCY => CommandKind::SetFrequency(f32::from_bits(payload)),
            SET_GAIN => CommandKind::SetGain(f32::from_bits(payload)),
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
