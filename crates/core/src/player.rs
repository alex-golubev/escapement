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
/// a test hands it an array.
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

/// Plays frames from wherever it is pointed, once, at the rate they were
/// recorded at.
///
/// No stretching and no resampling. What relates a file's own frames to the
/// timeline is warping, and that is slice 4's to build (§2.5); until then the
/// frames arrive already at the project's rate, because `decodeAudioData`
/// resamples to the context it was called on.
pub struct Player {
    frame: usize,
}

impl Player {
    /// At the start of whatever it is given.
    #[must_use]
    pub const fn new() -> Self {
        Self { frame: 0 }
    }

    /// Back to the start.
    pub fn rewind(&mut self) {
        self.frame = 0;
    }

    /// Fills `out` with the next block and falls silent at the end of the
    /// source.
    ///
    /// Overwrites, rather than adding into what is there: nothing sums yet, and
    /// a mixer is where summing acquires a place to happen (§2.6).
    ///
    /// One channel out, because slice 1's output is one channel. The source's
    /// channels are averaged rather than dropped, so a stereo loop is not heard
    /// as one side of itself — and the average is what the mixer replaces when
    /// it arrives with a pan to put the two sides at.
    pub fn process<S: Samples>(&mut self, samples: &S, out: &mut [f32]) {
        let channels = samples.channels();
        let frames = samples.frames();

        for slot in out.iter_mut() {
            if channels == 0 || self.frame >= frames {
                *slot = 0.0;
                continue;
            }

            let mut sum = 0.0;
            for channel in 0..channels {
                sum += samples.sample(self.frame, channel);
            }

            // `channels` is not zero here, so this is a division and not an
            // infinity — the check above is what makes that true.
            #[expect(clippy::cast_precision_loss, reason = "a channel count")]
            {
                *slot = sum / channels as f32;
            }

            // Saturating, so that nothing on this path can panic in a debug
            // build. The cursor stops at `frames` an instant later either way.
            self.frame = self.frame.saturating_add(1);
        }
    }
}

impl Default for Player {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::Recorded;

    /// A source saying it has frames and no channels — which [`Recorded`]
    /// cannot spell, and a descriptor arriving from the other side of the
    /// region can.
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
    fn plays_a_source_one_frame_at_a_time() {
        let mut player = Player::new();
        let mut out = [0.0f32; 4];
        player.process(&Recorded::new(&[0.1, 0.2, 0.3, 0.4], 1), &mut out);

        assert_eq!(out, [0.1, 0.2, 0.3, 0.4]);
    }

    /// One channel out of two, so the two sides are averaged. Taking the first
    /// instead would play a stereo loop as one side of itself, which is a mix
    /// decision made by accident.
    #[test]
    fn the_channels_of_a_frame_are_averaged() {
        let mut player = Player::new();
        let mut out = [0.0f32; 2];
        player.process(&Recorded::new(&[1.0, 0.0, 0.5, 0.5], 2), &mut out);

        assert_eq!(out, [0.5, 0.5]);
    }

    /// The block asked for is always filled: a source that runs out mid-block
    /// leaves silence behind it rather than whatever the caller's buffer held.
    #[test]
    fn a_source_that_runs_out_fills_the_rest_with_silence() {
        let mut player = Player::new();
        let mut out = [0.9f32; 4];
        player.process(&Recorded::new(&[0.1, 0.2], 1), &mut out);

        assert_eq!(out, [0.1, 0.2, 0.0, 0.0]);
    }

    #[test]
    fn a_block_carries_on_where_the_last_one_stopped() {
        let source = Recorded::new(&[0.1, 0.2, 0.3, 0.4], 1);
        let mut player = Player::new();
        let mut out = [0.0f32; 2];

        player.process(&source, &mut out);
        assert_eq!(out, [0.1, 0.2]);

        player.process(&source, &mut out);
        assert_eq!(out, [0.3, 0.4]);

        player.rewind();
        player.process(&source, &mut out);
        assert_eq!(out, [0.1, 0.2]);
    }

    /// A descriptor arrives across a memory the other half writes to, so a
    /// source of no channels is a shape this has to have an answer for. The
    /// answer is silence, and the point of the test is that it is not an
    /// infinity: a frame divided by no channels at all is what would produce
    /// one.
    ///
    /// [`Malformed`] rather than a source of no samples, so that this stands
    /// on the channel count alone — one with nothing in it has no frames left
    /// either, and would be turned away by the other half of the same guard.
    #[test]
    fn a_source_of_no_channels_is_silent_rather_than_an_infinity() {
        let mut player = Player::new();
        let mut out = [0.9f32; 4];
        player.process(&Malformed, &mut out);

        assert_eq!(out, [0.0; 4]);
    }
}
