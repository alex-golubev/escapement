use std::fmt;
use std::num::NonZeroUsize;

use escapement_core::{Engine, Frames, Samples, Stage, MAX_SOURCE_CHANNELS};
use escapement_model::playback::{Playback, Strip};
use escapement_time::{Position, SampleRate};

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
    left: &mut [f32],
    right: &mut [f32],
) {
    let mut left = left.chunks_mut(block.get());
    let mut right = right.chunks_mut(block.get());

    while let (Some(left), Some(right)) = (left.next(), right.next()) {
        engine.process(source, left, right);
    }
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
/// **Built from the same projection the engine is playing** (`playback`), not
/// from what the interface last sent and not from the state block: a control is
/// an input, the document is the answer, and a wrapper here taking one as an
/// argument is how a file comes out different from what was heard
/// (`.claude/rules/interface.md`, D22).
///
/// `source` is interleaved frames of `channels` channels, and one holding no
/// whole frame is silence — the same choice [`Engine::process`] takes, arriving
/// as data rather than as a second entry point.
///
/// Two channels out, because the engine has two. `rate_hz` is the one number
/// the document does not hold: the online path takes it from the host, and this
/// one renders at whatever it is given (§2.5).
///
/// # Errors
///
/// [`ExportError`], for material the engine would have refused or a render
/// longer than a `.wav` can measure.
pub fn render_to_wav(
    playback: &Playback,
    source: &[f32],
    channels: usize,
    rate_hz: f64,
    samples: usize,
) -> Result<Vec<u8>, ExportError> {
    let rate = SampleRate::new(rate_hz).ok_or(ExportError::Rate { hz: rate_hz })?;

    // The budget the worklet turns a publication away over, applied on this
    // side too: what the engine refused to play must not come out of a file
    // offered as what was heard.
    if channels > MAX_SOURCE_CHANNELS {
        return Err(ExportError::SourceChannels { channels });
    }

    let mut engine = Engine::new(rate);
    drive(&mut engine, playback);
    // From the origin, because a file is the project rather than what was on
    // screen: where the transport happened to be is the person's, not the
    // document's (§2.4).
    engine.start(Position::ZERO);

    // Asked of the source rather than of the two numbers behind it: no
    // channels and no samples are the same answer, and the engine's own choice
    // is between frames and none.
    let held = Frames::new(source, channels);
    let playing = (held.frames() > 0).then_some(&held);

    let mut left = vec![0.0f32; samples];
    let mut right = vec![0.0f32; samples];
    render(&mut engine, playing, BLOCK, &mut left, &mut right);

    let mut interleaved = vec![0.0f32; samples * 2];
    for (frame, (left, right)) in left.iter().zip(right.iter()).enumerate() {
        interleaved[frame * 2] = *left;
        interleaved[frame * 2 + 1] = *right;
    }

    Ok(wav::encode(&interleaved, 2, rate)?)
}

/// Tells `engine` what the document says, in the order the online path would.
///
/// Every value here crossed `mixer::Gain`, `mixer::Pan` or `timeline::Tempo` on
/// its way out of the document, so there is nothing the engine can refuse —
/// which is what makes a file built from the projection the same as the one
/// built from the ring (D24).
fn drive(engine: &mut Engine, playback: &Playback) {
    let tempo = playback.tempo();
    engine.set_tempo(tempo.beats_per_minute(), tempo.curve());

    let Some(audible) = playback.clip() else {
        return;
    };
    engine.place_clip(audible.start(), audible.length(), audible.trim().count());

    set(engine, Stage::Channel, audible.channel());
    set(engine, Stage::Insert, audible.insert());
    if let Some(master) = audible.master() {
        set(engine, Stage::Master, master);
    }
}

fn set(engine: &mut Engine, stage: Stage, strip: Strip) {
    let held = engine.strip(stage);
    held.set_gain(strip.gain().amplitude());
    held.set_pan(strip.pan().position());
    held.set_mute(strip.mute());
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
    use escapement_model::asset::Frames as AssetFrames;
    use escapement_model::mixer::{Channel, ChannelSource, Gain, Insert, Pan};
    use escapement_model::playlist::{Clip, ClipSource, Lane};
    use escapement_model::project::Parts;
    use escapement_model::timeline::{Tempo, Timeline};
    use escapement_model::{Asset, AssetHash, Entropy, Id, Project};
    use escapement_time::meter::Meter;
    use escapement_time::tempo::Curve;
    use escapement_time::{Position, Span};

    const NOTHING: Option<&Frames<'static>> = None;
    const RATE_HZ: f64 = 48_000.0;
    const SAMPLE: AssetHash = AssetHash::from_bytes([5; 32]);

    /// Names a test can write down, the way the model's own fixtures do.
    struct Counter(u128);

    impl Entropy for Counter {
        fn next_u128(&mut self) -> u128 {
            self.0 += 1;
            self.0
        }
    }

    fn rate() -> SampleRate {
        SampleRate::new(RATE_HZ).expect("the tests chose a rate")
    }

    fn block(of: usize) -> NonZeroUsize {
        NonZeroUsize::new(of).expect("a block length")
    }

    /// One clip on one channel into the master, at a tempo that makes a quarter
    /// half a second.
    fn document() -> Playback {
        let mut entropy = Counter(0);
        let master = Id::mint(&mut entropy);
        let kick: Id<Channel> = Id::mint(&mut entropy);
        let lane: Id<Lane> = Id::mint(&mut entropy);
        let clip = Id::mint(&mut entropy);

        let mut parts = Parts::new("Song".to_owned(), master);
        parts.timeline = Timeline::new(
            Tempo::new(120.0, Curve::Hold).expect("a tempo is a tempo"),
            Meter::new(4, 4).expect("four four is a signature"),
        );
        parts.inserts.push((
            master,
            Insert::new("Master".to_owned(), Gain::UNITY, Pan::CENTRE, false),
        ));
        parts.channels.push((
            kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                master,
                Gain::UNITY,
                Pan::CENTRE,
                false,
            ),
        ));
        parts.lanes.push((lane, Lane::new("Drums".to_owned())));
        parts.clips.insert(
            clip,
            Clip::new(
                lane,
                Position::ZERO,
                Span::quarters(8),
                ClipSource::Audio {
                    channel: kick,
                    trim: AssetFrames::ZERO,
                },
            ),
        );
        parts.assets.insert(
            SAMPLE,
            Asset::new("kick.wav".to_owned(), AssetFrames::new(4_800), rate(), 1)
                .expect("mono is audio"),
        );

        Playback::of(&Project::new(parts), clip)
    }

    /// Which strip of [`document`] is silenced.
    #[derive(Clone, Copy, Debug)]
    enum Muted {
        Channel,
        Master,
    }

    /// The same project with one strip muted, so that a route applied only in
    /// part still shows up as sound.
    fn muted_document(muted: Muted) -> Playback {
        let mut entropy = Counter(0);
        let master = Id::mint(&mut entropy);
        let kick: Id<Channel> = Id::mint(&mut entropy);
        let lane: Id<Lane> = Id::mint(&mut entropy);
        let clip = Id::mint(&mut entropy);

        let mut parts = Parts::new("Song".to_owned(), master);
        parts.timeline = Timeline::new(
            Tempo::new(120.0, Curve::Hold).expect("a tempo is a tempo"),
            Meter::new(4, 4).expect("four four is a signature"),
        );
        parts.inserts.push((
            master,
            Insert::new(
                "Master".to_owned(),
                Gain::UNITY,
                Pan::CENTRE,
                matches!(muted, Muted::Master),
            ),
        ));
        parts.channels.push((
            kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                master,
                Gain::UNITY,
                Pan::CENTRE,
                matches!(muted, Muted::Channel),
            ),
        ));
        parts.lanes.push((lane, Lane::new("Drums".to_owned())));
        parts.clips.insert(
            clip,
            Clip::new(
                lane,
                Position::ZERO,
                Span::quarters(8),
                ClipSource::Audio {
                    channel: kick,
                    trim: AssetFrames::ZERO,
                },
            ),
        );
        parts.assets.insert(
            SAMPLE,
            Asset::new("kick.wav".to_owned(), AssetFrames::new(4_800), rate(), 1)
                .expect("mono is audio"),
        );

        Playback::of(&Project::new(parts), clip)
    }

    /// An engine set up the way `render_to_wav` sets one up, for the tests that
    /// are about `render` rather than about the file.
    fn playing() -> Engine {
        let mut engine = Engine::new(rate());
        drive(&mut engine, &document());
        engine.start(Position::ZERO);
        engine
    }

    fn peak(block: &[f32]) -> f32 {
        block
            .iter()
            .fold(0.0f32, |top, sample| top.max(sample.abs()))
    }

    /// A length the block does not divide, so the last block is short and the
    /// tail is rendered rather than left holding what the buffer came with.
    #[test]
    fn a_length_the_block_does_not_divide_is_filled_to_its_end() {
        let mut left = [-1.0f32; 300];
        let mut right = [-1.0f32; 300];
        render(&mut playing(), NOTHING, block(128), &mut left, &mut right);

        assert_eq!(left.iter().filter(|s| **s == -1.0).count(), 0);
        assert_eq!(right.iter().filter(|s| **s == -1.0).count(), 0);
    }

    /// The clock counts the samples asked for and not the blocks they arrived
    /// in, which is the difference the state block carries as `clock` against
    /// `quanta`.
    #[test]
    fn the_clock_moves_by_the_whole_length() {
        let mut engine = playing();
        let mut left = [0.0f32; 300];
        let mut right = [0.0f32; 300];
        render(&mut engine, NOTHING, block(128), &mut left, &mut right);

        assert_eq!(engine.clock(), 300);
    }

    /// The property the offline render stands on, at the smallest scale it can
    /// be asked at: one sample at a time against all of it at once. This is
    /// what a ramp written per block rather than per sample fails.
    ///
    /// The wider version — against the worklet's own 128-sample quanta — is in
    /// `escapement-worklet`, where the online path is.
    #[test]
    fn the_block_length_does_not_reach_the_samples() {
        let held: Vec<f32> = (0..500).map(|n| (n % 97) as f32 / 97.0 + 0.01).collect();
        let source = Frames::new(&held, 1);

        let mut whole = [0.0f32; 500];
        let mut whole_right = [0.0f32; 500];
        render(
            &mut playing(),
            Some(&source),
            block(500),
            &mut whole,
            &mut whole_right,
        );
        assert!(peak(&whole) > 0.0, "the render was silent");

        for length in [1, 7, 128, 499] {
            let mut split = [0.0f32; 500];
            let mut split_right = [0.0f32; 500];
            render(
                &mut playing(),
                Some(&source),
                block(length),
                &mut split,
                &mut split_right,
            );

            assert_eq!(whole, split, "left, blocks of {length}");
            assert_eq!(whole_right, split_right, "right, blocks of {length}");
        }
    }

    /// Rendering past the end of a source is silence, not the last frame held.
    #[test]
    fn a_render_longer_than_its_source_ends_in_silence() {
        let held = [0.5, 0.5];
        let source = Frames::new(&held, 1);

        let mut left = [1.0f32; 600];
        let mut right = [1.0f32; 600];
        render(
            &mut playing(),
            Some(&source),
            block(4),
            &mut left,
            &mut right,
        );

        assert_eq!(left[599], 0.0);
        assert_eq!(right[599], 0.0);
    }

    /// A buffer of nothing is a render of nothing, rather than one block of
    /// whatever `chunks_mut` would have made of it.
    #[test]
    fn an_empty_buffer_renders_nothing() {
        let mut engine = playing();
        render(&mut engine, NOTHING, block(128), &mut [], &mut []);

        assert_eq!(engine.clock(), 0);
    }

    /// The samples out of a file, past the header the encoder put in front of
    /// them. Through [`wav::HEADER_BYTES`] rather than the number it is, so
    /// that a chunk added to the header moves this too.
    fn samples(file: &[u8]) -> Vec<f32> {
        let (words, rest) = file[wav::HEADER_BYTES..].as_chunks::<4>();
        assert!(rest.is_empty(), "a file of whole samples");

        words.iter().copied().map(f32::from_le_bytes).collect()
    }

    /// Two channels out of an engine that has two, interleaved the way a `.wav`
    /// holds them.
    #[test]
    fn a_file_holds_a_frame_of_two_channels_for_every_sample_rendered() {
        let held: Vec<f32> = (0..256).map(|n| (n % 61) as f32 / 61.0 + 0.01).collect();
        let file = render_to_wav(&document(), &held, 1, RATE_HZ, 64).expect("a rate and a length");

        assert_eq!(samples(&file).len(), 128, "64 frames of two channels");
    }

    /// A centred clip is the same on both sides, and that is the frame order
    /// being right rather than the two channels being swapped.
    #[test]
    fn the_two_channels_of_a_centred_clip_are_the_same() {
        let held: Vec<f32> = (0..256).map(|n| (n % 61) as f32 / 61.0 + 0.01).collect();
        let file = render_to_wav(&document(), &held, 1, RATE_HZ, 64).expect("a rate and a length");
        let out = samples(&file);

        for frame in 0..64 {
            assert_eq!(out[frame * 2], out[frame * 2 + 1], "frame {frame}");
        }
    }

    /// Every strip on the route reaches the file, which is what says the
    /// document was applied rather than the engine left at unity.
    #[test]
    fn a_strip_the_document_muted_is_silent_in_the_file() {
        let held: Vec<f32> = (0..256).map(|n| (n % 61) as f32 / 61.0 + 0.01).collect();
        let heard = render_to_wav(&document(), &held, 1, RATE_HZ, 64).expect("a length");
        assert!(peak(&samples(&heard)) > 0.0);

        for muted in [Muted::Channel, Muted::Master] {
            let file =
                render_to_wav(&muted_document(muted), &held, 1, RATE_HZ, 64).expect("a length");
            assert_eq!(peak(&samples(&file)), 0.0, "{muted:?} was audible");
        }
    }

    /// A project with nothing on the timeline renders the silence it is, rather
    /// than refusing.
    #[test]
    fn a_document_with_no_clip_renders_silence() {
        let mut entropy = Counter(0);
        let master = Id::mint(&mut entropy);
        let parts = Parts::new("Empty".to_owned(), master);
        let project = Project::new(parts);
        let playback = Playback::of(&project, Id::from_bits(u128::MAX));

        let file = render_to_wav(&playback, &[], 0, RATE_HZ, 32).expect("a rate and a length");
        assert_eq!(peak(&samples(&file)), 0.0);
    }

    #[test]
    fn a_rate_that_is_not_one_is_refused_before_anything_divides_by_it() {
        assert_eq!(
            render_to_wav(&document(), &[], 0, 0.0, 32),
            Err(ExportError::Rate { hz: 0.0 })
        );
        assert!(matches!(
            render_to_wav(&document(), &[], 0, f64::NAN, 32),
            Err(ExportError::Rate { .. })
        ));
    }

    /// The budget the worklet turns a publication away over, applied here too:
    /// what the engine refused to play must not come out of a file offered as
    /// what was heard.
    #[test]
    fn more_channels_than_a_quantum_affords_are_refused() {
        let channels = MAX_SOURCE_CHANNELS + 1;
        let held = vec![0.0f32; channels];

        assert_eq!(
            render_to_wav(&document(), &held, channels, RATE_HZ, 32),
            Err(ExportError::SourceChannels { channels })
        );
    }

    /// The rate is the render's and not the document's: the same project at
    /// another rate is the same music over more samples.
    #[test]
    fn a_render_at_another_rate_is_the_same_music() {
        let held: Vec<f32> = (0..96_000).map(|n| (n % 89) as f32 / 89.0 + 0.01).collect();

        let fast = render_to_wav(&document(), &held, 1, RATE_HZ, 48_000).expect("a length");
        let slow = render_to_wav(&document(), &held, 1, RATE_HZ / 2.0, 24_000).expect("a length");

        assert!(peak(&samples(&fast)) > 0.0);
        assert!(peak(&samples(&slow)) > 0.0);
    }

    #[test]
    fn an_error_says_what_it_was_asked_for() {
        let rate = ExportError::Rate { hz: -1.0 };
        let channels = ExportError::SourceChannels { channels: 99 };

        assert!(format!("{rate}").contains("-1"));
        assert!(format!("{channels}").contains("99"));
        let wrapped = ExportError::Encode(EncodeError::Channels { channels: 0 });
        assert_eq!(
            format!("{wrapped}"),
            format!("{}", EncodeError::Channels { channels: 0 }),
            "the encoder's words were replaced rather than carried"
        );
    }
}
