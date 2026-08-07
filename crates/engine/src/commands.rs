//! The binary command protocol, UI → audio.
//!
//! This module is one half of a contract. The other half lives in
//! `web/src/audio/protocol.ts`, and the two are edited together: a mismatch
//! here produces silently wrong behavior that is very hard to diagnose.
//! Hence [`PROTOCOL_VERSION`], checked at init, and a byte layout pinned by
//! [`tests::wire_format_is_pinned`].
//!
//! Record layout, 16 bytes, little-endian:
//!
//! ```text
//! offset 0   u8   op       — opcode; 0 means "empty"
//! offset 1   u8   arg_a    — track / slot
//! offset 2   u16  arg_b    — step / parameter index
//! offset 4   f32  value    — value
//! offset 8   u32  at_lo    — target sample, low word
//! offset 12  u32  at_hi    — target sample, high word
//! ```
//!
//! Little-endian is WASM's own byte order; on the JS side `DataView`
//! requires stating it explicitly (the trailing `true` argument).

/// Protocol version. Bumped on any change to the layout or the opcode set.
/// Checked when the engine is initialized.
pub const PROTOCOL_VERSION: u32 = 1;

/// Size of a single record, in bytes.
pub const COMMAND_SIZE: usize = 16;

/// Opcode of an empty record. Zeroed memory decodes to `None` rather than to
/// some arbitrary command — an important property, and one that is tested.
pub const OP_NONE: u8 = 0;

/// Opcodes. Numbering starts at 1: zero is reserved for "empty".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
    Play = 1,
    Stop = 2,
    SetBpm = 3,
}

impl Op {
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Op::Play),
            2 => Some(Op::Stop),
            3 => Some(Op::SetBpm),
            _ => None,
        }
    }
}

/// A decoded command.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    Play,
    Stop,
    SetBpm { bpm: f32 },
}

/// A command together with the instant it applies at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Record {
    pub command: Command,
    /// Target position in samples; `0` means "apply immediately".
    pub at_sample: u64,
}

impl Record {
    pub fn immediate(command: Command) -> Self {
        Self { command, at_sample: 0 }
    }

    /// Decode a record. The input is untrusted: another thread writes it into
    /// shared memory, so any unknown opcode yields `None` rather than a panic.
    ///
    /// The codec deliberately validates nothing on the merits — it has no idea
    /// which BPM is sensible. Clamping values is up to the consumer
    /// (see `Transport::set_bpm`).
    pub fn decode(bytes: &[u8; COMMAND_SIZE]) -> Option<Self> {
        let op = Op::from_byte(bytes[0])?;
        let value = f32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let at_lo = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        let at_hi = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);

        let command = match op {
            Op::Play => Command::Play,
            Op::Stop => Command::Stop,
            Op::SetBpm => Command::SetBpm { bpm: value },
        };

        Some(Self {
            command,
            at_sample: (u64::from(at_hi) << 32) | u64::from(at_lo),
        })
    }

    /// Encode a record. The engine never needs this — tests, the offline
    /// renderer, and the executable specification of what the TS side must do.
    pub fn encode(&self) -> [u8; COMMAND_SIZE] {
        let (op, arg_a, arg_b, value) = match self.command {
            Command::Play => (Op::Play, 0u8, 0u16, 0.0f32),
            Command::Stop => (Op::Stop, 0, 0, 0.0),
            Command::SetBpm { bpm } => (Op::SetBpm, 0, 0, bpm),
        };

        let mut out = [0u8; COMMAND_SIZE];
        out[0] = op as u8;
        out[1] = arg_a;
        out[2..4].copy_from_slice(&arg_b.to_le_bytes());
        out[4..8].copy_from_slice(&value.to_le_bytes());
        out[8..12].copy_from_slice(&(self.at_sample as u32).to_le_bytes());
        out[12..16].copy_from_slice(&((self.at_sample >> 32) as u32).to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(record: Record) -> Option<Record> {
        Record::decode(&record.encode())
    }

    #[test]
    fn round_trips_every_command() {
        let commands = [
            Command::Play,
            Command::Stop,
            Command::SetBpm { bpm: 127.5 },
        ];
        for command in commands {
            let record = Record::immediate(command);
            assert_eq!(round_trip(record), Some(record), "{command:?} did not survive");
        }
    }

    #[test]
    fn round_trips_full_range_of_at_sample() {
        // Values around the 2^32 boundary — exactly where a mistake in
        // splitting the words goes unnoticed during short sessions.
        let positions = [
            0,
            1,
            u64::from(u32::MAX) - 1,
            u64::from(u32::MAX),
            u64::from(u32::MAX) + 1,
            1 << 32,
            (1 << 32) + 12_345,
            1 << 53,
            u64::MAX,
        ];
        for at_sample in positions {
            let record = Record { command: Command::Play, at_sample };
            assert_eq!(round_trip(record), Some(record), "position {at_sample} did not survive");
        }
    }

    /// Pins the byte layout. This test must fail on any format change — that
    /// is the signal to update both `protocol.ts` and [`PROTOCOL_VERSION`].
    #[test]
    fn wire_format_is_pinned() {
        let record = Record {
            command: Command::SetBpm { bpm: 1.0 },
            at_sample: 0x0000_00AB_1234_5678,
        };
        assert_eq!(
            record.encode(),
            [
                0x03, // op = SetBpm
                0x00, // arg_a
                0x00, 0x00, // arg_b
                0x00, 0x00, 0x80, 0x3F, // value = 1.0f32, little-endian
                0x78, 0x56, 0x34, 0x12, // at_lo
                0xAB, 0x00, 0x00, 0x00, // at_hi
            ]
        );
    }

    #[test]
    fn zeroed_memory_decodes_to_nothing() {
        assert_eq!(Record::decode(&[0u8; COMMAND_SIZE]), None);
        assert_eq!(OP_NONE, 0);
    }

    #[test]
    fn unknown_op_is_rejected_not_panicked() {
        for op in 4..=u8::MAX {
            let mut bytes = [0xFFu8; COMMAND_SIZE];
            bytes[0] = op;
            assert_eq!(Record::decode(&bytes), None, "opcode {op} must not decode");
        }
    }

    #[test]
    fn unused_fields_are_ignored_on_decode() {
        // Garbage in unused fields must not break decoding: that is how
        // records left over from a previous lap around the ring look.
        let mut bytes = Record::immediate(Command::Play).encode();
        bytes[1] = 0xEE;
        bytes[2] = 0xEE;
        bytes[3] = 0xEE;
        bytes[4] = 0xEE;
        assert_eq!(
            Record::decode(&bytes),
            Some(Record::immediate(Command::Play))
        );
    }

    #[test]
    fn codec_is_transparent_to_non_finite_values() {
        let bytes = Record::immediate(Command::SetBpm { bpm: f32::NAN }).encode();
        match Record::decode(&bytes) {
            Some(Record { command: Command::SetBpm { bpm }, .. }) => assert!(bpm.is_nan()),
            other => panic!("expected SetBpm with NaN, got {other:?}"),
        }
    }

    #[test]
    fn record_size_matches_declared_constant() {
        assert_eq!(Record::immediate(Command::Stop).encode().len(), COMMAND_SIZE);
        assert_eq!(COMMAND_SIZE, 16);
    }
}
