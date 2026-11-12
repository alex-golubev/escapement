//! How a plugin reads the sounds its samples name. The engine holds them, never the plugin: a built-in gets a view
//! straight into the engine's pool, a plugin of its own module a copy in its memory, through the same call.

use std::ops::Range;

use crate::{CHANNELS, SampleNumber};

/// What a plugin gets lasts until it asks again, so a built-in can't lean on what a plugin of its own module won't
/// have. Two stretches at once don't compile:
///
/// ```compile_fail,E0499
/// # use engine_plugins::SampleNumber;
/// # use engine_plugins::samples::SampleReader;
/// fn both(reader: &mut dyn SampleReader, sample: SampleNumber) {
///     let first = reader.frames(sample, 0..64);
///     let second = reader.frames(sample, 64..128);
///     drop((first, second));
/// }
/// ```
///
/// One after the other do:
///
/// ```
/// # use engine_plugins::SampleNumber;
/// # use engine_plugins::samples::SampleReader;
/// fn in_turn(reader: &mut dyn SampleReader, sample: SampleNumber) -> usize {
///     let first = reader.frames(sample, 0..64).map_or(0, |frames| frames.len());
///     let second = reader.frames(sample, 64..128).map_or(0, |frames| frames.len());
///     first + second
/// }
/// ```
pub trait SampleReader {
    /// `sample` is in the plugin's description. `None` while it has no sound yet: the plugin stays silent.
    fn frames(&mut self, sample: SampleNumber, frames: Range<usize>) -> Option<Frames<'_>>;
}

/// A stretch of a sound: each of its channels over the frames asked for, cut where the sound ends.
#[derive(Clone, Copy, Debug)]
pub struct Frames<'a> {
    channels: [&'a [f32]; CHANNELS],
    count: usize,
}

impl<'a> Frames<'a> {
    /// The first `count` channels, of one length, are the sound's; the rest are ignored.
    #[must_use]
    pub fn new(channels: [&'a [f32]; CHANNELS], count: usize) -> Self {
        debug_assert!((1..=CHANNELS).contains(&count), "{count} channels");
        debug_assert!(
            channels[..count]
                .iter()
                .all(|channel| channel.len() == channels[0].len()),
            "channels of one length"
        );
        Self { channels, count }
    }

    /// One for a mono sound, two for stereo.
    #[must_use]
    pub fn channels(&self) -> &[&'a [f32]] {
        &self.channels[..self.count]
    }

    /// Fewer than asked for where the sound ends.
    #[must_use]
    pub fn len(&self) -> usize {
        self.channels[0].len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_empty_where_the_sound_has_ended() {
        let numbers = [0.5, 0.25];
        assert!(!Frames::new([&numbers[..]; CHANNELS], 1).is_empty());
        assert!(Frames::new([&numbers[2..]; CHANNELS], 1).is_empty());
    }
}
