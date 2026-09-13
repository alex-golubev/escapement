//! Leptos client — and not yet. What is here is slice 1's page: the interface
//! side of the shared region, exported so that buttons in `web/index.html` can
//! reach it.
//!
//! The buttons stay in the markup rather than being drawn from here. §4 forbids
//! writing the protocol twice, not writing a `<button>`, and drawing one from
//! Rust needs `web-sys` — a decision this page has no business making. Leptos
//! arrives when there is a panel worth testing it on (§4).
//!
//! Everything below is delegation, and deliberately: a `static` exists once per
//! process, so behaviour left here is behaviour a test reaches once and never
//! again. `escapement-view` holds it instead — the same argument the worklet's
//! `lib.rs` carries.

use std::cell::RefCell;

use escapement_export::render_to_wav;
use escapement_model::asset::Frames as AssetFrames;
use escapement_model::document;
use escapement_model::mixer::{Channel, ChannelSource, Gain, Pan};
use escapement_model::playback::Playback;
use escapement_model::playlist::{Clip, ClipSource, Lane};
use escapement_model::project::Parts;
use escapement_model::timeline::Tempo;
use escapement_model::{Asset, AssetHash, Entropy, Id, Project};
use escapement_time::tempo::Curve;
use escapement_time::{Position, SampleRate, Span, TICKS_PER_QUARTER};
use escapement_view::{Command, CommandKind, Link, Stage};
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(text: &str);

    /// The browser's own generator, filling an array of the host's.
    ///
    /// **Not a view into this module's memory.** It is shared, and
    /// `getRandomValues` refuses a buffer backed by a `SharedArrayBuffer` — so
    /// the bytes are drawn over there and copied across.
    ///
    /// Bound without `catch`, which is a claim and not an oversight: the
    /// isolation headers that make the memory shared at all are what make this
    /// a secure context, and `crypto` is there in every context that can load
    /// this module.
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
    fn fill_with_random(array: &Uint8Array);
}

/// Where the name of a new entity comes from.
///
/// A unit struct rather than a handle: there is nothing to keep between calls,
/// and two of these are two draws from the same generator rather than two
/// sequences that could line up — which is what a counter here got wrong.
struct Random;

impl Entropy for Random {
    fn next_u128(&mut self) -> u128 {
        let array = Uint8Array::new_with_length(16);
        fill_with_random(&array);
        let mut bytes = [0; 16];
        array.copy_to(&mut bytes);
        u128::from_be_bytes(bytes)
    }
}

thread_local! {
    /// The interface's end of the region, and the queue in front of it.
    ///
    /// A `thread_local!` rather than a `static`: the exports below are reached
    /// from one thread, and this is the shape that says so without `unsafe`.
    static LINK: RefCell<Link> = RefCell::new(Link::new());

    /// What the project says, which is the only thing the engine is ever told.
    ///
    /// **The whole of it is in the CRDT.** The entities have no setters by
    /// design (`model.md`), so what edits them is
    /// `escapement_model::document`, and `Project::new` is how what it holds
    /// becomes something the projection can read.
    static DOCUMENT: RefCell<Document> = RefCell::new(Document::new());
}

/// Slice 1's project: one clip, one channel, one master.
///
/// What sits beside the document now is which of the entities this page is
/// working on, and that is not project state: a selection is per-user and
/// stays out of the document (`model.md`). Both are absent until a file
/// arrives, because slice 1's page has nothing to name before that.
struct Document {
    project: document::Document,
    /// The channel the file is heard through, made when the first one arrives.
    /// A channel with no source is not one, so there is none before that.
    channel: Option<Id<Channel>>,
    /// The lane and the clip on it, made with the channel and for the same
    /// reason: a clip is a thing that plays, and until there is a file there is
    /// nothing for one to play.
    clip: Option<Id<Clip>>,
}

impl Document {
    fn new() -> Self {
        Self {
            project: document::Document::create("Slice one", Random),
            channel: None,
            clip: None,
        }
    }

    /// The document as it stands, and what the audio thread is to play of it.
    ///
    /// Both halves of slice 1 read this one value — the ring is told what it
    /// says, and the file is rendered from it — which is what keeps the two
    /// from drifting (D24).
    fn playback(&self) -> Playback {
        // Before there is a clip, a name nothing answers to — which the
        // projection reads as the absence it is (D12), the same way it reads a
        // clip whose channel has gone.
        let clip = self.clip.unwrap_or(Id::from_bits(0));
        Playback::of(&Project::new(self.parts()), clip)
    }

