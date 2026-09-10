//! What RIFF wants around a block of samples.
//!
//! Floating point rather than the more usual 16-bit integers: nothing rounds
//! between what the engine rendered and what the file holds, so a file that
//! differs from what was heard differs because the engine does.

use std::fmt;

use escapement_time::SampleRate;

const BYTES_PER_SAMPLE: u16 = 4;

/// The same width the `fmt ` chunk declares in bits. Derived rather than
/// written twice: apart, one of them moves and the chunk describes samples the
/// data chunk does not hold.
const BITS_PER_SAMPLE: u16 = BYTES_PER_SAMPLE * 8;

/// `WAVE_FORMAT_IEEE_FLOAT`. Tag 1 is the integer PCM this is not.
const FORMAT_TAG: u16 = 3;

/// A `fmt ` chunk for anything but integer PCM carries a trailing size field,
/// so it is 18 bytes rather than 16 — and a `fact` chunk becomes required
/// alongside it.
const FMT_BYTES: u32 = 18;
const FACT_BYTES: u32 = 4;

/// Everything `RIFF` measures apart from the samples: `WAVE`, the two chunks
/// ahead of the data, and the data chunk's own header.
const BYTES_BEFORE_SAMPLES: u32 = 4 + (8 + FMT_BYTES) + (8 + FACT_BYTES) + 8;

/// Bytes in front of the first sample: `RIFF`, its own size field, and
/// everything [`BYTES_BEFORE_SAMPLES`] counts.
///
/// Public because a caller reading samples back out of a file has otherwise
/// nothing to slice at, and the copy it would write instead stops being true
/// the moment a chunk is added here.
pub const HEADER_BYTES: usize = 8 + BYTES_BEFORE_SAMPLES as usize;

/// Interleaved `samples` as a `.wav` file.
///
/// # Errors
///
/// [`EncodeError`], for a channel count, a rate or a length the header has no
/// way to spell.
pub fn encode(samples: &[f32], channels: usize, rate: SampleRate) -> Result<Vec<u8>, EncodeError> {
    let header = Header::new(samples.len(), channels, rate)?;

    // The file the header already measured, rather than a second computation of
    // it: what `RIFF` counts, plus the tag and size field it leaves out.
    // Saturating because a capacity is a hint — the largest file `Header::new`
    // admits is eight bytes past a 32-bit `usize`, and being eight short costs
    // one growth rather than an error this has nowhere to report.
    let mut out = Vec::with_capacity((header.riff_size as usize).saturating_add(8));
    header.write(&mut out);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(out)
}

/// The numbers in front of the samples, worked out before anything is written.
///
/// Apart from [`encode`] so that every refusal below can be reached from a test
/// without allocating the file that would have provoked it.
struct Header {
    riff_size: u32,
    channels: u16,
    rate_hz: u32,
    byte_rate: u32,
    block_align: u16,
    frames: u32,
    data_size: u32,
}

impl Header {
    fn new(samples: usize, channels: usize, rate: SampleRate) -> Result<Self, EncodeError> {
        let channel_count = u16::try_from(channels)
            .ok()
            .filter(|count| *count > 0)
            .ok_or(EncodeError::Channels { channels })?;
        // A frame is measured in 16 bits, which is a tighter ceiling than the
        // channel count's own.
        let block_align = channel_count
            .checked_mul(BYTES_PER_SAMPLE)
            .ok_or(EncodeError::Channels { channels })?;

        if !samples.is_multiple_of(channels) {
            return Err(EncodeError::PartialFrame { samples, channels });
        }

        let data_size = u64::try_from(samples)
            .ok()
            .and_then(|count| count.checked_mul(u64::from(BYTES_PER_SAMPLE)))
            .and_then(|bytes| u32::try_from(bytes).ok())
            .ok_or(EncodeError::TooLarge { samples })?;
        let riff_size = data_size
            .checked_add(BYTES_BEFORE_SAMPLES)
            .ok_or(EncodeError::TooLarge { samples })?;

        let rounded = rate.hz().round();
        // Against the byte rate rather than against `u32` alone: that field is
        // this rate multiplied by a frame, and it is 32 bits wide too.
        let ceiling = f64::from(u32::MAX / u32::from(block_align));
        if rounded < 1.0 || rounded > ceiling {
            return Err(EncodeError::Rate { hz: rate.hz() });
        }
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "bounded by the two comparisons above"
        )]
        let rate_hz = rounded as u32;

        Ok(Self {
            riff_size,
            channels: channel_count,
            rate_hz,
            // The ceiling above is exactly this product's bound.
            byte_rate: rate_hz * u32::from(block_align),
            block_align,
            // Both sides are a count of samples times the same four bytes.
            frames: data_size / u32::from(block_align),
            data_size,
        })
    }

    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&self.riff_size.to_le_bytes());
        out.extend_from_slice(b"WAVE");

        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&FMT_BYTES.to_le_bytes());
        out.extend_from_slice(&FORMAT_TAG.to_le_bytes());
        out.extend_from_slice(&self.channels.to_le_bytes());
        out.extend_from_slice(&self.rate_hz.to_le_bytes());
        out.extend_from_slice(&self.byte_rate.to_le_bytes());
        out.extend_from_slice(&self.block_align.to_le_bytes());
        out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
        // `cbSize`, and the reason the chunk is 18 bytes.
        out.extend_from_slice(&0u16.to_le_bytes());

        out.extend_from_slice(b"fact");
        out.extend_from_slice(&FACT_BYTES.to_le_bytes());
        out.extend_from_slice(&self.frames.to_le_bytes());

        out.extend_from_slice(b"data");
        out.extend_from_slice(&self.data_size.to_le_bytes());
    }
}

