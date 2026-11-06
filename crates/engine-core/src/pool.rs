//! The sounds the engine stores, each under the SHA-256 of its file. The pool outlives sessions, so a rebuild never
//! copies a sound again. A sound stays while the page keeps it or a node refers to it; only the page stores and evicts.
//! The build thread copies a sound in parts, so batches never wait long for it. A sound stays empty until its last
//! part is in and never changes after, so the audio thread only ever reads one. Whoever lets go of a sound last frees
//! it, and that is always the build thread: the audio thread hands nodes back rather than dropping them.

use std::collections::HashMap;
use std::hint::black_box;
use std::mem::MaybeUninit;
use std::ops::Range;
use std::sync::{Arc, OnceLock};

use crate::CHANNELS;
use crate::schema::Rejection;

/// A sound's name: the SHA-256 of its file.
pub type Hash = [u8; 32];

/// Bytes still free after a sound is taken, for the engine's own work; it starts with 2 MiB in all.
const HEADROOM: usize = 16 << 20;

/// Empty until every number is in; set once, then only read.
#[derive(Default)]
pub struct Sample(OnceLock<Pcm>);

impl Sample {
    /// None while empty: one atomic read, no heap and no waiting.
    pub fn pcm(&self) -> Option<&Pcm> {
        self.0.get()
    }
}

/// A sound's numbers, channel after channel.
pub struct Pcm {
    channels: usize,
    frames: usize,
    numbers: Vec<f32>,
}

impl Pcm {
    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    /// The channel's numbers over `frames`, cut at the sound's end; nothing for a channel it doesn't have.
    pub fn view(&self, channel: usize, frames: Range<usize>) -> &[f32] {
        if channel >= self.channels {
            return &[];
        }
        let end = frames.end.min(self.frames);
        let start = frames.start.min(end);
        let first = channel * self.frames;
        &self.numbers[first + start..first + end]
    }
}

/// A sound under its hash.
#[derive(Default)]
struct Entry {
    sample: Arc<Sample>,
    /// The page stored it, or is storing it, and hasn't evicted it.
    kept: bool,
}

/// A sound whose numbers are coming in.
struct Copying {
    hash: Hash,
    sample: Arc<Sample>,
    channels: usize,
    frames: usize,
    /// Every number's room, allocated at once; its length is how many are in.
    place: Vec<f32>,
}

impl Copying {
    fn left(&self) -> usize {
        self.channels * self.frames - self.place.len()
    }
}

pub struct SamplePool {
    sample_rate: f32,
    samples: HashMap<Hash, Entry>,
    /// One at a time.
    copying: Option<Copying>,
}

