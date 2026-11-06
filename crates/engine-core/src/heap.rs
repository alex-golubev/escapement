//! Heap call counting: the audio thread must never touch the heap.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

// Per thread: the build thread's calls are its own, and parallel tests count only theirs.
thread_local! {
    static CALLS: Cell<u32> = const { Cell::new(0) };
}

/// Here rather than in each build, so no build of the engine goes uncounted; a second allocator won't compile.
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// The system allocator, counting every call.
struct CountingAllocator;

fn count() {
    CALLS.set(CALLS.get().wrapping_add(1));
}

// Safety: every call goes to the system allocator unchanged.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count();
        unsafe { System.dealloc(ptr, layout) }
    }
}

/// Heap calls on this thread since it started; wraps around.
pub fn calls() -> u32 {
    CALLS.get()
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;

    use super::*;

    #[test]
    fn counts_allocating_and_freeing() {
        let before = calls();
        drop(black_box(vec![1u8; 8]));
        assert_eq!(calls().wrapping_sub(before), 2);
    }
}
