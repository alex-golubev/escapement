//! Handles of nodes and of patterns: a cell of the object's table in the low 16 bits, the cell's generation above.
//! Whoever hands handles out moves a cell to its next generation when its object goes, so a handle kept from before
//! reaches nothing. The two kinds are apart, and so are their cells, so one never names the other.

macro_rules! handle {
    ($(#[$doc:meta])* $name:ident, $(#[$cell_doc:meta])* $cell:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub(crate) struct $name(u32);

        $(#[$cell_doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub(crate) struct $cell(u16);

        impl $name {
            pub(crate) const fn new(raw: u32) -> Self {
                Self(raw)
            }

            pub(crate) const fn cell(self) -> $cell {
                $cell((self.0 & 0xffff) as u16)
            }

            /// Cell 0 is no object: a field left out reads as 0.
            pub(crate) const fn is_none(self) -> bool {
                self.cell().0 == 0
            }
        }

        impl $cell {
            /// Its place in the table.
            pub(crate) fn index(self) -> usize {
                usize::from(self.0)
            }
        }
    };
}

handle!(
    /// A node's: its cell in the node table.
    NodeHandle,
    /// Of the node table.
    NodeCell
);

handle!(
    /// A pattern's: its cell in the pattern table, apart from the nodes'.
    PatternHandle,
    /// Of the pattern table.
    PatternCell
);

impl NodeHandle {
    /// As the page wrote it: what a record that names the node gives back.
    pub(crate) const fn raw(self) -> u32 {
        self.0
    }
}

impl PatternHandle {
    #[cfg(test)]
    pub(crate) const fn raw(self) -> u32 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cell_is_the_low_half_and_cell_0_is_no_node() {
        let handle = NodeHandle::new(3 << 16 | 7);
        assert_eq!(handle.cell().index(), 7);
        assert!(!handle.is_none());
        assert!(NodeHandle::new(0).is_none());
        assert!(NodeHandle::new(5 << 16).is_none());
        assert_eq!(
            NodeHandle::new(u32::MAX).cell().index(),
            usize::from(u16::MAX)
        );
    }
}