    fn parts(&self) -> Parts {
        let mut parts = Parts::new(self.project.name(), self.project.master());
        parts.timeline = self.project.timeline();
        parts.inserts = self.project.inserts();
        parts.channels = self.project.channels();
        parts.lanes = self.project.lanes();
        parts.clips = self.project.clips();
        parts.assets = self.project.assets();
        parts
    }

    /// Bytes arrived under a name, and a description of them if the page could
    /// make one.
    ///
    /// The channel is made the first time and pointed at the new bytes
    /// afterwards, which is what loading a second file into one strip is. Both
    /// happen whether or not the description did: the bytes in the region have
    /// already been replaced by the time this is called, so a channel left
    /// naming the last file would play the new ones under the old one's name.
    /// Pointed at a file the document has no description of, it is silent —
    /// which is a dangling name reading as an absence (D12) rather than
    /// anything this page has to arrange.
    ///
    /// The clip is made here rather than when a control first moves, so that
    /// what the document holds is always something that plays. The numbers it
    /// starts at are the page's own, and the page sends the controls' own again
    /// as soon as this returns.
    fn use_source(&mut self, hash: AssetHash, described: Option<&Asset>) {
        if let Some(asset) = described {
            self.project.add_asset(hash, asset);
        }
        let source = ChannelSource::Sampler(hash);
        let channel = match self.channel {
            Some(name) => {
                self.project.set_channel_source(name, source);
                name
            }
            None => {
                let master = self.project.master();
                let channel = Channel::new(
                    "Source".to_owned(),
                    source,
                    master,
                    Gain::UNITY,
                    Pan::CENTRE,
                    false,
                );
                let name = self.project.add_channel(&channel);
                self.channel = Some(name);
                name
            }
        };
        if self.clip.is_none() {
            let lane = self.project.add_lane(&Lane::new("Audio".to_owned()));
            self.clip = self.project.add_clip(&Clip::new(
                lane,
                Position::ZERO,
                Span::quarters(4),
                ClipSource::Audio {
                    channel,
                    trim: AssetFrames::ZERO,
                },
            ));
        }
    }

    /// Where the clip sits, how long it sounds, and how far into the file it
    /// begins.
    ///
    /// Nothing before there is a clip: the controls are enabled from the moment
    /// the audio context is, and what they say until a file arrives is what the
    /// page would have shown anyway. It is not lost — the page sends these
    /// again once the file is in, reading the controls as they stand.
    fn place_clip(&self, start: Position, length: Span, trim: AssetFrames) {
        if let Some(name) = self.clip {
            self.project.place_clip(name, start, length, trim);
        }
    }

    /// One strip of the route, from three numbers a control gave.
    ///
    /// A number that is not a value leaves that register standing, as a tempo
    /// that is not one does: the control was wrong, and the last good value is
    /// the one in the document rather than a default invented here (D24).
    ///
    /// The page sends all six numbers whenever one of them moves, and nothing
    /// here filters them — the document does not write a register that already
    /// holds the value, which is where that belongs and where it is tested.
    fn set_strip(&self, stage: u32, amplitude: f32, place: f32, mute: bool) {
        let gain = Gain::new(amplitude);
        let pan = Pan::new(place);
        match stage {
            0 => {
                let Some(name) = self.channel else {
                    return;
                };
                if let Some(gain) = gain {
                    self.project.set_channel_gain(name, gain);
                }
                if let Some(pan) = pan {
                    self.project.set_channel_pan(name, pan);
                }
                self.project.set_channel_mute(name, mute);
            }
            // The insert the channel feeds, which in slice 1's project is the
            // master itself — there is no strip between the two, and the page
            // has two sets of controls rather than three because of it.
            1 => {
                let name = self.project.master();
                if let Some(gain) = gain {
                    self.project.set_insert_gain(name, gain);
                }
                if let Some(pan) = pan {
                    self.project.set_insert_pan(name, pan);
                }
                self.project.set_insert_mute(name, mute);
            }
            _ => {}
        }
    }
}

