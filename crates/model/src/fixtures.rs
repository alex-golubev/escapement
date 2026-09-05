//! Test doubles the modules here share.

use crate::id::Entropy;

/// Names a test can write down: the next is the last plus one.
///
/// A real source is random, and a test naming an entity would have to mint one
/// first and then remember what came out. Nothing here tests randomness — what
/// is under test is that a name, once minted, is carried around unchanged.
#[derive(Default)]
pub struct Counter(u128);

impl Counter {
    pub const fn new() -> Self {
        Self(0)
    }
}

impl Entropy for Counter {
    fn next_u128(&mut self) -> u128 {
        // From one rather than from zero: zero is also what a field left
        // unwritten holds, and a test that passes either way says less.
        self.0 += 1;
        self.0
    }
}
