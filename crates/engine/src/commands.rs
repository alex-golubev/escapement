//! The binary command protocol, UI → audio.
//!
//! This module is one half of a contract. The other half lives in
//! `web/src/audio/protocol.ts`, and the two are edited together: a mismatch
//! here produces silently wrong behavior that is very hard to diagnose.
//! Hence [`PROTOCOL_VERSION`], checked at init, and a byte layout pinned by
//! `tests::wire_format_is_pinned`.
//!
//! Adding an opcode touches five places here — [`Op`], [`Op::from_byte`],
//! [`Command`], and the two matches in [`Record`] — of which the compiler
//! guards all but `from_byte`. `tests::OPCODES` guards that one, and is the
//! list to extend first.
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

/// Protocol version. Checked when the engine is initialized.
///
/// Its scope is **everything that crosses the ABI, in either direction**: the
/// record layout and the opcode set here, and the telemetry block laid out in
/// [`crate::engine`] going the other way. Declared this widely on purpose — the
/// number is what makes a JavaScript artifact built against an older shape
/// refuse to start, and a layout left outside its scope is one where that
/// refusal never happens and the symptom is wrong values instead of silence.
///
/// Bumped on any change to either shape. One number rather than two: a second
/// version would itself need reconciling with this one, and four telemetry
/// words do not earn that.
pub const PROTOCOL_VERSION: u32 = 3;

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
    SetTrackGain = 4,
    SetTrackPan = 5,
    SetMasterGain = 6,
    SetStep = 7,
    ClearPattern = 8,
}

impl Op {
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Op::Play),
            2 => Some(Op::Stop),
            3 => Some(Op::SetBpm),
            4 => Some(Op::SetTrackGain),
            5 => Some(Op::SetTrackPan),
            6 => Some(Op::SetMasterGain),
            7 => Some(Op::SetStep),
            8 => Some(Op::ClearPattern),
            _ => None,
        }
    }
}