fn publish_document() {
    let playback = DOCUMENT.with_borrow(Document::playback);
    let tempo = playback.tempo();
    send(CommandKind::SetTempo {
        beats_per_minute: tempo.beats_per_minute(),
        curve: tempo.curve(),
    });

    let Some(audible) = playback.clip() else {
        send(CommandKind::ClearClip);
        return;
    };
    send(CommandKind::PlaceClip {
        start: audible.start(),
        length: audible.length(),
        trim: u32::try_from(audible.trim().count()).unwrap_or(u32::MAX),
    });
    send(strip_command(Stage::Channel, audible.channel()));
    send(strip_command(Stage::Insert, audible.insert()));
    // Unity where the channel feeds the master directly, because the strip the
    // engine holds is whatever it was last told — and the master applied twice
    // would make a half a quarter.
    send(match audible.master() {
        Some(master) => strip_command(Stage::Master, master),
        None => CommandKind::SetStrip {
            stage: Stage::Master,
            gain: 1.0,
            pan: 0.0,
            mute: false,
        },
    });
}

fn strip_command(stage: Stage, strip: escapement_model::playback::Strip) -> CommandKind {
    CommandKind::SetStrip {
        stage,
        gain: strip.gain().amplitude(),
        pan: strip.pan().position(),
        mute: strip.mute(),
    }
}

/// The handshake. `buffer` is the worklet's `memory.buffer` and `region` the
/// offset `escapement_region_ptr` returned — the message `worklet.js` posts
/// once, at startup (§3).
///
/// Whatever the page has queued before this survives it, and so does a refusal.
///
/// # Errors
///
/// If there is no region this build can speak to at that address. The text is
/// meant for a person looking at a page that will not start.
#[wasm_bindgen]
pub fn connect(buffer: &JsValue, region: usize) -> Result<(), JsError> {
    LINK.with_borrow_mut(|link| link.connect(buffer, region))?;
    Ok(())
}

/// Run the transport from the origin of the timeline.
///
/// The position is an argument of the command rather than of this call because
/// slice 1's page has no playhead to start from: where a person put it is
/// theirs and stays out of the document (§2.4), and the panel that holds it
/// arrives with the playlist.
#[wasm_bindgen]
pub fn start() {
    publish_document();
    send(CommandKind::Start { at: Position::ZERO });
}

/// Stop it, leaving the engine's clock running (§3).
#[wasm_bindgen]
pub fn stop() {
    send(CommandKind::Stop);
}

/// The tempo the project opens at, in quarter notes a minute.
#[wasm_bindgen]
pub fn set_tempo(beats_per_minute: f64) {
    DOCUMENT.with_borrow(|document| {
        // A number off a control is not necessarily a tempo, and one that is
        // not leaves the clock where it was rather than resetting it to the
        // default — which is what a page that never reads the document back
        // would show as the number it just sent (D24).
        if let Some(tempo) = Tempo::new(beats_per_minute, Curve::Hold) {
            document.project.set_tempo(tempo);
        }
    });
    publish_document();
}

/// Where the clip sits and how long it sounds, in quarter notes, and how far
/// into the file it begins, in the file's own frames.
///
/// Three counts meet here and none of them may be given to another (§2.5): the
/// first two are musical and become ticks, the third is the file's.
#[wasm_bindgen]
pub fn place_clip(start_quarters: f64, length_quarters: f64, trim_frames: f64) {
    DOCUMENT.with_borrow(|document| {
        document.place_clip(
            Position::from_ticks(ticks(start_quarters)),
            Span::from_ticks(ticks(length_quarters)),
            AssetFrames::new(trim_frames.max(0.0) as u64),
        );
    });
    publish_document();
}

/// One strip of the route: `0` the channel, `1` the insert, `2` the master.
#[wasm_bindgen]
pub fn set_strip(stage: u32, gain: f32, pan: f32, mute: bool) {
    DOCUMENT.with_borrow(|document| document.set_strip(stage, gain, pan, mute));
    publish_document();
}

/// Quarter notes into the ticks a position is counted in, rounded to the
/// nearest — the grid is generous enough that a control's number lands on one
/// (§2.5).
fn ticks(quarters: f64) -> i64 {
    (quarters * TICKS_PER_QUARTER as f64).round() as i64
}

