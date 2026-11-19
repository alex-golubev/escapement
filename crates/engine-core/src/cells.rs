//! Tables that only swaps change: the build thread allocates each table, a larger one included, and the audio thread
//! swaps what the cells hold in and out, so it never allocates or frees. Each table has its own kind of place, so a
//! place of one never reads another.

use std::marker::PhantomData;
use std::{iter, mem};

/// A cell for each place of kind `K`, holding a `T` or nothing.
#[derive(Debug)]
pub(crate) struct Cells<K, T> {
    cells: Box<[Option<T>]>,
    /// Takes places of kind `K`, and holds none.
    place: PhantomData<fn(K)>,
}

/// No cells at all.
impl<K, T> Default for Cells<K, T> {
    fn default() -> Self {
        Self {
            cells: Box::default(),
            place: PhantomData,
        }
    }
}

impl<K: Into<usize>, T> Cells<K, T> {
    /// Every cell empty. Allocates, so only on the build thread, or before the audio thread starts.
    pub(crate) fn new(len: usize) -> Self {
        Self {
            cells: iter::repeat_with(|| None).take(len).collect(),
            place: PhantomData,
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.cells.len()
    }

    /// None for an empty cell, or past the table.
    pub(crate) fn get(&self, place: K) -> Option<&T> {
        self.cells.get(place.into())?.as_ref()
    }

    /// As [`Self::get`].
    pub(crate) fn get_mut(&mut self, place: K) -> Option<&mut T> {
        self.cells.get_mut(place.into())?.as_mut()
    }

    /// Swaps `slot` into the cell; what was there comes back in it. False past the table: `slot` stays as it was.
    #[must_use]
    pub(crate) fn swap(&mut self, place: K, slot: &mut Option<T>) -> bool {
        let Some(cell) = self.cells.get_mut(place.into()) else {
            return false;
        };
        mem::swap(cell, slot);
        true
    }

    /// Swaps the cell with the one at `there` in `other`. False past either table: neither changes.
    #[must_use]
    pub(crate) fn swap_with<L: Into<usize>>(
        &mut self,
        place: K,
        other: &mut Cells<L, T>,
        there: L,
    ) -> bool {
        let (Some(cell), Some(there)) = (
            self.cells.get_mut(place.into()),
            other.cells.get_mut(there.into()),
        ) else {
            return false;
        };
        mem::swap(cell, there);
        true
    }

    /// Everything moves over to `larger`, an empty table at least as long, which takes this one's place; this one,
    /// empty, is left in it.
    pub(crate) fn grow(&mut self, larger: &mut Self) {
        debug_assert!(larger.cells.len() >= self.cells.len(), "a smaller table");
        debug_assert!(
            larger.cells.iter().all(Option::is_none),
            "a table not empty"
        );
        for (old, new) in self.cells.iter_mut().zip(&mut larger.cells) {
            mem::swap(old, new);
        }
        mem::swap(self, larger);
    }
}
