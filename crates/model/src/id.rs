//! What names an entity, and the one way to make a new name.
//!
//! 128 random bits, minted locally (ARCHITECTURE.md §2.6). The count is private
//! for the reason `escapement-time` keeps a position's ticks private: the shape
//! stays revisitable only while nothing outside this crate computes on the
//! integer, and it is the first saved project that shuts that door rather than
//! the type.
//!
//! **The randomness comes from outside.** A browser's generator is reached
//! through a dependency this crate has no other use for, and a test wants names
//! it can write down rather than names it has to mint and then remember. So the
//! source is a trait, and the crate builds and runs on the host.

use core::cmp::Ordering;
use core::fmt;
use core::hash::{Hash, Hasher};
use core::marker::PhantomData;

/// The name of one entity of kind `T`.
///
/// The kind is a marker and not a field. Two minted names never collide
/// whatever they name, so what the parameter buys is a compiler that refuses
/// the name of a pattern where a channel was meant — the one confusion this
/// document's shape makes easy, since every reference between entities is a
/// name and nothing else.
pub struct Id<T> {
    bits: u128,
    // `fn() -> T` and not `T`: this holds no entity, so it must not inherit
    // `T`'s auto traits or take part in its drop order.
    kind: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    /// A name no one else will mint.
    #[must_use]
    pub fn mint(entropy: &mut impl Entropy) -> Self {
        Self::from_bits(entropy.next_u128())
    }

    /// From the raw bits — what comes back out of a document.
    ///
    /// This and [`Id::bits`] are the serialization boundary, not a second way
    /// to make a name. One that was not minted is one that two people can write
    /// at the same time, which is the collision §2.6 spends 128 bits to avoid.
    #[must_use]
    pub const fn from_bits(bits: u128) -> Self {
        Self {
            bits,
            kind: PhantomData,
        }
    }

    /// The raw bits. See [`Id::from_bits`].
    #[must_use]
    pub const fn bits(self) -> u128 {
        self.bits
    }
}

/// Where the bits of a new [`Id`] come from.
///
/// One method, because the whole of what a document needs from randomness is
/// 128 bits that no one else will produce. Whether they come from the browser's
/// generator or from a counter a test wrote is not this crate's business, and
/// making it one would cost the crate its host build.
pub trait Entropy {
    /// 128 bits bearing no relation to the last 128.
    ///
    /// A source that repeats itself produces two entities with one name, and
    /// nothing downstream can notice: the merge keeps one entry holding the
    /// fields of both, exactly as a shared counter would (§2.6).
    fn next_u128(&mut self) -> u128;
}

// Written out rather than derived. `derive` bounds the parameter by the trait
// it is deriving, and the parameter here is a marker that implements nothing —
// so an `Id<Pattern>` would stop being `Copy` on the day `Pattern` did.
impl<T> Clone for Id<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    fn eq(&self, other: &Self) -> bool {
        self.bits == other.bits
    }
}

impl<T> Eq for Id<T> {}

impl<T> PartialOrd for Id<T> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Not an order anyone chose — names are random. It is here because a map wants
/// one, and because a listing that comes out in a different order every time it
/// is read is a diff nobody can review.
impl<T> Ord for Id<T> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.bits.cmp(&other.bits)
    }
}

impl<T> Hash for Id<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.bits.hash(state);
    }
}

/// Hexadecimal and full width, so that two names differing in one bit do not
/// print the same and two of different widths do not line up wrongly.
impl<T> fmt::Debug for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Id({:032x})", self.bits)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::hash_map::DefaultHasher;
    use std::collections::{BTreeMap, HashMap};

    use super::*;
    use crate::fixtures::Counter;

    struct Thing;
    struct Other;

    /// What a document holds is the integer, so what goes in has to come back.
    #[test]
    fn a_name_survives_the_round_trip_through_its_bits() {
        for bits in [0, 1, u128::MAX, 0x0123_4567_89ab_cdef_0123_4567_89ab_cdef] {
            assert_eq!(Id::<Thing>::from_bits(bits).bits(), bits);
        }
    }

    /// The name is the source's bits and nothing else: a mint that folded,
    /// masked or reordered them would answer a question nobody asked, and the
    /// answer would still look like a name.
    #[test]
    fn a_minted_name_is_the_bits_the_source_gave() {
        let mut entropy = Counter::new();
        let expected = Counter::new().next_u128();

        assert_eq!(Id::<Thing>::mint(&mut entropy).bits(), expected);
    }

    #[test]
    fn two_mints_never_answer_with_the_same_name() {
        let mut entropy = Counter::new();

        let first = Id::<Thing>::mint(&mut entropy);
        let second = Id::<Thing>::mint(&mut entropy);

        assert_ne!(first, second);
    }

    #[test]
    fn names_compare_and_order_by_their_bits() {
        let low = Id::<Thing>::from_bits(1);
        let high = Id::<Thing>::from_bits(2);
        let again = Id::<Thing>::from_bits(1);

        assert_eq!(low, again);
        assert_ne!(low, high);
        assert!(low < high);
        assert!(high > low);
        assert_eq!(low.cmp(&again), Ordering::Equal);
    }

    /// Both kinds of map, because the document will want both: one to find an
    /// entity by name, one to list them in an order that does not move.
    #[test]
    fn a_name_is_a_key() {
        let name = Id::<Thing>::from_bits(7);
        let other = Id::<Thing>::from_bits(8);

        let mut hashed = HashMap::new();
        hashed.insert(name, "kept");
        assert_eq!(hashed.get(&name), Some(&"kept"));
        assert_eq!(hashed.get(&other), None);

        let mut ordered = BTreeMap::new();
        ordered.insert(other, "second");
        ordered.insert(name, "first");
        assert_eq!(
            ordered.into_values().collect::<Vec<_>>(),
            ["first", "second"],
            "a listing has to come out the same way twice"
        );
    }

    /// A map works whatever the hash is — every key in one bucket is slower,
    /// not wrong — so the map above cannot tell whether these bits are hashed
    /// at all. This can: the contract is that equal names hash alike, and it is
    /// worth nothing unless different ones usually do not.
    #[test]
    fn a_name_hashes_by_its_bits() {
        fn hash_of(id: Id<Thing>) -> u64 {
            let mut hasher = DefaultHasher::new();
            id.hash(&mut hasher);
            hasher.finish()
        }

        let name = Id::<Thing>::from_bits(7);

        assert_eq!(hash_of(name), hash_of(Id::from_bits(7)));
        assert_ne!(hash_of(name), hash_of(Id::from_bits(8)));
    }

    /// The marker is what keeps a pattern's name out of a channel's field, and
    /// it is checked by the compiler rather than here — what a test can say is
    /// that carrying it costs a name nothing.
    #[test]
    fn the_kind_is_a_marker_and_takes_no_room() {
        assert_eq!(size_of::<Id<Thing>>(), size_of::<u128>());
        assert_eq!(size_of::<Id<Other>>(), size_of::<Id<Thing>>());
    }

    /// A name is unreadable either way; what a failing test needs is that two
    /// of them do not print alike.
    #[test]
    fn a_name_prints_all_of_its_bits() {
        assert_eq!(
            format!("{:?}", Id::<Thing>::from_bits(0xdead_beef)),
            "Id(000000000000000000000000deadbeef)"
        );
        assert_eq!(
            format!("{:?}", Id::<Thing>::from_bits(u128::MAX)),
            "Id(ffffffffffffffffffffffffffffffff)"
        );
    }
}