/// Where the audio buffer starts in the worklet's `memory.buffer`, in bytes,
/// and how many bytes it holds. `undefined` before the handshake.
///
/// The page builds a `Float32Array` on those two and writes the frames in
/// itself. That is deliberate and not a shortcut: what publishes them is
/// [`use_audio`], which goes through the ring afterwards, so the copy needs no
/// ordering of its own (ARCHITECTURE.md §3).
#[wasm_bindgen]
#[must_use]
pub fn audio_offset() -> Option<u32> {
    LINK.with_borrow(|link| {
        link.audio_byte_offset()
            .and_then(|at| u32::try_from(at).ok())
    })
}

/// See [`audio_offset`].
#[wasm_bindgen]
#[must_use]
pub fn audio_length() -> Option<u32> {
    LINK.with_borrow(|link| {
        link.audio_byte_length()
            .and_then(|len| u32::try_from(len).ok())
    })
}

/// Tells the engine what the page has just written into that buffer:
/// `frames` frames of `channels` channels, interleaved, `offset` words in.
/// Returns the number given to this publication.
///
/// The frames have to be there first. A descriptor naming more than the buffer
/// holds is refused, and a refusal shows up as [`Telemetry::publication`]
/// staying behind the number returned here — which also says the words the
/// last accepted publication named are still being read.
#[wasm_bindgen]
pub fn use_audio(offset: u32, frames: u32, channels: u32, rate_hz: f64) -> u32 {
    // The hash a real asset store would give these bytes is the hash of the
    // bytes (§2.6). Slice 1 has one file at a time and no store, so the
    // publication number stands in for it — what it has to be is distinct per
    // file, and it is.
    let publication = LINK.with_borrow_mut(|link| link.publish_audio(offset, frames, channels));
    DOCUMENT.with_borrow_mut(|document| {
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&publication.to_le_bytes());
        let described = SampleRate::new(rate_hz).and_then(|rate| {
            Asset::new(
                "source".to_owned(),
                AssetFrames::new(u64::from(frames)),
                rate,
                u16::try_from(channels).unwrap_or(u16::MAX),
            )
        });
        document.use_source(AssetHash::from_bytes(bytes), described.as_ref());
    });
    publish_document();
    publication
}

/// Once a frame: sends what has been waiting, and reads back what the engine
/// says about itself.
///
/// `None` before the handshake, and on a frame where the writer was in the way
/// every time — keep the previous frame's values rather than showing a gap.
#[wasm_bindgen]
#[must_use]
pub fn poll() -> Option<Telemetry> {
    LINK.with_borrow_mut(|link| {
        link.flush();

        let state = link.state()?;
        Some(Telemetry {
            // `f64` rather than `u64`, which would cross as a `BigInt` and be
            // awkward for no gain: 2^53 samples at 48 kHz is six thousand years.
            clock: state.clock as f64,
            quanta: state.quanta as f64,
            peak: state.peak,
            playing: state.playing,
            // `f64` for the reason the clock above is one.
            position: state.position as f64,
            applied: state.commands_applied,
            unknown: state.commands_unknown,
            pending: link.pending() as u32,
            publication: state.audio_publication,
        })
    })
}

/// What the page shows: everything the engine publishes, plus the one number it
/// cannot know — how much the interface has not managed to send yet.
#[wasm_bindgen]
pub struct Telemetry {
    /// Samples the engine has produced since it started.
    pub clock: f64,
    /// Callbacks the host has made. Against `AudioContext.currentTime` this is
    /// where a dropout shows up (§3).
    pub quanta: f64,
    /// Peak of the last quantum, full scale.
    pub peak: f32,
    /// The transport as the engine sees it, which is what a button should
    /// follow rather than what it was last told.
    pub playing: bool,
    /// Where the transport stands, in samples from the timeline's origin — the
    /// one number here the engine alone knows, because what became of the
    /// position it was sent depends on the tempo map it holds.
    pub position: f64,
    /// Commands taken off the ring.
    pub applied: u32,
    /// Commands the engine did not recognize — the two halves have parted
    /// company, and this side is the one that can do something about it.
    pub unknown: u32,
    /// Commands still waiting on this side, for room or for a region.
    pub pending: u32,
    /// The publication the engine is playing frames from — what `use_audio`
    /// returned, once it has been accepted. Behind that number means refused.
    pub publication: u32,
}

