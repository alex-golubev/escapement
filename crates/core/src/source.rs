/// The most channels a source may have.
///
/// Not a limit on any format — a budget. One frame costs one read per channel,
/// so a quantum costs the channel count times 128, and a descriptor crossing a
/// memory the other half writes to may name as many channels as the buffer has
/// words. A quantum at 48 kHz has 2.7 ms in it (ARCHITECTURE.md §1), which a
/// million reads is not, and a mistake on the other side must not be able to
/// ask for one.
///
/// Sixty-four is above anything `decodeAudioData` hands back and leaves the
/// worst quantum at 8192 reads.
pub const MAX_SOURCE_CHANNELS: usize = 64;

/// Where a player's frames come from.
///
/// A trait rather than a slice, which is what this crate takes everywhere else
/// — `tempo::build` and the buffer it writes into are the idiom. The frames
/// live in the shared region, which the interface writes to as well, so they
/// are read one at a time through relaxed atomics; naming that here would put
/// the protocol, and the memory it describes, inside a crate that is only about
/// sound (ARCHITECTURE.md §3). The worklet implements this over the region, and
/// [`Frames`](crate::Frames) is the same over a slice.
pub trait Samples {
    /// How many frames there are.
    fn frames(&self) -> usize;

    /// Samples per frame. They are interleaved, so this is the stride too.
    fn channels(&self) -> usize;

    /// One sample, and silence for one that is not there.
    ///
    /// Total on purpose, for the reason `Slot::decode` is: an index this does
    /// not like is a value rather than an error, and the only honest thing to
    /// do with an error on the audio thread is nothing.
    fn sample(&self, frame: usize, channel: usize) -> f32;
}

/// One frame of a source, its channels averaged into one.
///
/// **Averaged rather than taken from the first channel**: a stereo loop heard
/// as one side of itself is a mix decision made by accident. What puts the
/// result between the speakers is the channel strip, and it is handed a mono
/// signal to put there.
///
/// Silence for a frame that is not there and for a source with no channels —
/// the descriptor crossed a memory the other half writes to, and a frame
/// divided by no channels at all is what would produce an infinity.
///
/// No cursor, and no resampling. Where in the source to read is the transport's
/// answer, worked out from the clip on the timeline; relating a file's own
/// frames to the timeline at any other rate is warping, and that is slice 4's
/// (§2.5).
pub fn frame<S: Samples>(samples: &S, index: usize) -> f32 {
    let channels = samples.channels();
    if channels == 0 || index >= samples.frames() {
        return 0.0;
    }

    let mut sum = 0.0;
    for channel in 0..channels {
        sum += samples.sample(index, channel);
    }

    // `channels` is not zero here, so this is a division and not an infinity —
    // the check above is what makes that true.
    #[expect(clippy::cast_precision_loss, reason = "a channel count")]
    {
        sum / channels as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frames;

    /// A source saying it has frames and no channels — which [`Frames`] cannot
    /// spell, and a descriptor arriving from the other side of the region can.
    struct Malformed;

    impl Samples for Malformed {
        fn frames(&self) -> usize {
            4
        }

        fn channels(&self) -> usize {
            0
        }

        fn sample(&self, _frame: usize, _channel: usize) -> f32 {
            1.0
        }
    }

    #[test]
    fn a_frame_is_read_where_it_was_asked_for() {
        let held = [0.1, 0.2, 0.3, 0.4];
        let source = Frames::new(&held, 1);

        assert_eq!(frame(&source, 0), 0.1);
        assert_eq!(frame(&source, 3), 0.4);
    }

    /// One channel out of two, so the two sides are averaged. Taking the first
    /// instead would play a stereo loop as one side of itself.
    #[test]
    fn the_channels_of_a_frame_are_averaged() {
        let held = [1.0, 0.0, 0.5, 0.5];
        let source = Frames::new(&held, 2);

        assert_eq!(frame(&source, 0), 0.5);
        assert_eq!(frame(&source, 1), 0.5);
    }

    #[test]
    fn a_frame_past_the_end_is_silence_rather_than_a_read() {
        let held = [0.1, 0.2];
        let source = Frames::new(&held, 1);

        assert_eq!(frame(&source, 2), 0.0);
        assert_eq!(frame(&source, usize::MAX), 0.0);
    }

    /// The answer is silence, and the point is that it is not an infinity.
    #[test]
    fn a_source_of_no_channels_is_silent_rather_than_an_infinity() {
        assert_eq!(frame(&Malformed, 0), 0.0);
    }
}
