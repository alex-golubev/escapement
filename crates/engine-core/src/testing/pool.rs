//! Sounds stored as the build thread stores them.

use std::mem::MaybeUninit;

use super::SAMPLE_RATE;
use crate::pool::{Hash, SamplePool};
use crate::schema::Rejection;

/// [`SAMPLE_RATE`], as the page has it.
pub const HZ: f64 = SAMPLE_RATE.get() as f64;

/// Into a place the pool gave.
pub fn write(place: &mut [MaybeUninit<f32>], numbers: &[f32]) {
    for (slot, &number) in place.iter_mut().zip(numbers) {
        slot.write(number);
    }
}

/// As the build thread stores a sound: its numbers in parts of at most `part`.
pub fn store(
    pool: &mut SamplePool,
    hash: Hash,
    channels: &[&[f32]],
    part: usize,
) -> Result<(), Rejection> {
    let frames = channels.first().map_or(0, |channel| channel.len());
    let mut left = pool.begin(hash, HZ, channels.len(), frames)?;
    for channel in channels {
        for numbers in channel.chunks(part) {
            assert!(left > 0, "the pool took the sound before its last part");
            write(pool.place(numbers.len()), numbers);
            // Safety: just written.
            left = unsafe { pool.copied(numbers.len()) }?;
        }
    }
    assert_eq!(left, 0, "the pool wants more");
    Ok(())
}