/// Renders what the engine would play, outside real time, and hands back a
/// `.wav`.
///
/// **Rendered from the document, which is what the engine was told.** Not from
/// the controls, which are inputs, and not from the state block, which by D22
/// carries only what the engine alone knows. The two paths agree because every
/// value on both crossed the document's constructors first (D24). `rate` stays
/// an argument: the engine did not learn it from anybody, and this side has it
/// from the same host.
///
/// # Errors
///
/// Whatever [`render_to_wav`] refused — as text for a person looking at a page
/// that would not give them a file.
#[wasm_bindgen]
pub fn render_wav(
    source: &[f32],
    channels: usize,
    samples: usize,
    rate: f64,
) -> Result<Vec<u8>, JsError> {
    let playback = DOCUMENT.with_borrow(Document::playback);
    render_to_wav(&playback, source, channels, rate, samples)
        .map_err(|refusal| JsError::new(&refusal.to_string()))
}

fn send(kind: CommandKind) {
    LINK.with_borrow_mut(|link| link.send(Command::now(kind)));
}

/// This module's own `WebAssembly.Memory`.
///
/// Exported for the check below, its only caller. `--shared-memory` is checked
/// at build time (`tools/check-shared-memory.py`), but whether the module then
/// instantiates on a shared memory is not something a build can answer.
#[wasm_bindgen]
#[must_use]
pub fn linear_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Runs on load, before anything on the page can call in.
fn main() {
    log("[escapement] the interface module is up");
}

// Two attributes rather than one `all(...)`, as everywhere else here.
#[cfg(test)]
#[cfg(target_arch = "wasm32")]
mod browser {
    use js_sys::{Reflect, SharedArrayBuffer};
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    use super::*;

    wasm_bindgen_test_configure!(run_in_browser);

    /// Whether the memory came out shared, which is the one thing here that no
    /// build answers on its own.
    ///
    /// Measured, because the obvious version of this claim is wrong: dropping a
    /// single flag from `build.rs` is caught by the linker, since the exported
    /// TLS symbols stop existing, and dropping `--import-memory` is caught by
    /// `wasm-bindgen`. What stays silent is the whole block leaving together —
    /// which is exactly the shape it had while this was still a probe. It
    /// links, it runs, and the memory is private.
    #[wasm_bindgen_test]
    fn the_module_runs_on_a_shared_memory() {
        let buffer = Reflect::get(&linear_memory(), &JsValue::from_str("buffer"))
            .expect("a WebAssembly.Memory has a buffer");

        assert!(
            buffer.is_instance_of::<SharedArrayBuffer>(),
            "the module's memory came out private"
        );
    }
}

