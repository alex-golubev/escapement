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
/// record layout and the opcode set here, the telemetry block laid out in
/// [`crate::engine`] going the other way, and the grid the address fields of a
/// record index — [`crate::TRACKS`] by [`crate::pattern::STEPS`]. Declared this
/// widely on purpose — the number is what makes a JavaScript artifact built
/// against an older shape refuse to start, and anything left outside its scope
/// is where that refusal never happens and the symptom is wrong values instead
/// of silence.
///
/// The grid is in scope even though no byte moves when it changes, and that is
/// the case worth spelling out. Its symptom is neither wrong values nor
/// silence: an index past the end of the grid is dropped, correctly, so a page
/// built for twelve tracks against an engine holding eight gets four tracks
/// that accept commands and do nothing, reported by nobody. The two numbers are
/// mirrored in `protocol.ts` and pinned on both sides;
/// `tests::grid_dimensions_are_pinned` is what fails first.
///
/// Bumped on any change to any of the three. One number rather than three: the
/// others would themselves need reconciling with this one, and five telemetry
/// words and two dimensions do not earn that.
pub const PROTOCOL_VERSION: u32 = 5;

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
    SetMetronome = 9,
    TriggerTrack = 10,
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
            9 => Some(Op::SetMetronome),
            10 => Some(Op::TriggerTrack),
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
///
/// **A receiver takes its field at the width it arrived in**, `u8` for a track
/// and `u16` for a step, rather than widened into a `usize` index. The type is
/// what says where the checking has not happened yet: every value of a `u8` is
/// reachable from the wire, so a parameter typed that way is visibly obliged to
/// be total over all of them, while a `usize` reads as an index somebody has
/// already made safe. `Mixer::set_track_gain`, `Pattern::set_step` and
/// `Sampler::trigger` all take the wire width and drop what the grid has no
/// room for.
///
/// **Dropped, and not wrapped or panicked**, which is the same decision at
/// every one of them. Folding an index into the grid would turn a bug on the
/// far side into a wrong sound here — a step meant for track 200 striking track
/// 0, a whole pattern collapsed onto one row, and every assertion about "the
/// step" still passing. Dropping it leaves a silence somebody goes looking for.
/// Panicking is not on offer at all: release builds set `panic = "abort"`, so a
/// single index out of range ends the worklet and every sound with it until the
/// page is reloaded.
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
    /// A switch, travelling in `value` as non-zero for on.
    ///
    /// **A flag is the one thing crossing here that cannot be out of range**,
    /// and that is why it decodes to a `bool` while a gain does not. The refusal
    /// a non-finite parameter gets exists because such a value would go on
    /// multiplying samples; a switch multiplies nothing, and both of its states
    /// are states the engine is willing to be in. So the mapping is total over
    /// every bit pattern the wire can hold — the only question is which side NaN
    /// falls on, and it falls on the side every other non-zero pattern does.
    /// `a_flag_is_total_over_every_bit_pattern_the_wire_can_carry` says so
    /// out loud.
    ///
    /// In `value` rather than `arg_a`, which would have been the cheaper byte:
    /// the address fields address, and a switch has nothing to address.
    SetMetronome { enabled: bool },
    /// Strike a track outside the grid — a pad, or the preview of a cell being
    /// edited.
    ///
    /// **It sounds with the transport stopped**, which is what makes it a
    /// different thing from a step rather than a shortcut to one: a step is read
    /// by the walk over frames, and there is no walk while nothing is playing.
    ///
    /// Velocity rides in `value`, the field a cell already uses for the same
    /// number, so a preview is as hard as the cell it previews and nothing new
    /// goes on the wire for it.
    TriggerTrack { track: u8, velocity: f32 },
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
            Op::SetMetronome => Command::SetMetronome { enabled: value != 0.0 },
            Op::TriggerTrack => Command::TriggerTrack { track: arg_a, velocity: value },
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
            Command::SetMetronome { enabled } => {
                (Op::SetMetronome, 0, 0, if enabled { 1.0 } else { 0.0 })
            }
            Command::TriggerTrack { track, velocity } => (Op::TriggerTrack, track, 0, velocity),
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
    // The grid is the receiver's, not the codec's, and the codec stays ignorant
    // of it — this import is `cfg(test)` and reaches no shipping line here. The
    // pins below sit in this file rather than beside either declaration because
    // a pin belongs with the shape it holds and opposite its mirror, and the
    // mirror of these two is in `protocol.spec.ts` with the rest.
    use crate::{TRACKS, pattern::STEPS};

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
    ///
    /// `arg_b` needs more than non-zero: both of its bytes have to carry
    /// something, which is why the step here is 513 rather than one the grid
    /// has. It is the only 16-bit field in the record, and any step inside the
    /// sixteen leaves the high byte at zero — a specimen that cannot tell a
    /// `u16` from a `u8`. Narrowing the field to one byte on both sides of the
    /// codec was tried and left every test in the crate green. Out of range is
    /// no obstacle: this codec validates nothing on the merits, and the field
    /// is sixteen bits precisely because it will carry a parameter index, where
    /// 513 is an ordinary value rather than an impossible one.
    const OPCODES: &[(u8, Op, Command)] = &[
        (1, Op::Play, Command::Play),
        (2, Op::Stop, Command::Stop),
        (3, Op::SetBpm, Command::SetBpm { bpm: 127.5 }),
        (4, Op::SetTrackGain, Command::SetTrackGain { track: 5, gain: 0.75 }),
        (5, Op::SetTrackPan, Command::SetTrackPan { track: 2, pan: -0.5 }),
        (6, Op::SetMasterGain, Command::SetMasterGain { gain: 1.25 }),
        (7, Op::SetStep, Command::SetStep { track: 3, step: 513, velocity: 0.6 }),
        (8, Op::ClearPattern, Command::ClearPattern),
        (9, Op::SetMetronome, Command::SetMetronome { enabled: true }),
        (10, Op::TriggerTrack, Command::TriggerTrack { track: 6, velocity: 0.4 }),
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

    #[test]
    fn round_trips_the_full_range_of_a_step() {
        // The property the specimen in the table is carrying, said out loud so
        // that the pin does not rest on one value. A step of 513 up there is
        // exactly the kind of thing a later reader replaces with a step the
        // grid has, out of tidiness, and both bytes of `arg_b` stop being
        // exercised the moment they do. The boundary is 255/256, where a field
        // narrowed to a byte stops agreeing with one that was not.
        for step in [0u16, 1, 15, 255, 256, 257, u16::MAX] {
            let record = Record::immediate(Command::SetStep { track: 3, step, velocity: 0.5 });
            assert_eq!(round_trip(record), Some(record), "step {step} did not survive");
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
        //
        // The step is 513 and not a legal one so that both bytes of `arg_b`
        // hold something. With a step from inside the grid the high byte is
        // zero, and the array below would be equally true of a field only
        // eight bits wide — which is the one shape of this record no pin here
        // used to rule out.
        let addressed = Record::immediate(Command::SetStep { track: 3, step: 513, velocity: 0.5 });
        assert_eq!(
            addressed.encode(),
            [
                0x07, // op = SetStep
                0x03, // arg_a = track 3
                0x01, 0x02, // arg_b = step 513, little-endian
                0x00, 0x00, 0x00, 0x3F, // value = 0.5f32, little-endian
                0x00, 0x00, 0x00, 0x00, // at_lo — immediate
                0x00, 0x00, 0x00, 0x00, // at_hi
            ]
        );
    }

    /// Pins the grid the two address fields index — the third thing
    /// [`PROTOCOL_VERSION`] covers, after the record layout and the telemetry
    /// block. Literals, like every pin here, and for the same reason.
    ///
    /// This one holds a shape no byte belongs to, which is why it is easy to
    /// leave unheld. Changing either number moves nothing in the record and
    /// breaks no other test: `arg_a` is a byte at 8 tracks and at 12. What it
    /// changes is which addresses mean anything on the far side, and since an
    /// index past the end of the grid is dropped — correctly, that is the
    /// guard — a page built for twelve tracks against an engine holding eight
    /// gets four tracks that take commands and do nothing.
    ///
    /// A failure here is an ABI change: update `protocol.ts` alongside and bump
    /// [`PROTOCOL_VERSION`]. Between the languages nothing else can catch it —
    /// two literals in two languages each agree with their own side — and the
    /// version is what turns the divergence into a refusal to start.
    #[test]
    fn grid_dimensions_are_pinned() {
        assert_eq!(TRACKS, 8);
        assert_eq!(STEPS, 16);
    }

    #[test]
    fn the_grid_fits_the_fields_that_address_it() {
        // The only statement anywhere tying "a field this wide" to "a grid this
        // big", and the two are set in different files by different reasoning.
        // Neither wrap is loud: Rust would take a `track` of 300 as 44 through
        // the `u8`, and `writeCommand` would put it there in the first place,
        // `setUint8` being a modulo. Growing the grid past a field is a change
        // to the record, not to the grid alone.
        assert!(TRACKS <= usize::from(u8::MAX) + 1, "arg_a cannot address {TRACKS} tracks");
        assert!(STEPS <= usize::from(u16::MAX) + 1, "arg_b cannot address {STEPS} steps");
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
    fn a_flag_is_total_over_every_bit_pattern_the_wire_can_carry() {
        // The table above carries `true` and nothing else, so both halves of the
        // switch are asserted here — starting with the one that shares its
        // encoding with an empty field.
        for enabled in [true, false] {
            let record = Record::immediate(Command::SetMetronome { enabled });
            assert_eq!(round_trip(record), Some(record), "the switch did not survive");
        }

        // And every other pattern the field can hold, because the far side is
        // another thread rather than the encoder above. There is no refusal to
        // make here: a switch has both of its states available for any input,
        // which is exactly what makes NaN's answer a decision worth writing
        // down rather than an accident.
        let flagged = |value: f32| {
            let mut bytes = Record::immediate(Command::SetMetronome { enabled: true }).encode();
            bytes[4..8].copy_from_slice(&value.to_le_bytes());
            Record::decode(&bytes).map(|record| record.command)
        };
        for value in [1.0, -1.0, f32::NAN, f32::INFINITY, 1e-40] {
            assert_eq!(flagged(value), Some(Command::SetMetronome { enabled: true }), "{value}");
        }
        for value in [0.0, -0.0] {
            assert_eq!(flagged(value), Some(Command::SetMetronome { enabled: false }), "{value}");
        }
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
