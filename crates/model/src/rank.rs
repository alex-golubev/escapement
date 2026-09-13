//! Where something sits among the things beside it, as a value rather than a
//! place.
//!
//! Lanes, channels and inserts were arranged by a person, and yrs has no move
//! operation — so the order is a field each entity carries and the document
//! holds no list at all (D19). `.claude/rules/model.md` says what a list would
//! cost; what is here is the one operation that shape needs: **a key strictly
//! between two keys, however close together they are.**
//!
//! **Compared, never parsed.** The ordering *is* the meaning. Nothing outside
//! this module reads a byte of it, and nothing anywhere does arithmetic on one
//! — a rank is not a number, and a document where somebody has averaged two of
//! them is a document where the next insert has nowhere to go.
//!
//! The argument for the representation, and the proof that the peer on the end
//! leaves the key where it was put, are D26.

use core::cmp::Ordering;

/// What every key ends with when it has to be longer than the ones it sits
/// between — the middle of the byte, so that there is room on both sides of it
/// afterwards.
const MIDDLE: u8 = 0x80;

/// Where something sits among its siblings.
///
/// The bytes are a fraction written in base 256, compared the way two strings
/// are. Two of them are equal only if the same peer minted both, which it will
/// not do twice in one gap — and the sort breaks a tie by identity anyway,
/// because a listing that comes out in two orders is not a listing.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Rank(Vec<u8>);

impl Rank {
    /// A key after `lower`, or the first key of all when there is none.
    ///
    /// There is always room above, so this is the entry point with an answer
    /// for every input — which is why adding at the end of a collection is
    /// spelled with it rather than with [`Rank::between`].
    ///
    /// `peer` goes on the end so that two people filling one gap at the same
    /// moment do not arrive at one key by agreement. It is the whole client
    /// identifier: eight bytes is nothing against a collection a person
    /// arranged by hand, and a truncated one would collide by construction
    /// rather than by chance.
    #[must_use]
    pub(crate) fn after(lower: Option<&Self>, peer: u64) -> Self {
        Self(tail(above(bytes(lower)), peer))
    }

    /// A key below `upper`, and above `lower` when there is one.
    ///
    /// `None` when the two are not in that order, their being equal included:
    /// there is no key strictly between a key and itself, and answering with
    /// one of the two would be a reordering nobody asked for.
    #[must_use]
    pub(crate) fn between(lower: Option<&Self>, upper: &Self, peer: u64) -> Option<Self> {
        below(bytes(lower), &upper.0).map(|base| Self(tail(base, peer)))
    }

    /// How a document holds it: hexadecimal, which is the one spelling whose
    /// order as a string is the bytes' own order.
    ///
    /// A name is spelled in base64 and this is not, and the difference is the
    /// point: a name is only ever compared for equality, so it is spelled for
    /// width, while this is only ever compared for order.
    #[must_use]
    pub(crate) fn spell(&self) -> String {
        use core::fmt::Write;

        self.0.iter().fold(String::new(), |mut spelling, byte| {
            let _ = write!(spelling, "{byte:02x}");
            spelling
        })
    }

    /// A key back out of a document, or nothing if what is there is not one.
    ///
    /// The last byte carries the invariant, and it is worth saying why a zero
    /// there is refused rather than trimmed. Between `[0x40]` and `[0x40, 0x00]`
    /// there is no key at all — they are the same fraction written twice — so a
    /// document holding the second is one where an ordinary drag has no answer.
    /// Turned away here, that pair cannot arise.
    #[must_use]
    pub(crate) fn read(spelling: &str) -> Option<Self> {
        let spelling = spelling.as_bytes();
        if spelling.is_empty() || !spelling.len().is_multiple_of(2) {
            return None;
        }
        // The remainder is empty by the guard above, so the pairs are the whole
        // of it and a half byte has already been turned away.
        let bytes: Option<Vec<u8>> = spelling
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[high, low]| Some((digit(high)? << 4) + digit(low)?))
            .collect();
        let bytes = bytes?;
        if bytes.last() == Some(&0) {
            return None;
        }
        Some(Self(bytes))
    }
}