// Two attributes rather than one `all(...)`, as everywhere else here.
#[cfg(test)]
#[cfg(target_arch = "wasm32")]
mod wiring {
    use escapement_protocol::{Consumer, Layout, Publisher};
    use escapement_view::{EngineState, View};
    use js_sys::SharedArrayBuffer;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    /// The wiring, and only the wiring: that the exports reach the same `LINK`,
    /// that what they queue leaves through it, that the two which answer with a
    /// place in the region answer with the right one, and that what the engine
    /// publishes comes back.
    ///
    /// One test, and it cannot be joined by a second — the same reason the
    /// worklet's `lib.rs` gives. `LINK` is a `thread_local!` that exists once
    /// and `connect` cannot be undone, so a second test here would be reaching
    /// into whatever the first one left behind.
    #[wasm_bindgen_test]
    fn the_exports_reach_the_region_and_back() {
        // Room for the document: every control sends what the project now
        // says rather than what it was handed, so one call is a handful of
        // commands and not one.
        const LAYOUT: Layout = Layout::new(64, 64);
        let buffer: JsValue = SharedArrayBuffer::new((LAYOUT.words() * 4) as u32).into();
        let cells = View::new(&buffer, 0).expect("a shared buffer at zero");
        LAYOUT.write_header(&cells);

        connect(&buffer, 0).expect("a header is there");

        // Where the page would build its `Float32Array`. Both are read out of
        // the header rather than computed here twice, and both are far enough
        // from zero and one that an export answering with a constant is not
        // answering with these.
        assert_eq!(
            audio_offset(),
            Some((LAYOUT.audio().base() * 4) as u32),
            "the frames are not where the header puts them"
        );
        assert_eq!(
            audio_length(),
            Some((LAYOUT.audio().words() * 4) as u32),
            "the buffer is not the size the header gives it"
        );

        // One file, and the controls around it. Every export below sends the
        // document rather than its argument, so what reaches the ring is what
        // the document says — which is the whole of D24 seen from this side.
        assert_eq!(
            use_audio(2, 3, 4, 48_000.0),
            1,
            "the first publication is not one"
        );
        set_tempo(60.0);
        set_strip(0, 0.5, 0.0, false);
        place_clip(2.0, 4.0, 0.0);
        start();
        stop();
        poll().expect("a state block, even an unwritten one");

        let mut engine = Consumer::<View, Command>::new(cells.clone(), LAYOUT.commands());
        let sent: Vec<CommandKind> =
            core::iter::from_fn(|| engine.pop().map(|c: Command| c.kind)).collect();

        assert!(
            sent.contains(&CommandKind::Audio {
                publication: 1,
                offset: 2,
                frames: 3,
                channels: 4,
            }),
            "the publication did not reach the ring: {sent:?}"
        );
        assert!(
            sent.contains(&CommandKind::SetTempo {
                beats_per_minute: 60.0,
                curve: Curve::Hold,
            }),
            "the tempo did not reach the ring: {sent:?}"
        );
        assert!(
            sent.contains(&CommandKind::SetStrip {
                stage: Stage::Channel,
                gain: 0.5,
                pan: 0.0,
                mute: false,
            }),
            "the channel did not reach the ring: {sent:?}"
        );
        assert!(
            sent.contains(&CommandKind::PlaceClip {
                start: Position::quarters(2),
                length: Span::quarters(4),
                trim: 0,
            }),
            "the clip did not reach the ring as ticks: {sent:?}"
        );
        assert!(
            sent.contains(&CommandKind::Start { at: Position::ZERO }),
            "the transport did not start: {sent:?}"
        );
        assert_eq!(
            sent.last(),
            Some(&CommandKind::Stop),
            "the transport is not where the page left it"
        );

        let published = EngineState {
            clock: 4096,
            quanta: 32,
            position: 4096,
            peak: 0.5,
            playing: true,
            commands_applied: 4,
            commands_unknown: 0,
            audio_publication: 1,
        };
        Publisher::new(cells, LAYOUT.state()).publish(&published);

        let seen = poll().expect("what was just published");
        assert!(seen.playing);
        assert_eq!(seen.peak, 0.5);
        assert_eq!(seen.applied, 4);
        assert_eq!(seen.clock, 4096.0);
        assert_eq!(
            seen.position, 4096.0,
            "the transport position is not carried"
        );
        assert_eq!(seen.publication, 1, "the echo did not come back");

        // The render is here rather than in a test of its own for the reason
        // above: it reads the same `DOCUMENT`, so on its own it would be
        // asking whatever the run before it left in there. What it does is
        // tested on the host; what this asks is that the page hands over a
        // file of two channels, which is what the engine now has.
        let Ok(file) = render_wav(&[], 0, 256, 48_000.0) else {
            panic!("a rate and a length")
        };
        assert_eq!(&file[..4], b"RIFF");
        assert_eq!(
            file.len(),
            escapement_export::wav::HEADER_BYTES + 256 * 2 * 4,
            "a file of one channel where the engine has two"
        );

        // And a refusal crosses the boundary as text, which is the only thing
        // the page can put in front of somebody.
        assert!(render_wav(&[], 0, 4, 0.0).is_err(), "a rate of zero");
    }
}

// Two attributes rather than one `all(...)`, as everywhere else here.
#[cfg(test)]
#[cfg(target_arch = "wasm32")]
mod exports {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    /// A tenth of a second of it, which is all any of these needs: what is
    /// under test here is the document, and a file's description is the same
    /// shape whatever is in it.
    fn sound() -> Asset {
        Asset::new(
            "source".to_owned(),
            AssetFrames::new(4_800),
            SampleRate::new(48_000.0).expect("48 kHz is a rate"),
            1,
        )
        .expect("one channel is audio")
    }

    /// Its own `Document` rather than the page's: the `thread_local!` is one
    /// per process and every test here would be reading whatever the last one
    /// left in it — which is the same argument the module comment makes about
    /// leaving behaviour in a `static`. Caught by CI rather than here: the
    /// order these run in differs between machines, and on mine the test that
    /// loads a file happened to run second.
    #[wasm_bindgen_test]
    fn a_document_with_no_file_has_nothing_to_play() {
        let document = Document::new();
        document
            .project
            .set_tempo(Tempo::new(90.0, Curve::Hold).expect("a tempo is a tempo"));
        document.place_clip(Position::quarters(2), Span::quarters(4), AssetFrames::ZERO);

        let playback = document.playback();
        assert_eq!(playback.tempo().beats_per_minute(), 90.0);
        assert!(playback.clip().is_none(), "a clip nothing has been put on");
        assert!(
            document.project.clips().is_empty(),
            "and the controls made none: a clip is what a file arriving makes"
        );
    }