/// Why a block of samples could not be written as a file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EncodeError {
    /// A file has at least one channel, and a frame of them is measured in 16
    /// bits.
    Channels {
        /// What was asked for.
        channels: usize,
    },
    /// Interleaved samples that do not divide into whole frames.
    PartialFrame {
        /// How many there were.
        samples: usize,
        /// What they were said to be frames of.
        channels: usize,
    },
    /// The header holds a whole number of samples a second, and the bytes a
    /// second that follow from it, in 32 bits each.
    Rate {
        /// What was asked for.
        hz: f64,
    },
    /// RIFF measures a file in 32 bits.
    TooLarge {
        /// How many samples were offered.
        samples: usize,
    },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Channels { channels } => write!(f, "{channels} channels is not a frame"),
            Self::PartialFrame { samples, channels } => {
                write!(
                    f,
                    "{samples} samples do not divide into {channels} channels"
                )
            }
            Self::Rate { hz } => write!(f, "{hz} Hz is not a rate a header can hold"),
            Self::TooLarge { samples } => {
                write!(f, "{samples} samples are more than RIFF measures")
            }
        }
    }
}

impl std::error::Error for EncodeError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(hz: f64) -> SampleRate {
        SampleRate::new(hz).expect("the tests chose a rate")
    }

    fn word(file: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(file[at..at + 4].try_into().expect("four bytes"))
    }

    fn half(file: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(file[at..at + 2].try_into().expect("two bytes"))
    }

    fn sample(file: &[u8], at: usize) -> f32 {
        f32::from_le_bytes(file[at..at + 4].try_into().expect("four bytes"))
    }

    /// Every field at the offset a reader will look for it, spelled out rather
    /// than computed the way the writer computes them — a field that moves puts
    /// the ones after it somewhere else, and only fixed offsets notice.
    ///
    /// Four stereo frames at 48 kHz, so no two numbers in the header coincide.
    #[test]
    fn the_header_is_the_one_a_reader_looks_for() {
        let file = encode(&[0.0; 8], 2, rate(48_000.0)).expect("four stereo frames");

        assert_eq!(&file[0..4], b"RIFF");
        assert_eq!(&file[8..12], b"WAVE");

        assert_eq!(&file[12..16], b"fmt ");
        assert_eq!(word(&file, 16), 18, "a non-PCM fmt chunk is 18 bytes");
        assert_eq!(half(&file, 20), 3, "not IEEE float");
        assert_eq!(half(&file, 22), 2, "channels");
        assert_eq!(word(&file, 24), 48_000, "samples a second");
        assert_eq!(word(&file, 28), 48_000 * 8, "bytes a second");
        assert_eq!(half(&file, 32), 8, "bytes in a frame");
        assert_eq!(half(&file, 34), 32, "bits in a sample");
        assert_eq!(half(&file, 36), 0, "cbSize");

        assert_eq!(&file[38..42], b"fact");
        assert_eq!(word(&file, 42), 4);
        assert_eq!(word(&file, 46), 4, "frames, not samples");

        assert_eq!(&file[50..54], b"data");
        assert_eq!(word(&file, 54), 32, "bytes of samples");
        assert_eq!(file.len(), 58 + 32);
    }

    /// What `RIFF` measures is everything after its own size field. A writer
    /// that counts the whole file instead is off by eight, which some readers
    /// forgive and others truncate over.
    #[test]
    fn the_riff_size_measures_everything_after_it() {
        let file = encode(&[0.0; 6], 1, rate(44_100.0)).expect("six frames");

        assert_eq!(word(&file, 4) as usize, file.len() - 8);
    }

    /// Bit for bit, which is the whole reason the format is floating point:
    /// a sample above full scale survives, where 16-bit integers would have
    /// clipped it and rounded the rest.
    #[test]
    fn the_samples_come_back_bit_for_bit() {
        let written = [0.0, -1.0, 1.5, 0.123_456_79_f32];
        let file = encode(&written, 1, rate(48_000.0)).expect("four frames");

        for (index, value) in written.iter().enumerate() {
            assert_eq!(sample(&file, 58 + index * 4), *value, "sample {index}");
        }
    }

    /// A render of nothing is a file with a header and no samples, rather than
    /// a refusal — the transport can legitimately be asked for no time at all.
    #[test]
    fn a_render_of_nothing_is_still_a_file() {
        let file = encode(&[], 2, rate(48_000.0)).expect("no frames");

        assert_eq!(file.len(), 58);
        assert_eq!(word(&file, 4) as usize, file.len() - 8);
        assert_eq!(word(&file, 46), 0, "frames");
        assert_eq!(word(&file, 54), 0, "bytes of samples");
    }

    #[test]
    fn a_channel_count_that_is_not_a_frame_is_refused() {
        assert_eq!(
            Header::new(0, 0, rate(48_000.0)).err(),
            Some(EncodeError::Channels { channels: 0 }),
            "no channels at all"
        );
        assert_eq!(
            Header::new(0, 65_536, rate(48_000.0)).err(),
            Some(EncodeError::Channels { channels: 65_536 }),
            "more channels than the count field holds"
        );
        assert_eq!(
            Header::new(0, 20_000, rate(48_000.0)).err(),
            Some(EncodeError::Channels { channels: 20_000 }),
            "a frame of them is more than the alignment field holds"
        );
        assert!(
            Header::new(0, 16_383, rate(48_000.0)).is_ok(),
            "the largest frame that fits"
        );
    }

    #[test]
    fn samples_that_do_not_divide_into_frames_are_refused() {
        assert_eq!(
            Header::new(5, 2, rate(48_000.0)).err(),
            Some(EncodeError::PartialFrame {
                samples: 5,
                channels: 2
            })
        );
    }

    /// Both ends of the rate: one that rounds away to nothing, and one whose
    /// bytes a second overflow the field they go in.
    #[test]
    fn a_rate_the_header_cannot_hold_is_refused() {
        assert_eq!(
            Header::new(0, 1, rate(0.4)).err(),
            Some(EncodeError::Rate { hz: 0.4 }),
            "a rate that rounds to no samples a second"
        );
        assert!(
            Header::new(0, 1, rate(0.5)).is_ok(),
            "a rate that rounds up to one"
        );

        // Eight bytes in a stereo frame, so the ceiling is an eighth of the
        // field's own.
        let too_fast = f64::from(u32::MAX / 8) + 1.0;
        assert_eq!(
            Header::new(0, 2, rate(too_fast)).err(),
            Some(EncodeError::Rate { hz: too_fast }),
            "bytes a second past the field"
        );
        assert!(
            Header::new(0, 2, rate(too_fast - 1.0)).is_ok(),
            "exactly the ceiling"
        );
    }

    #[test]
    fn every_encode_error_says_what_went_wrong() {
        for error in [
            EncodeError::Channels { channels: 0 },
            EncodeError::PartialFrame {
                samples: 5,
                channels: 2,
            },
            EncodeError::Rate { hz: 0.4 },
            EncodeError::TooLarge {
                samples: usize::MAX,
            },
        ] {
            assert!(format!("{error}").len() > 20, "{error:?} says nothing");
        }
    }

    /// Both sizes RIFF holds in 32 bits: the samples, and the file measured
    /// around them. Reached through [`Header`] rather than [`encode`], because
    /// the buffer that would provoke either does not fit in memory.
    #[test]
    fn more_samples_than_a_32_bit_size_can_measure_are_refused() {
        assert_eq!(
            Header::new(usize::MAX, 1, rate(48_000.0)).err(),
            Some(EncodeError::TooLarge {
                samples: usize::MAX
            }),
            "the samples alone"
        );

        // The largest block of samples whose bytes still fit, which leaves the
        // header with nowhere to go.
        let brim = (u32::MAX / 4) as usize;
        assert_eq!(
            Header::new(brim, 1, rate(48_000.0)).err(),
            Some(EncodeError::TooLarge { samples: brim }),
            "the header on top of them"
        );
    }
}