/// A decoded command.
///
/// Ranges are not this type's business. A `track` here is whatever byte
/// arrived, and a gain is whatever the four bytes said — validating on the
/// merits belongs to whoever applies the command, which is the only place that
/// knows how many tracks exist or what a sensible gain is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    Play,
    Stop,
    SetBpm { bpm: f32 },
    SetTrackGain { track: u8, gain: f32 },
    SetTrackPan { track: u8, pan: f32 },
    SetMasterGain { gain: f32 },
    /// Velocity `0.0` is a step that does not sound; there is no separate
    /// on/off flag on the wire, for the reason [`crate::pattern`] gives.
    SetStep { track: u8, step: u16, velocity: f32 },
    ClearPattern,
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
        let arg_a = bytes[1];
        let arg_b = u16::from_le_bytes([bytes[2], bytes[3]]);
        let value = f32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let at_lo = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        let at_hi = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);

        let command = match op {
            Op::Play => Command::Play,
            Op::Stop => Command::Stop,
            Op::SetBpm => Command::SetBpm { bpm: value },
            Op::SetTrackGain => Command::SetTrackGain { track: arg_a, gain: value },
            Op::SetTrackPan => Command::SetTrackPan { track: arg_a, pan: value },
            Op::SetMasterGain => Command::SetMasterGain { gain: value },
            Op::SetStep => Command::SetStep { track: arg_a, step: arg_b, velocity: value },
            Op::ClearPattern => Command::ClearPattern,
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
            Command::SetTrackGain { track, gain } => (Op::SetTrackGain, track, 0, gain),
            Command::SetTrackPan { track, pan } => (Op::SetTrackPan, track, 0, pan),
            Command::SetMasterGain { gain } => (Op::SetMasterGain, 0, 0, gain),
            Command::SetStep { track, step, velocity } => (Op::SetStep, track, step, velocity),
            Command::ClearPattern => (Op::ClearPattern, 0, 0, 0.0),
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

    /// Every opcode: the byte it travels as, the [`Op`] that byte must decode
    /// to, and a command that encodes with it.
    ///
    /// The numbers are literals rather than `Op::Play as u8`, for the reason
    /// every pin in this repository is a literal — a table read out of the enum
    /// agrees with whatever the enum says, renumbering included. Here it closes
    /// the one gap the compiler leaves open. `decode` and `encode` match on
    /// their enums with no `_` arm, so a new variant fails to compile until
    /// both are extended; [`Op::from_byte`] ends in `_ => None`, and a variant
    /// missing from *it* compiles cleanly and decodes to nothing at all. The
    /// symptom is a command the page sends, the engine discards, and no one
    /// reports.
    ///
    /// A new opcode is added here too, and forgetting to is caught rather than
    /// tolerated: a byte `from_byte` recognizes but this table does not fails
    /// `no_byte_outside_the_table_decodes`.
    /// Addresses in the specimens are non-zero on purpose. `arg_a` was a field
    /// every command wrote as zero until the mixer arrived, and `arg_b` until
    /// the pattern did, so a specimen leaving either at zero would round-trip
    /// happily through a decoder that ignored the field entirely.
    const OPCODES: &[(u8, Op, Command)] = &[
        (1, Op::Play, Command::Play),
        (2, Op::Stop, Command::Stop),
        (3, Op::SetBpm, Command::SetBpm { bpm: 127.5 }),
        (4, Op::SetTrackGain, Command::SetTrackGain { track: 5, gain: 0.75 }),
        (5, Op::SetTrackPan, Command::SetTrackPan { track: 2, pan: -0.5 }),
        (6, Op::SetMasterGain, Command::SetMasterGain { gain: 1.25 }),
        (7, Op::SetStep, Command::SetStep { track: 3, step: 11, velocity: 0.6 }),
        (8, Op::ClearPattern, Command::ClearPattern),
    ];

    fn round_trip(record: Record) -> Option<Record> {
        Record::decode(&record.encode())
    }

    #[test]
    fn every_opcode_decodes_to_the_variant_it_is_numbered_for() {
        for &(byte, op, _) in OPCODES {
            assert_eq!(Op::from_byte(byte), Some(op), "byte {byte} decoded to something else");
            // The enum's own discriminant, checked separately from the mapping
            // above: `from_byte` could agree with this table while `encode`,
            // which writes `op as u8`, disagrees with both.
            assert_eq!(op as u8, byte, "{op:?} is {} in the enum and {byte} here", op as u8);
        }
    }

    #[test]
    fn every_command_encodes_with_its_own_opcode() {
        // The same pairing from the other end. `encode` picks an opcode by
        // matching on `Command`, and nothing else checks that it picks the one
        // `decode` reads back.
        for &(byte, _, command) in OPCODES {
            assert_eq!(Record::immediate(command).encode()[0], byte, "{command:?}");
        }
    }

    #[test]
    fn round_trips_every_command() {
        for &(_, _, command) in OPCODES {
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

        // A second record, because the one above says nothing about where
        // `arg_a` and `arg_b` sit: it writes zeros into both, and so does
        // every byte around them. Until the mixer and the pattern, no command
        // filled either field at all, and their offsets were pinned by the
        // comment at the top of this file and by nothing else. `SetStep` is
        // the specimen because it is the only command that addresses through
        // both — and the two are adjacent, which is exactly where a one-byte
        // slip stays plausible: a step written one byte early lands in
        // `arg_a`, and every strike goes to the wrong track.
        let addressed = Record::immediate(Command::SetStep { track: 3, step: 11, velocity: 0.5 });
        assert_eq!(
            addressed.encode(),
            [
                0x07, // op = SetStep
                0x03, // arg_a = track 3
                0x0B, 0x00, // arg_b = step 11, little-endian
                0x00, 0x00, 0x00, 0x3F, // value = 0.5f32, little-endian
                0x00, 0x00, 0x00, 0x00, // at_lo — immediate
                0x00, 0x00, 0x00, 0x00, // at_hi
            ]
        );
    }

    #[test]
    fn zeroed_memory_decodes_to_nothing() {
        assert_eq!(Record::decode(&[0u8; COMMAND_SIZE]), None);
        assert_eq!(OP_NONE, 0);
    }

    #[test]
    fn no_byte_outside_the_table_decodes() {
        // The boundary was written as `4..=u8::MAX`: a literal to be moved by
        // hand on every addition, and one that said nothing about which
        // opcodes exist. Derived from the table it also bites the other way —
        // an opcode reachable through `from_byte` but absent from the table
        // decodes here, where nothing must.
        //
        // Every other field is 0xFF, so this doubles as the check that
        // decoding is total: the exchange area holds whatever another thread
        // wrote, and under `panic = "abort"` one panic takes the sound with it.
        for byte in 0..=u8::MAX {
            if OPCODES.iter().any(|&(known, _, _)| known == byte) {
                continue;
            }
            let mut bytes = [0xFFu8; COMMAND_SIZE];
            bytes[0] = byte;
            assert_eq!(Record::decode(&bytes), None, "byte {byte} must not decode");
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