    /// The names the page hands out are distinct, and they are not a counter.
    ///
    /// The second half is the one worth a test: a counter here mints one, two,
    /// three, and two browsers offline both reach them — the merge then keeps
    /// one entry holding the fields of two entities, with nothing left to
    /// record that there were two (§2.6). This is the only test in the tree
    /// that can ask, because `crypto` is the browser's.
    #[wasm_bindgen_test]
    fn the_names_the_page_hands_out_are_not_one_name_and_not_a_counter() {
        let names: [u128; 3] = core::array::from_fn(|_| Random.next_u128());

        assert_ne!(names[0], names[1]);
        assert_ne!(names[1], names[2]);
        assert_ne!(names[0], 0, "zero is what an unwritten field holds");
        assert!(
            names.iter().any(|name| *name > u128::from(u64::MAX)),
            "a counter never reaches the high half, and random names live there"
        );
    }

    /// A control that is not a value the document accepts does not take the
    /// document with it: the slider is the one that was wrong, and what the
    /// document already held is the last value anybody meant.
    #[wasm_bindgen_test]
    fn a_control_that_is_not_a_value_leaves_the_document_standing() {
        let mut document = Document::new();
        document.use_source(AssetHash::from_bytes([1; 32]), Some(&sound()));

        document.set_strip(0, 0.75, -0.5, false);
        document.set_strip(0, f32::NAN, 9.0, false);
        document.set_strip(1, 0.5, 0.0, false);

        let audible = document.playback().clip().expect("a file and a clip");
        assert_eq!(
            audible.channel().gain().amplitude(),
            0.75,
            "a gain that is not one took the last one with it"
        );
        assert_eq!(
            audible.channel().pan().position(),
            -0.5,
            "and a place that is not one between the speakers did the same"
        );
        assert_eq!(
            audible.insert().gain().amplitude(),
            0.5,
            "the strip beside it did not survive"
        );
    }

    /// A file the page could not describe replaces the one that was playing,
    /// and what replaces it is silence.
    ///
    /// The bytes in the region are the new ones by the time the document hears
    /// about them, so a channel still naming the last file would play what
    /// arrived under the name of what did not. It names the new file instead,
    /// and the document has no description of that one — a dangling name, which
    /// reads as the absence it is (D12).
    #[wasm_bindgen_test]
    fn a_file_the_page_could_not_describe_is_silence_rather_than_the_last_one() {
        let mut document = Document::new();
        document.use_source(AssetHash::from_bytes([1; 32]), Some(&sound()));
        assert!(document.playback().clip().is_some(), "the first file plays");

        document.use_source(AssetHash::from_bytes([2; 32]), None);

        assert!(
            document.playback().clip().is_none(),
            "and the second does not"
        );
        assert_eq!(
            document.project.channels().len(),
            1,
            "through the strip that was already there"
        );
        assert_eq!(
            document.project.assets().len(),
            1,
            "and the file it could describe is still described"
        );
    }

    /// The mixer is read out of the document now, so a second file goes to the
    /// channel that is already there rather than making another one.
    #[wasm_bindgen_test]
    fn a_second_file_is_heard_through_the_channel_the_first_one_made() {
        let mut document = Document::new();

        document.use_source(AssetHash::from_bytes([1; 32]), Some(&sound()));
        document.set_strip(0, 0.25, 0.0, false);
        document.use_source(AssetHash::from_bytes([2; 32]), Some(&sound()));

        assert_eq!(document.project.channels().len(), 1, "one channel, not two");
        assert_eq!(document.project.clips().len(), 1, "and one clip, not two");
        let audible = document.playback().clip().expect("a file and a clip");
        assert_eq!(
            audible.asset(),
            AssetHash::from_bytes([2; 32]),
            "playing the second file"
        );
        assert_eq!(
            audible.channel().gain().amplitude(),
            0.25,
            "through the strip the first one was set to"
        );
    }
}
