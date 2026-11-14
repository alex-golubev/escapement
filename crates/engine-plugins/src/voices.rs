//! Notes that sound at once, each a voice in a place of its own. As many places again hold voices giving way, so a note
//! that makes room for another fades out rather than cuts off; only with every place taken does a new note cut off
//! the voice giving way nearest silence. Every instrument chooses its voices by this one rule; its voice says only
//! where it stands.

use std::cmp::{Ordering, Reverse};

use crate::SampleRate;
use crate::smoothing::ramp_samples;

/// Notes an instrument sounds at once.
pub(crate) const VOICES: usize = 16;

/// How long a voice that gives way takes to fall silent, rather than one sample.
pub(crate) const GIVE_WAY_SECONDS: f32 = 0.02;

/// What a voice is to a new note.
pub(crate) enum Standing<Room, Distance> {
    /// Taken by a new note before any other place.
    Free,
    /// Heard as a note. With every one of [`VOICES`] heard, the one of the least room gives way to a new note, the
    /// oldest of equals.
    Playing(Room),
    /// On its way out. With no place free, a new note takes that of the one at the least distance from silence.
    GivingWay(Distance),
}

/// An instrument's voice, as [`Voices`] sees it.
pub(crate) trait Voice: Copy {
    type Room: Ord;
    type Distance: Ord;

    fn standing(&self) -> Standing<Self::Room, Self::Distance>;

    /// Whether [`Self::standing`] is [`Standing::Free`]. Asked of every place each block, so a voice whose standing
    /// takes working out answers sooner.
    fn is_free(&self) -> bool {
        matches!(self.standing(), Standing::Free)
    }

    /// Sets it on its way out: down to silence over `samples` at most.
    fn give_way(&mut self, samples: u32);
}

/// A level to order voices by, as [`f64::total_cmp`] orders it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Level(pub(crate) f64);

impl Ord for Level {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl PartialOrd for Level {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Level {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for Level {}

/// An instrument's voices, each in its place.
pub(crate) struct Voices<V> {
    places: [V; 2 * VOICES],
    /// For each place, the notes started before its voice: the fewest, the oldest.
    started: [u64; 2 * VOICES],
    /// Samples a voice takes to give way.
    give_way: u32,
    /// Notes started so far.
    notes: u64,
}

impl<V: Voice> Voices<V> {
    /// Every place free.
    pub(crate) fn new(free: V, sample_rate: SampleRate) -> Self {
        Self {
            places: [free; 2 * VOICES],
            started: [0; 2 * VOICES],
            give_way: ramp_samples(GIVE_WAY_SECONDS, sample_rate),
            notes: 0,
        }
    }

    /// Puts a new note's voice, which `new` makes, in a place, as [`Standing`] has it.
    pub(crate) fn start(&mut self, velocity: f32, new: impl FnOnce() -> V) {
        // A silent note takes no voice: it would only push one that is heard out.
        if velocity == 0.0 {
            return;
        }
        let room = |voice: &V| match voice.standing() {
            Standing::Playing(room) => Some(room),
            Standing::Free | Standing::GivingWay(_) => None,
        };
        if self.places.iter().filter_map(room).count() == VOICES {
            let least = (self.places.iter_mut().zip(&self.started))
                .filter_map(|(voice, &started)| Some(((room(voice)?, started), voice)))
                .min_by(|(a, _), (b, _)| a.cmp(b));
            if let Some((_, least)) = least {
                least.give_way(self.give_way);
            }
        }
        let places = self.places.iter_mut().zip(&mut self.started);
        let place = places.max_by_key(|(voice, _)| match voice.standing() {
            Standing::Free => (2, None),
            Standing::GivingWay(distance) => (1, Some(Reverse(distance))),
            Standing::Playing(_) => (0, None),
        });
        if let Some((voice, started)) = place {
            *voice = new();
            *started = self.notes;
            self.notes += 1;
        }
    }

    /// Every voice whose place isn't free.
    pub(crate) fn in_use(&mut self) -> impl Iterator<Item = &mut V> {
        (self.places.iter_mut()).filter(|voice| !voice.is_free())
    }

    pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.places.iter_mut()
    }

    #[cfg(test)]
    pub(crate) fn places(&self) -> &[V] {
        &self.places
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_orders_as_total_cmp_does() {
        for (a, b) in [(0.25, 0.5), (0.5, 0.25), (0.5, 0.5), (-0.0, 0.0)] {
            let total = f64::total_cmp(&a, &b);
            assert_eq!(Level(a).partial_cmp(&Level(b)), Some(total), "{a} {b}");
            assert_eq!(Level(a) == Level(b), total.is_eq(), "{a} {b}");
        }
    }
}