/// A key's bytes, where a key that is not there reads as no bytes at all — the
/// empty string, which sorts below every key there is.
fn bytes(rank: Option<&Rank>) -> &[u8] {
    rank.map_or(&[][..], |rank| &rank.0)
}

/// What a hexadecimal character is worth, or nothing if it is not one.
///
/// Lower case only. Both cases accepted would make two spellings of one key,
/// and a key is a map's value rather than a person's typing.
fn digit(character: u8) -> Option<u8> {
    match character {
        b'0'..=b'9' => Some(character - b'0'),
        b'a'..=b'f' => Some(character - b'a' + 10),
        _ => None,
    }
}

/// Bytes that sort after `lower` with nothing above them to stay under.
///
/// Widening only when the last byte has run out of room, so a collection built
/// by appending stays one byte wide for 127 of its entries rather than growing
/// one byte an entry.
fn above(lower: &[u8]) -> Vec<u8> {
    match lower.split_last() {
        Some((&last, front)) if last < u8::MAX => {
            let mut bytes = front.to_vec();
            bytes.push(last + 1);
            bytes
        }
        // Nothing to raise, so go longer: `lower` is then a prefix of the
        // answer, which is what makes the answer bigger.
        _ => {
            let mut bytes = lower.to_vec();
            bytes.push(MIDDLE);
            bytes
        }
    }
}

/// Bytes that sort after `lower` and before `upper`, or nothing if those two
/// are not in that order.
///
/// `lower` may be empty, which is how "before everything" is spelled — the
/// empty string sorts below every key there is.
fn below(lower: &[u8], upper: &[u8]) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    for (place, &high) in upper.iter().enumerate() {
        // A `lower` that has run out reads as zeroes, which is what it means:
        // every key starting with those bytes sorts above it.
        let low = lower.get(place).copied().unwrap_or(0);
        // One comparison and not two: `low > high` asked after `low == high`
        // has been answered can be written either way round and mean the same,
        // which is a branch no test can reach the far side of.
        match low.cmp(&high) {
            Ordering::Equal => {
                bytes.push(low);
                continue;
            }
            Ordering::Greater => return None,
            Ordering::Less => {}
        }
        if low + 1 < high {
            // Room for a byte of its own, and the answer ends here.
            bytes.push(low + (high - low) / 2);
            return Some(bytes);
        }
        // Adjacent, so the answer is longer than `lower` rather than different
        // from it: this byte already puts it under `upper`, and the rest only
        // has to put it over `lower`.
        bytes.push(low);
        bytes.extend_from_slice(&above(lower.get(place + 1..).unwrap_or_default()));
        return Some(bytes);
    }
    // `upper` ran out while the two still agreed, so it is a prefix of `lower`
    // or the same key. Neither has anything between it and `lower`.
    None
}