impl SamplePool {
    pub(crate) fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            samples: HashMap::new(),
            copying: None,
        }
    }

    pub fn get(&self, hash: &Hash) -> Option<&Arc<Sample>> {
        self.samples.get(hash).map(|entry| &entry.sample)
    }

    /// The sound under `hash`: stored, coming in, or an empty place that it fills once it is stored.
    pub fn refer(&mut self, hash: Hash) -> Arc<Sample> {
        Arc::clone(&self.samples.entry(hash).or_default().sample)
    }

    /// A sound the page doesn't keep lives only while someone refers to it, a sound coming in included.
    pub fn forget_unreferred(&mut self) {
        self.samples
            .retain(|_, entry| entry.kept || Arc::strong_count(&entry.sample) > 1);
    }

    /// The page no longer keeps the sound under `hash`. Nodes that refer to it play it on, and find it by its hash,
    /// until the last lets go; an empty place stays for the nodes that wait for its sound. Must not be called while a
    /// sound is coming in.
    pub fn evict(&mut self, hash: &Hash) {
        assert!(self.copying.is_none(), "one sound at a time");
        if let Some(entry) = self.samples.get_mut(hash) {
            entry.kept = false;
        }
        self.forget_unreferred();
    }

    /// Starts storing a sound of `channels` × `frames` numbers under `hash`, which the page keeps from then on. Returns
    /// how many numbers to copy to [`Self::place`], or 0 if the sound is in already, the same sound having the same
    /// name: one evicted that a node still holds is kept again, without a copy. Must not be called while another sound
    /// is coming in.
    pub fn begin(
        &mut self,
        hash: Hash,
        sample_rate: f32,
        channels: usize,
        frames: usize,
    ) -> Result<usize, Rejection> {
        assert!(self.copying.is_none(), "one sound at a time");
        if channels == 0 {
            return Err(Rejection::Malformed);
        }
        if channels > CHANNELS {
            return Err(Rejection::TooManyChannels);
        }
        if sample_rate != self.sample_rate {
            return Err(Rejection::WrongSampleRate);
        }
        let sample = match self.samples.get_mut(&hash) {
            Some(entry) if entry.sample.pcm().is_some() => {
                entry.kept = true;
                return Ok(0);
            }
            Some(entry) => Arc::clone(&entry.sample),
            None => Arc::default(),
        };
        let numbers = channels.checked_mul(frames).ok_or(Rejection::OutOfMemory)?;
        // A failure leaves the engine as it was; a plain allocation would abort it.
        self.samples
            .try_reserve(1)
            .map_err(|_| Rejection::OutOfMemory)?;
        let mut place = Vec::new();
        place
            .try_reserve_exact(numbers)
            .map_err(|_| Rejection::OutOfMemory)?;
        // Taken and let go: the allocator keeps it, so allocations after the sound find room.
        let mut headroom = Vec::<u8>::new();
        headroom
            .try_reserve_exact(HEADROOM)
            .map_err(|_| Rejection::OutOfMemory)?;
        // The optimizer may drop an allocation nobody uses and take it as made.
        black_box(headroom);
        self.samples.insert(
            hash,
            Entry {
                sample: Arc::clone(&sample),
                kept: true,
            },
        );
        self.copying = Some(Copying {
            hash,
            sample,
            channels,
            frames,
            place,
        });
        if numbers == 0 {
            self.finish();
        }
        Ok(numbers)
    }

    /// Room for the next `count` numbers, right after those in.
    pub fn place(&mut self, count: usize) -> &mut [MaybeUninit<f32>] {
        let copying = self.copying.as_mut().expect("a sound coming in");
        assert!(count <= copying.left(), "more numbers than the sound has");
        &mut copying.place.spare_capacity_mut()[..count]
    }

    /// Takes in the next `count` numbers; returns how many are left, 0 once the sound is in. A number that isn't
    /// finite refuses the whole sound.
    ///
    /// # Safety
    ///
    /// The first `count` numbers of the last [`Self::place`] are written.
    pub unsafe fn copied(&mut self, count: usize) -> Result<usize, Rejection> {
        let copying = self.copying.as_mut().expect("a sound coming in");
        assert!(count <= copying.left(), "more numbers than the sound has");
        // Safety: the caller wrote them.
        let part = unsafe { copying.place.spare_capacity_mut()[..count].assume_init_ref() };
        // One NaN would stay in a filter's memory for good. No early exit, so it runs in SIMD lanes.
        let finite = part
            .iter()
            .fold(true, |finite, number| finite & number.is_finite());
        if !finite {
            return Err(self.refuse(Rejection::InvalidValue));
        }
        let len = copying.place.len() + count;
        // Safety: written and checked, right after the ones before.
        unsafe { copying.place.set_len(len) };
        let left = copying.left();
        if left == 0 {
            self.finish();
        }
        Ok(left)
    }

    fn finish(&mut self) {
        if let Some(Copying {
            sample,
            channels,
            frames,
            place,
            ..
        }) = self.copying.take()
        {
            let pcm = Pcm {
                channels,
                frames,
                numbers: place,
            };
            assert!(sample.0.set(pcm).is_ok(), "a sound is set once");
        }
    }

    fn refuse(&mut self, reason: Rejection) -> Rejection {
        if let Some(Copying { hash, .. }) = self.copying.take()
            && let Some(entry) = self.samples.get_mut(&hash)
        {
            entry.kept = false;
        }
        self.forget_unreferred();
        reason
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::heap;

    const RATE: f32 = 48_000.0;
    const KICK: Hash = [1; 32];
    const SNARE: Hash = [2; 32];

    fn write(place: &mut [MaybeUninit<f32>], numbers: &[f32]) {
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
        let mut left = pool.begin(hash, RATE, channels.len(), frames)?;
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

    fn coming_in(pool: &SamplePool) -> bool {
        pool.copying.is_some()
    }

    fn ramp(len: usize, from: f32) -> Vec<f32> {
        (0..len).map(|i| from + i as f32).collect()
    }

    fn pcm<'a>(pool: &'a SamplePool, hash: &Hash) -> Option<&'a Pcm> {
        pool.get(hash).and_then(|sample| sample.pcm())
    }

    #[test]
    fn a_sound_is_empty_until_its_last_part_is_in() {
        let (left, right) = (ramp(10, 0.0), ramp(10, 100.0));
        let mut pool = SamplePool::new(RATE);
        assert_eq!(pool.begin(KICK, RATE, 2, 10), Ok(20));
        for (part, expected) in [(&left[..7], 13), (&left[7..], 10), (&right[..], 0)] {
            assert!(
                pcm(&pool, &KICK).is_none(),
                "empty while numbers are missing"
            );
            write(pool.place(part.len()), part);
            assert_eq!(unsafe { pool.copied(part.len()) }, Ok(expected));
        }
        let pcm = pcm(&pool, &KICK).expect("in after the last part");
        assert_eq!((pcm.channels(), pcm.frames()), (2, 10));
        assert!(!coming_in(&pool));
    }

    #[test]
    fn a_view_gives_the_numbers_sent_cut_at_the_end() {
        let (left, right) = (ramp(10, 0.0), ramp(10, 100.0));
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&left, &right], 3).unwrap();
        let pcm = pcm(&pool, &KICK).unwrap();
        assert_eq!(pcm.view(0, 0..10), left);
        assert_eq!(pcm.view(1, 4..7), &right[4..7]);
        assert_eq!(pcm.view(1, 8..20), &right[8..]);
        assert_eq!(pcm.view(0, 12..20), &[] as &[f32]);
        assert_eq!(pcm.view(2, 0..10), &[] as &[f32]);
    }

    #[test]
    fn the_same_sound_again_is_in_at_once_without_a_copy() {
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&ramp(1000, 0.0)], 100).unwrap();
        let before = heap::calls();
        assert_eq!(pool.begin(KICK, RATE, 1, 1000), Ok(0));
        assert_eq!(heap::calls().wrapping_sub(before), 0);
        assert!(!coming_in(&pool));
    }

    #[test]
    fn a_sound_without_frames_is_in_at_once() {
        let mut pool = SamplePool::new(RATE);
        assert_eq!(pool.begin(KICK, RATE, 2, 0), Ok(0));
        assert!(!coming_in(&pool));
        let pcm = pcm(&pool, &KICK).unwrap();
        assert_eq!((pcm.channels(), pcm.frames()), (2, 0));
        assert_eq!(pcm.view(0, 0..10), &[] as &[f32]);
    }

    #[test]
    fn a_number_that_is_not_finite_refuses_the_sound_and_leaves_nothing() {
        let last_nan = [1.0, 2.0, f32::NAN];
        let fine = [1.0, 2.0, 3.0];
        for (channels, part) in [
            (vec![&last_nan[..]], 3),
            (vec![&last_nan[..]], 1),
            (vec![&fine[..], &last_nan[..]], 2),
            (vec![&[f32::INFINITY, 0.0, 0.0][..]], 3),
            (vec![&fine[..], &[0.0, f32::NEG_INFINITY, 0.0][..]], 3),
        ] {
            let mut pool = SamplePool::new(RATE);
            assert_eq!(
                store(&mut pool, KICK, &channels, part),
                Err(Rejection::InvalidValue)
            );
            assert!(pool.get(&KICK).is_none());
            // And the pool goes on.
            store(&mut pool, KICK, &[&fine], 3).unwrap();
        }
    }

    #[test]
    fn large_finite_numbers_are_sound() {
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&[f32::MAX, f32::MIN, 0.0]], 3).unwrap();
    }

    #[test]
    fn a_sound_the_engine_cannot_play_is_refused_before_anything_is_stored() {
        let mut pool = SamplePool::new(RATE);
        for (channels, rate, reason) in [
            (3, RATE, Rejection::TooManyChannels),
            (1, 44_100.0, Rejection::WrongSampleRate),
            (0, RATE, Rejection::Malformed),
        ] {
            let before = heap::calls();
            assert_eq!(pool.begin(KICK, rate, channels, 10), Err(reason));
            assert_eq!(heap::calls().wrapping_sub(before), 0);
            assert!(pool.get(&KICK).is_none());
        }
    }

    #[test]
    fn a_sound_too_large_to_count_is_out_of_memory() {
        let mut pool = SamplePool::new(RATE);
        assert_eq!(
            pool.begin(KICK, RATE, 2, usize::MAX),
            Err(Rejection::OutOfMemory)
        );
        assert!(pool.get(&KICK).is_none());
        store(&mut pool, KICK, &[&[0.5]], 1).unwrap();
    }

    #[test]
    fn a_refused_sound_that_someone_refers_to_stays_empty_and_fills_later() {
        let mut pool = SamplePool::new(RATE);
        let fine = [0.5, 0.25];
        store(&mut pool, SNARE, &[&fine], 2).unwrap();
        let held = pool.refer(KICK);
        assert_eq!(
            store(&mut pool, KICK, &[&[f32::NAN, 0.0]], 2),
            Err(Rejection::InvalidValue)
        );
        assert!(
            pool.get(&KICK)
                .is_some_and(|sample| Arc::ptr_eq(sample, &held))
        );
        assert!(held.pcm().is_none());
        store(&mut pool, KICK, &[&fine], 1).unwrap();
        assert_eq!(held.pcm().unwrap().view(0, 0..2), fine);
    }

    #[test]
    fn a_sound_referred_to_before_it_is_stored_fills_the_same_place() {
        let mut pool = SamplePool::new(RATE);
        let early = pool.refer(KICK);
        assert!(early.pcm().is_none());
        assert!(Arc::ptr_eq(&early, &pool.refer(KICK)), "one place");
        store(&mut pool, KICK, &[&[0.5, 0.25]], 1).unwrap();
        assert_eq!(early.pcm().unwrap().view(0, 0..2), [0.5, 0.25]);
        let stored = pool.refer(KICK);
        assert!(Arc::ptr_eq(&early, &stored));
    }

    #[test]
    fn an_empty_place_goes_with_the_last_reference_and_a_stored_sound_stays() {
        let mut pool = SamplePool::new(RATE);
        let (kick, snare, clap) = (pool.refer(KICK), pool.refer(SNARE), pool.refer([3; 32]));
        let second_kick = pool.refer(KICK);
        store(&mut pool, SNARE, &[&[0.5]], 1).unwrap();
        drop((kick, snare, clap));
        pool.forget_unreferred();
        assert!(pool.get(&KICK).is_some(), "still referred to");
        assert!(pool.get(&SNARE).is_some(), "stored");
        assert!(pool.get(&[3; 32]).is_none(), "nobody waits for it");
        drop(second_kick);
        pool.forget_unreferred();
        assert!(pool.get(&KICK).is_none());
    }

    #[test]
    fn a_place_referred_to_while_its_sound_comes_in_goes_with_its_last_reference_after_a_refusal() {
        let mut pool = SamplePool::new(RATE);
        pool.begin(KICK, RATE, 1, 2).unwrap();
        let node = pool.refer(KICK);
        write(pool.place(2), &[0.5, f32::NAN]);
        assert_eq!(unsafe { pool.copied(2) }, Err(Rejection::InvalidValue));
        assert!(pool.get(&KICK).is_some(), "referred to");
        drop(node);
        pool.forget_unreferred();
        assert!(pool.get(&KICK).is_none());
    }

    #[test]
    fn an_empty_place_stays_while_its_sound_comes_in() {
        let mut pool = SamplePool::new(RATE);
        drop(pool.refer(KICK));
        pool.begin(KICK, RATE, 1, 2).unwrap();
        pool.forget_unreferred();
        write(pool.place(2), &[0.5, 0.25]);
        assert_eq!(unsafe { pool.copied(2) }, Ok(0));
        assert!(pcm(&pool, &KICK).is_some());
    }

    #[test]
    fn an_evicted_sound_nobody_refers_to_is_freed_at_once() {
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&[0.5, 0.25]], 2).unwrap();
        store(&mut pool, SNARE, &[&[0.5]], 1).unwrap();
        let freed = Arc::downgrade(pool.get(&KICK).unwrap());
        pool.evict(&KICK);
        assert!(pool.get(&KICK).is_none());
        assert!(freed.upgrade().is_none());
        assert!(pcm(&pool, &SNARE).is_some(), "the others stay");
    }

    #[test]
    fn an_evicted_sound_a_node_refers_to_is_found_by_its_hash_until_the_last_reference_goes() {
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&[0.5, 0.25]], 2).unwrap();
        let node = pool.refer(KICK);
        pool.evict(&KICK);
        let later = pool.refer(KICK);
        assert!(Arc::ptr_eq(&node, &later), "one sound for the hash");
        assert_eq!(later.pcm().unwrap().view(0, 0..2), [0.5, 0.25]);
        let freed = Arc::downgrade(&node);
        drop(node);
        pool.forget_unreferred();
        assert!(pool.get(&KICK).is_some(), "still referred to");
        drop(later);
        pool.forget_unreferred();
        assert!(pool.get(&KICK).is_none());
        assert!(freed.upgrade().is_none());
    }

    #[test]
    fn storing_an_evicted_sound_still_referred_to_takes_no_copy_and_keeps_it_again() {
        let mut pool = SamplePool::new(RATE);
        store(&mut pool, KICK, &[&ramp(1000, 0.0)], 100).unwrap();
        let node = pool.refer(KICK);
        pool.evict(&KICK);
        let before = heap::calls();
        assert_eq!(pool.begin(KICK, RATE, 1, 1000), Ok(0));
        assert_eq!(heap::calls().wrapping_sub(before), 0);
        drop(node);
        pool.forget_unreferred();
        assert!(pcm(&pool, &KICK).is_some(), "kept again");
    }

    #[test]
    fn evicting_an_unknown_hash_or_an_empty_place_changes_nothing() {
        let mut pool = SamplePool::new(RATE);
        pool.evict(&SNARE);
        assert!(pool.get(&SNARE).is_none());
        let node = pool.refer(KICK);
        pool.evict(&KICK);
        assert!(pool.get(&KICK).is_some(), "the node waits for its sound");
        store(&mut pool, KICK, &[&[0.5]], 1).unwrap();
        assert_eq!(node.pcm().unwrap().view(0, 0..1), [0.5]);
    }

    #[test]
    #[should_panic(expected = "one sound at a time")]
    fn there_is_no_eviction_while_a_sound_comes_in() {
        let mut pool = SamplePool::new(RATE);
        pool.begin(KICK, RATE, 1, 10).unwrap();
        pool.evict(&SNARE);
    }

    #[test]
    #[should_panic(expected = "one sound at a time")]
    fn a_second_sound_waits_for_the_first() {
        let mut pool = SamplePool::new(RATE);
        pool.begin(KICK, RATE, 1, 10).unwrap();
        let _ = pool.begin(SNARE, RATE, 1, 10);
    }

    #[test]
    #[should_panic(expected = "a sound coming in")]
    fn there_is_no_place_without_a_sound_coming_in() {
        let mut pool = SamplePool::new(RATE);
        pool.place(1);
    }

    #[test]
    #[should_panic(expected = "more numbers than the sound has")]
    fn there_is_no_place_past_the_sound() {
        let mut pool = SamplePool::new(RATE);
        pool.begin(KICK, RATE, 2, 10).unwrap();
        pool.place(21);
    }
}
