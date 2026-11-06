//! Handles of nodes and of patterns: a cell of the object's table in the low 16 bits, the cell's generation above.
//! Whoever hands handles out moves a cell to its next generation when its object goes, so a handle kept from before
//! reaches nothing. The two kinds are apart, so one never names the other.

/// The last cell a handle can name.
pub const MAX_CELL: u32 = u16::MAX as u32;

macro_rules! handle {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub(crate) struct $name(u32);

        impl $name {
            pub const fn new(raw: u32) -> Self {
                Self(raw)
            }

            #[cfg(test)]
            pub const fn raw(self) -> u32 {
                self.0
            }

            pub const fn cell(self) -> u32 {
                self.0 & MAX_CELL
            }

            /// Cell 0 is no object: a field left out reads as 0.
            pub const fn is_none(self) -> bool {
                self.cell() == 0
            }
        }
    };
}

handle!(
    /// A node's: its cell in the node table.
    NodeHandle
);

handle!(
    /// A pattern's: its cell in the pattern table, apart from the nodes'.
    PatternHandle
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cell_is_the_low_half_and_cell_0_is_no_node() {
        let handle = NodeHandle::new(3 << 16 | 7);
        assert_eq!(handle.cell(), 7);
        assert!(!handle.is_none());
        assert!(NodeHandle::new(0).is_none());
        assert!(NodeHandle::new(5 << 16).is_none());
        assert_eq!(NodeHandle::new(u32::MAX).cell(), MAX_CELL);
    }
}