/// The peer on the end.
///
/// The `1` is the invariant and not a flourish: a client identifier ending in a
/// zero byte would make a key ending in one, and that is the pair `read`
/// refuses for having nothing between it and its own neighbour.
fn tail(mut base: Vec<u8>, peer: u64) -> Vec<u8> {
    base.extend_from_slice(&peer.to_be_bytes());
    if base.last() == Some(&0) {
        base.push(1);
    }
    base
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// Two peers, so that a test which would pass with the tail left off has to
    /// say so out loud.
    const OURS: u64 = 0x0001_2345_6789_abcd;
    const THEIRS: u64 = 0x0009_8765_4321_fedc;

    fn rank(bytes: &[u8]) -> Rank {
        Rank(bytes.to_vec())
    }

    /// The two entry points with no peer on the end, for the tests about the
    /// fraction itself. What the peer adds is bytes after it, and the property
    /// below is what says that adding them moves nothing.
    fn bare_after(lower: Option<&Rank>) -> Rank {
        Rank(above(bytes(lower)))
    }

    fn bare_between(lower: Option<&Rank>, upper: &Rank) -> Option<Rank> {
        below(bytes(lower), &upper.0).map(Rank)
    }

    #[test]
    fn the_first_key_of_a_collection_leaves_room_on_both_sides() {
        let first = bare_after(None);

        assert_eq!(first, rank(&[MIDDLE]));
        assert!(bare_between(None, &first).expect("room below") < first);
        assert!(bare_after(Some(&first)) > first);
    }

    /// Appending stays one byte wide until the byte is used up, which is what
    /// keeps a collection built by appending from growing a byte an entry.
    #[test]
    fn appending_widens_only_when_the_byte_is_full() {
        let mut key = bare_after(None);
        for _ in 0..126 {
            key = bare_after(Some(&key));
        }

        assert_eq!(key, rank(&[0xfe]), "still one byte after 126 of them");

        key = bare_after(Some(&key));
        assert_eq!(key, rank(&[0xff]), "the last value the byte holds");

        key = bare_after(Some(&key));
        assert_eq!(key, rank(&[0xff, MIDDLE]), "and only now a second byte");
    }

    /// A gap wide enough is filled inside itself, and the key stays the width
    /// it was.
    ///
    /// Written as the exact key rather than as "between the two": every branch
    /// of the generator answers something between the two, including the one
    /// that widens when it did not have to, and a collection whose keys grow a
    /// byte at every insert still passes a test that only asks for the order.
    #[test]
    fn a_key_with_room_around_it_takes_the_middle_and_stays_as_wide() {
        let between = bare_between(Some(&rank(&[0x40])), &rank(&[MIDDLE])).expect("in order");

        assert_eq!(between, rank(&[0x60]));
    }

    /// The operation the whole shape rests on: two keys with nothing between
    /// them still have something between them.
    #[test]
    fn a_key_fits_between_two_that_are_adjacent() {
        let low = rank(&[MIDDLE]);
        let high = rank(&[0x81]);

        let between = bare_between(Some(&low), &high).expect("in order");

        assert_eq!(between, rank(&[MIDDLE, MIDDLE]));
        assert!(low < between && between < high);
    }

    /// Below the smallest key there is still something, which is what putting a
    /// thing at the top of a collection needs.
    #[test]
    fn a_key_fits_below_one_that_has_almost_no_room() {
        for upper in [rank(&[0x01]), rank(&[0x00, 0x01]), rank(&[0x00, MIDDLE])] {
            let below = bare_between(None, &upper).expect("there is always room below");

            assert!(below < upper, "{below:?} is not below {upper:?}");
            assert_ne!(below.0.last(), Some(&0), "and it is a key");
        }
    }

    #[test]
    fn two_ends_out_of_order_have_nothing_between_them() {
        let low = rank(&[0x40]);
        let high = rank(&[MIDDLE]);

        assert_eq!(Rank::between(Some(&high), &low, OURS), None, "swapped");
        assert_eq!(Rank::between(Some(&low), &low, OURS), None, "equal");
        assert_eq!(
            Rank::between(Some(&rank(&[0x40, MIDDLE])), &low, OURS),
            None,
            "the upper end is a prefix of the lower one"
        );
    }

    /// The reason the tail is there at all.
    #[test]
    fn two_peers_filling_one_gap_do_not_agree_on_a_key() {
        let low = rank(&[0x40]);
        let high = rank(&[MIDDLE]);

        let ours = Rank::between(Some(&low), &high, OURS).expect("in order");
        let theirs = Rank::between(Some(&low), &high, THEIRS).expect("in order");

        assert_ne!(ours, theirs);
        assert!(low < ours && ours < high);
        assert!(low < theirs && theirs < high);
    }

    /// A client identifier ending in a zero byte is ordinary, and the key it
    /// makes must still be one this module would read back.
    #[test]
    fn a_peer_ending_in_nothing_still_makes_a_key() {
        let key = Rank::after(None, 0x0012_3456_7890_ab00);

        assert_ne!(key.0.last(), Some(&0));
        assert_eq!(Rank::read(&key.spell()).as_ref(), Some(&key));
    }

    #[test]
    fn a_key_is_spelled_in_a_way_that_keeps_its_order() {
        assert_eq!(rank(&[0x0f, 0xa0]).spell(), "0fa0");
        assert!(rank(&[0x0f]).spell() < rank(&[0x10]).spell());
        assert!(rank(&[MIDDLE]).spell() < rank(&[MIDDLE, 0x01]).spell());
    }

    #[test]
    fn what_is_not_a_key_is_refused() {
        assert_eq!(Rank::read(""), None, "nothing at all");
        assert_eq!(Rank::read("8"), None, "half a byte");
        assert_eq!(Rank::read("8g"), None, "not a digit");
        assert_eq!(
            Rank::read("8F"),
            None,
            "the other case is a second spelling"
        );
        assert_eq!(
            Rank::read("8000"),
            None,
            "a key with nothing between it and its neighbour"
        );
    }

    /// Any key at all, including the ones a generator would not produce.
    fn any_rank() -> impl Strategy<Value = Rank> {
        prop::collection::vec(any::<u8>(), 1..6).prop_map(|mut bytes| {
            if bytes.last() == Some(&0) {
                bytes.push(1);
            }
            Rank(bytes)
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// The whole contract, and it is stated on the entry points that carry
        /// the peer: that the bytes on the end leave the key where the fraction
        /// put it is the half a test would otherwise not reach.
        #[test]
        fn a_key_lands_between_whichever_ends_it_was_given(
            left in any_rank(),
            right in any_rank(),
            peer in any::<u64>(),
        ) {
            let (low, high) = if left < right { (&left, &right) } else { (&right, &left) };

            prop_assert!(Rank::between(None, low, peer).unwrap() < *low);
            prop_assert!(Rank::after(Some(high), peer) > *high);

            if low < high {
                let between = Rank::between(Some(low), high, peer).unwrap();
                prop_assert!(*low < between, "{between:?} is not above {low:?}");
                prop_assert!(between < *high, "{between:?} is not below {high:?}");
            } else {
                prop_assert_eq!(Rank::between(Some(low), high, peer), None);
            }
        }

        /// Every key a generator makes is one `read` would take back, which is
        /// the invariant the two halves of this module share.
        #[test]
        fn a_minted_key_is_one_the_reader_accepts(
            left in any_rank(),
            right in any_rank(),
            peer in any::<u64>(),
        ) {
            let (low, high) = if left < right { (&left, &right) } else { (&right, &left) };
            let minted = [
                Some(Rank::after(None, peer)),
                Some(Rank::after(Some(low), peer)),
                Rank::between(None, high, peer),
                Rank::between(Some(low), high, peer),
            ];

            for key in minted.into_iter().flatten() {
                let spelling = key.spell();
                prop_assert_eq!(Rank::read(&spelling), Some(key));
            }
        }

        /// Nesting: the gap can be filled again, and again, and the keys stay
        /// in the order they were made in.
        #[test]
        fn a_gap_can_be_filled_over_and_over(peer in any::<u64>()) {
            let mut low = Rank::after(None, peer);
            let mut high = Rank::after(Some(&low), peer);

            for round in 0..64 {
                let between = Rank::between(Some(&low), &high, peer)
                    .unwrap_or_else(|| panic!("round {round} had no room"));
                prop_assert!(low < between && between < high);
                if round % 2 == 0 { low = between; } else { high = between; }
            }
        }

        /// Two peers in one gap, for every gap rather than the one above.
        #[test]
        fn no_two_peers_mint_one_key(left in any_rank(), right in any_rank()) {
            prop_assume!(left < right);

            let ours = Rank::between(Some(&left), &right, OURS).unwrap();
            let theirs = Rank::between(Some(&left), &right, THEIRS).unwrap();

            prop_assert_ne!(ours, theirs);
        }

        /// What goes into a document has to come back, and come back in the
        /// same order — the spelling is where an order can quietly stop being
        /// one.
        #[test]
        fn a_key_survives_the_round_trip_through_its_spelling(
            left in any_rank(),
            right in any_rank(),
        ) {
            let spelling = left.spell();
            prop_assert_eq!(Rank::read(&spelling), Some(left.clone()));
            prop_assert_eq!(
                left.cmp(&right),
                left.spell().cmp(&right.spell()),
                "the spelling reordered them"
            );
        }
    }
}
