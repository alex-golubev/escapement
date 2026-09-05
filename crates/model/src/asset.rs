//! An audio file the project refers to, and what refers to it.
//!
//! The one entity whose name is not minted (ARCHITECTURE.md §2.6). A hash of
//! the bytes is what the document holds, so the same loop imported by two
//! people is one entry rather than two — which is the whole of what a
//! content-addressed store buys, and it is free only here (§2.4).
//!
//! **The bytes are not in the document and never will be.** They live in a
//! store of their own, cached locally by the same hash; forty megabytes in a
//! CRDT is forty megabytes that merges, persists and undoes.

use core::fmt;

use escapement_time::SampleRate;

/// The name of an audio file: 256 bits of hash over its bytes.
///
/// **Which function produces them is not settled here**, and is not this
/// crate's to settle — it belongs with the worker that reads bytes and the
/// service that stores them. What the document commits to is the width, and a
/// hash of another width would be a migration of every project ever saved.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetHash([u8; 32]);

impl AssetHash {
    /// From the raw bytes — what comes out of a document, and what comes back
    /// from whatever hashed the file.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The raw bytes. See [`AssetHash::from_bytes`].
    #[must_use]
    pub const fn bytes(self) -> [u8; 32] {
        self.0
    }
}

/// Hexadecimal and full width. Two files differ somewhere in those bytes, and
/// a printer that stopped early would say they were the same file.
impl fmt::Debug for AssetHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AssetHash(")?;
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        write!(f, ")")
    }
}

/// What the document knows about a file: enough to list it, draw it and say how
/// long it is.
///
/// **Its hash is not a field.** The document holds these keyed by hash, and a
/// key repeated in its own value is a second copy for a merge to disagree with
/// — the same reason the tempo and signature marks do not carry their own
/// addresses (§2.5).
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    name: String,
    frames: u64,
    rate: SampleRate,
    // Of the file, not of the project. `.claude/rules/musical-time.md` keeps a
    // rate out of the document because the *conversion's* rate is a parameter —
    // the offline render picks its own. This one is a fact about bytes that
    // already exist, and without it the frames below mean nothing.
    channels: u16,
}

impl Asset {
    /// `None` for a file with no channels, which is not audio and has no
    /// reading as any.
    ///
    /// A file of no frames is allowed through: an empty recording is a real
    /// thing to have imported, and it draws and plays as the silence it is.
    #[must_use]
    pub fn new(name: String, frames: u64, rate: SampleRate, channels: u16) -> Option<Self> {
        if channels == 0 {
            return None;
        }
        Some(Self {
            name,
            frames,
            rate,
            channels,
        })
    }

    /// What to show a person. Not an identity — two files may share a name, and
    /// one file renamed by two people is one entry either way.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Length in frames, where a frame is one sample across every channel.
    ///
    /// Frames rather than samples, and the distinction is the reason: a stereo
    /// file holds two samples per frame, and the timeline elsewhere counts
    /// samples of one channel.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// The file's own rate, which is what its frames are counted at — the third
    /// of the counts §2.5 keeps apart, and never the project's.
    #[must_use]
    pub fn rate(&self) -> SampleRate {
        self.rate
    }

    /// How many samples a frame holds.
    #[must_use]
    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// How long the file is, in seconds of itself.
    ///
    /// Through the one type that divides by a rate (§2.5) rather than by doing
    /// it here. Seconds because they are physical: what this is in bars depends
    /// on a tempo map the file knows nothing about, and on a stretch that is
    /// slice 4's to build.
    #[must_use]
    pub fn seconds(&self) -> f64 {
        self.rate
            .seconds_at(i64::try_from(self.frames).unwrap_or(i64::MAX))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn hash(first: u8) -> AssetHash {
        let mut bytes = [0; 32];
        bytes[0] = first;
        AssetHash::from_bytes(bytes)
    }

    fn rate() -> SampleRate {
        SampleRate::new(48_000.0).expect("48 kHz is a rate")
    }

    fn asset(frames: u64) -> Asset {
        Asset::new("loop.wav".to_owned(), frames, rate(), 2).expect("stereo is audio")
    }

    #[test]
    fn a_hash_survives_the_round_trip_through_its_bytes() {
        let bytes = core::array::from_fn(|i| i as u8);

        assert_eq!(AssetHash::from_bytes(bytes).bytes(), bytes);
    }

    /// Identity is the bytes and all of them: a file differing in the last one
    /// is a different file, and two hashes that compared equal would put its
    /// audio under the first one's name.
    #[test]
    fn hashes_differ_wherever_their_bytes_do() {
        let mut last = [0; 32];
        last[31] = 1;

        assert_eq!(hash(0), AssetHash::from_bytes([0; 32]));
        assert_ne!(hash(0), AssetHash::from_bytes(last));
        assert_ne!(hash(1), hash(2));
    }

    #[test]
    fn a_hash_is_a_key() {
        let mut library = HashMap::new();
        library.insert(hash(1), "kick");

        assert_eq!(library.get(&hash(1)), Some(&"kick"));
        assert_eq!(library.get(&hash(2)), None);
    }

    #[test]
    fn a_hash_prints_all_of_its_bytes() {
        let mut bytes = [0; 32];
        bytes[0] = 0xde;
        bytes[31] = 0xff;

        assert_eq!(
            format!("{:?}", AssetHash::from_bytes(bytes)),
            "AssetHash(de000000000000000000000000000000000000000000000000000000000000ff)"
        );
    }

    #[test]
    fn a_file_with_no_channels_is_not_audio() {
        assert_eq!(Asset::new("silence".to_owned(), 48_000, rate(), 0), None);
    }

    #[test]
    fn a_file_of_no_frames_is_still_a_file() {
        let empty = Asset::new("empty".to_owned(), 0, rate(), 1).expect("mono is audio");

        assert_eq!(empty.frames(), 0);
        assert_eq!(empty.seconds(), 0.0);
    }

    #[test]
    fn a_file_holds_what_it_was_built_from() {
        let asset = asset(96_000);

        assert_eq!(asset.name(), "loop.wav");
        assert_eq!(asset.frames(), 96_000);
        assert_eq!(asset.rate(), rate());
        assert_eq!(asset.channels(), 2);
    }

    /// Frames over the file's own rate, and neither the project's rate nor the
    /// channel count comes into it — a stereo file is not half as long.
    #[test]
    fn a_file_is_as_long_as_its_frames_at_its_own_rate() {
        assert_eq!(asset(48_000).seconds(), 1.0);
        assert_eq!(asset(24_000).seconds(), 0.5);

        let slow = Asset::new(
            "slow".to_owned(),
            48_000,
            SampleRate::new(24_000.0).unwrap(),
            2,
        )
        .expect("a rate is a rate");
        assert_eq!(slow.seconds(), 2.0);
    }

    /// A length no file has, arriving from a document that says it does. The
    /// answer is wrong either way; what matters is that it is not negative,
    /// which is what the cast alone would have made it.
    #[test]
    fn a_file_longer_than_time_saturates_rather_than_wrapping() {
        assert!(asset(u64::MAX).seconds() > 0.0);
    }
}
