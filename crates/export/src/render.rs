use std::fmt;
use std::num::NonZeroUsize;

use escapement_core::{Engine, Frames, Samples, MAX_SOURCE_CHANNELS};
use escapement_time::SampleRate;

use crate::wav::{self, EncodeError};

/// Fills `into` by driving `engine` in blocks of `block` samples.
///
/// The last block is whatever is left, which is why the length of `into` needs
/// no relation to `block`.
///
/// The engine arrives already set up — started, and with its gain where the
/// caller wants it. Commands are the worklet's business and there is no ring on
/// this side, so what this can render is a state rather than a session.
pub fn render<S: Samples>(
    engine: &mut Engine,
    source: Option<&S>,
    block: NonZeroUsize,
    into: &mut [f32],
) {
    for chunk in into.chunks_mut(block.get()) {
        engine.process(source, chunk);
    }
}

/// What the engine has to be told before it renders.
///
/// Arguments rather than a read of the engine that is playing: that one lives
/// in the worklet's memory, which this side cannot reach into (ARCHITECTURE.md
/// §3). Until the document exists, the page is what knows both.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Samples a second to render at.
    pub rate_hz: f64,
    /// Master gain, linear.
    pub gain: f32,
    /// The oscillator's pitch, which is what a render with no source hears.
    pub frequency_hz: f32,
    /// Whether the transport is running. A stopped engine renders silence and
    /// so does this: the file is what would have been heard, including when
    /// that is nothing.
    pub playing: bool,
}

/// What the offline render asks the engine for at a time.
///
/// Nothing here is due in 2.7 ms, so this is only about how often the loop goes
/// round; the samples it produces are the same at any length, and two tests in
/// `escapement-worklet` are what say so.
const BLOCK: NonZeroUsize = NonZeroUsize::new(4096).expect("a block length");

/// Renders what the engine would play, outside real time, and hands back a
/// `.wav`.
///
/// `source` is interleaved frames of `channels` channels, and one holding no
/// whole frame means the oscillator — the same choice [`Engine::process`]
/// takes, arriving as data rather than as a second entry point.
///
/// One channel out, because the engine has one: a source's channels are
/// averaged and the oscillator is mono. The mixer is what gives this a second.
///
/// # Errors
///
/// [`ExportError`], for material the engine would have refused or a render
/// longer than a `.wav` can measure.
pub fn render_to_wav(
    settings: &Settings,
    source: &[f32],
    channels: usize,
    samples: usize,
) -> Result<Vec<u8>, ExportError> {
    let rate = SampleRate::new(settings.rate_hz).ok_or(ExportError::Rate {
        hz: settings.rate_hz,
    })?;

    // The budget the worklet turns a publication away over, applied on this
    // side too: what the engine refused to play must not come out of a file
    // offered as what was heard.
    if channels > MAX_SOURCE_CHANNELS {
        return Err(ExportError::SourceChannels { channels });
    }

    let mut engine = Engine::new(rate);
    engine.set_gain(settings.gain);
    engine.set_frequency(settings.frequency_hz);
    if settings.playing {
        engine.start();
    }

    // Asked of the source rather than of the two numbers behind it: no
    // channels and no samples are the same answer, and the engine's own choice
    // is between frames and none.
    let held = Frames::new(source, channels);
    let playing = (held.frames() > 0).then_some(&held);

    let mut rendered = vec![0.0f32; samples];
    render(&mut engine, playing, BLOCK, &mut rendered);

    Ok(wav::encode(&rendered, 1, rate)?)
}

/// Why what was asked for did not become a file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExportError {
    /// The rate arrives from a host that is not this program, so refusing one
    /// that is not a rate has to happen before anything divides by it.
    Rate {
        /// What was asked for.
        hz: f64,
    },
    /// More channels than the engine will average in a quantum, which is what
    /// the online path refuses a publication over.
    SourceChannels {
        /// What was asked for.
        channels: usize,
    },
    /// The samples came out; the file around them did not.
    Encode(EncodeError),
}

