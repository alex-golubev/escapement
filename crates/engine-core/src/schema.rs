//! Generated from `schema/engine.fbs` by `pnpm gen`.

#[allow(clippy::all)]
mod engine_generated;
mod fingerprint;

pub use engine_generated::*;
pub use fingerprint::SCHEMA_FINGERPRINT;

#[cfg(test)]
mod tests {
    use std::ops::ControlFlow;

    use crate::commands::{Command, CommandInput};

    /// Written by the TypeScript test.
    const FIXTURE: &str = include_str!("../../../schema/fixtures/commands.hex");

    fn fixture_bytes() -> Vec<u8> {
        let hex: String = FIXTURE
            .lines()
            .filter(|line| !line.starts_with('#'))
            .flat_map(str::split_whitespace)
            .collect();
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn reads_commands_written_by_typescript() {
        let mut input = CommandInput::default();
        input.write(&fixture_bytes());
        let mut read = Vec::new();
        input.drain(|command| {
            read.push(match command.unwrap() {
                Command::SetParam(set) => {
                    format!("SetParam {} {} {}", set.node(), set.param(), set.value())
                }
                Command::AfterBatch(marker) => format!("AfterBatch {}", marker.batch()),
                Command::NoteOn(note) => format!(
                    "NoteOn {} {} {} {}",
                    note.node(),
                    note.key(),
                    note.velocity(),
                    note.note()
                ),
                Command::SetTempo(tempo) => format!("SetTempo {}", tempo.bpm()),
                Command::SetTransport(state) => format!(
                    "SetTransport {} {} {} {}",
                    state.playing(),
                    state.loop_ticks(),
                    state.place().press(),
                    state.place().tick()
                ),
                Command::PanicAudio(panic) => format!("PanicAudio {}", panic.code()),
                Command::HangAudio(hang) => format!("HangAudio {}", hang.code()),
                Command::NoteOff(note) => format!("NoteOff {} {}", note.node(), note.note()),
                Command::SetStripParam(set) => {
                    format!(
                        "SetStripParam {} {} {}",
                        set.node(),
                        set.param(),
                        set.value()
                    )
                }
            });
            ControlFlow::Continue(())
        });
        // The page's tone is node 1.
        let tone = format!("SetParam 1 {} 0.25", engine_plugins::catalog::tone::VOLUME);
        assert_eq!(
            read,
            [
                "SetParam 1 2 0.5",
                &tone,
                "AfterBatch 7",
                "NoteOn 1 60 0.75 7",
                "SetTempo 128.5",
                "SetTransport true 3840 0 0",
                "SetTransport false 4294967295 4294967295 1920",
                "PanicAudio 7",
                "HangAudio 8",
                "NoteOff 1 7",
                "SetStripParam 1 2 -0.5"
            ]
        );
        assert!(input.is_empty());
    }
}