impl From<EncodeError> for ExportError {
    fn from(error: EncodeError) -> Self {
        Self::Encode(error)
    }
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rate { hz } => write!(f, "{hz} is not a sample rate"),
            Self::SourceChannels { channels } => write!(
                f,
                "{channels} channels is past the {MAX_SOURCE_CHANNELS} a quantum affords"
            ),
            Self::Encode(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ExportError {}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTHING: Option<&Frames<'static>> = None;

    fn rate() -> SampleRate {
        SampleRate::new(48_000.0).expect("the tests chose a rate")
    }

    fn block(of: usize) -> NonZeroUsize {
        NonZeroUsize::new(of).expect("a block length")
    }

    fn playing() -> Engine {
        let mut engine = Engine::new(rate());
        engine.set_gain(1.0);
        engine.start();
        engine
    }

    /// A length the block does not divide, so the last block is short and the
    /// tail is rendered rather than left holding what the buffer came with.
    #[test]
    fn a_length_the_block_does_not_divide_is_filled_to_its_end() {
        let mut into = [-1.0f32; 300];
        render(&mut playing(), NOTHING, block(128), &mut into);

        assert_eq!(into.iter().filter(|s| **s == -1.0).count(), 0);
    }

    /// The clock counts the samples asked for and not the blocks they arrived
    /// in, which is the difference the state block carries as `clock` against
    /// `quanta`.
    #[test]
    fn the_clock_moves_by_the_whole_length() {
        let mut engine = playing();
        let mut into = [0.0f32; 300];
        render(&mut engine, NOTHING, block(128), &mut into);

        assert_eq!(engine.clock(), 300);
    }

    /// The property the offline render stands on, at the smallest scale it can
    /// be asked at: one sample at a time against all of it at once.
    ///
    /// The wider version — against the worklet's own 128-sample quanta — is in
    /// `escapement-worklet`, where the online path is.
    #[test]
    fn the_block_length_does_not_reach_the_samples() {
        let mut whole = [0.0f32; 500];
        render(&mut playing(), NOTHING, block(500), &mut whole);

        for length in [1, 7, 128, 499] {
            let mut split = [0.0f32; 500];
            render(&mut playing(), NOTHING, block(length), &mut split);
            assert_eq!(whole, split, "blocks of {length}");
        }
    }

    /// A source is played through rather than restarted at every block, which
    /// is what a player rewound per block would look like.
    #[test]
    fn a_source_carries_across_the_blocks_it_is_rendered_in() {
        let held = [0.1, 0.2, 0.3, 0.4];
        let source = Frames::new(&held, 1);

        let mut into = [0.0f32; 4];
        render(&mut playing(), Some(&source), block(2), &mut into);

        assert_eq!(into, [0.1, 0.2, 0.3, 0.4]);
    }

    /// Rendering past the end of a source is silence, not the last frame held.
    #[test]
    fn a_render_longer_than_its_source_ends_in_silence() {
        let held = [0.5, 0.5];
        let source = Frames::new(&held, 1);

        let mut into = [1.0f32; 6];
        render(&mut playing(), Some(&source), block(4), &mut into);

        assert_eq!(into, [0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
    }

    /// A buffer of nothing is a render of nothing, rather than one block of
    /// whatever `chunks_mut` would have made of it.
    #[test]
    fn an_empty_buffer_renders_nothing() {
        let mut engine = playing();
        render(&mut engine, NOTHING, block(128), &mut []);

        assert_eq!(engine.clock(), 0);
    }

    /// A page with nothing touched, which the tests below vary one field of.
    fn settings() -> Settings {
        Settings {
            rate_hz: 48_000.0,
            gain: 1.0,
            frequency_hz: 440.0,
            playing: true,
        }
    }

    /// The samples out of a file, past the header the encoder put in front of
    /// them. Through [`wav::HEADER_BYTES`] rather than the number it is, so
    /// that a chunk added to the header moves this too.
    fn samples(file: &[u8]) -> Vec<f32> {
        let (words, rest) = file[wav::HEADER_BYTES..].as_chunks::<4>();
        assert!(rest.is_empty(), "a file of whole samples");

        words.iter().copied().map(f32::from_le_bytes).collect()
    }

    /// An empty source is the oscillator, which is the branch this entry point
    /// takes that its arguments do not spell.
    #[test]
    fn an_empty_source_renders_the_oscillator() {
        let file = render_to_wav(&settings(), &[], 0, 64).expect("a rate and a length");

        assert_eq!(&file[..4], b"RIFF");
        assert_eq!(file.len(), wav::HEADER_BYTES + 64 * 4);
        assert!(
            samples(&file).iter().any(|sample| *sample != 0.0),
            "the oscillator was silent"
        );
    }

    /// And a source is the source, at the gain asked for rather than the
    /// engine's default.
    #[test]
    fn a_source_is_rendered_instead_of_it() {
        let file = render_to_wav(&settings(), &[0.5; 4], 1, 4).expect("a source of four frames");

        assert_eq!(samples(&file), [0.5; 4]);
    }

    /// A stopped transport renders the silence it is playing. The button this
    /// is behind is offered for checking a file against what is audible, so the
    /// two have to be able to agree about hearing nothing.
    #[test]
    fn a_stopped_transport_renders_the_silence_it_is_playing() {
        let stopped = Settings {
            playing: false,
            ..settings()
        };
        let file = render_to_wav(&stopped, &[0.5; 4], 1, 4).expect("a stopped engine renders too");

        assert_eq!(samples(&file), [0.0; 4]);
    }

    /// The rate arrives from a host that is not this program, so it is refused
    /// here rather than reaching arithmetic with nowhere to report it.
    #[test]
    fn a_rate_that_is_not_one_is_refused() {
        let refused = Settings {
            rate_hz: 0.0,
            ..settings()
        };

        assert_eq!(
            render_to_wav(&refused, &[], 0, 4).err(),
            Some(ExportError::Rate { hz: 0.0 })
        );
    }

    /// The online path turns away a publication of more channels than a quantum
    /// can average. A file offered as what was heard has to turn away the same
    /// material, rather than render what nothing played.
    #[test]
    fn a_source_of_more_channels_than_a_quantum_affords_is_refused() {
        let past = MAX_SOURCE_CHANNELS + 1;
        let source = vec![0.5f32; past];

        assert_eq!(
            render_to_wav(&settings(), &source, past, 4).err(),
            Some(ExportError::SourceChannels { channels: past })
        );
        assert!(
            render_to_wav(
                &settings(),
                &source[..MAX_SOURCE_CHANNELS],
                MAX_SOURCE_CHANNELS,
                4
            )
            .is_ok(),
            "exactly the budget"
        );
    }

    #[test]
    fn every_export_error_says_what_went_wrong() {
        for error in [
            ExportError::Rate { hz: 0.0 },
            ExportError::SourceChannels { channels: 65 },
            ExportError::Encode(EncodeError::Channels { channels: 0 }),
        ] {
            assert!(format!("{error}").len() > 20, "{error:?} says nothing");
        }
    }
}
