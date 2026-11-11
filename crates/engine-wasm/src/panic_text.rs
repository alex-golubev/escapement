//! What a panic said, kept for the thread that panicked: with `panic = "abort"` the page would hear only `unreachable`.

use std::cell::RefCell;
use std::fmt::{self, Write};
use std::panic::{self, PanicHookInfo};
use std::sync::Once;

/// Room for the text, mirrored in `packages/engine/src/panic-text.ts`.
pub const PANIC_TEXT_BYTES: usize = 512;

/// Ends a text cut short.
const CUT: &[u8] = b"...";

/// Its length in bytes, then the text: printable ASCII only, so it is one line and each byte a character — the
/// worklet has no `TextDecoder`.
#[repr(C)]
pub struct PanicText {
    len: u32,
    bytes: [u8; PANIC_TEXT_BYTES],
}

thread_local! {
    // Each thread's own: two threads that both panic keep their own texts.
    static TEXT: RefCell<PanicText> = const { RefCell::new(PanicText::EMPTY) };
}

impl PanicText {
    const EMPTY: Self = Self {
        len: 0,
        bytes: [0; PANIC_TEXT_BYTES],
    };

    /// In place of anything before; cut short with [`CUT`] if it doesn't fit.
    fn set(&mut self, text: fmt::Arguments<'_>) {
        self.len = 0;
        if self.write_fmt(text).is_err() {
            let at = (self.len as usize).min(PANIC_TEXT_BYTES - CUT.len());
            self.bytes[at..at + CUT.len()].copy_from_slice(CUT);
            self.len = (at + CUT.len()) as u32;
        }
    }

    /// `panicked at file:line:column: message`.
    fn keep(&mut self, info: &PanicHookInfo<'_>) {
        match (info.location(), info.payload_as_str()) {
            (Some(location), Some(message)) => {
                self.set(format_args!("panicked at {location}: {message}"));
            }
            (Some(location), None) => self.set(format_args!("panicked at {location}")),
            (None, Some(message)) => self.set(format_args!("panicked: {message}")),
            (None, None) => self.set(format_args!("panicked")),
        }
    }
}

impl Write for PanicText {
    /// Printable ASCII as it is, any other character as its escape (`\n`, `\u{436}`), and an escape only whole: a cut
    /// one would read as something else.
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for c in s.chars() {
            let start = self.len as usize;
            let written = if matches!(c, ' '..='~') {
                *self.bytes.get_mut(start).ok_or(fmt::Error)? = c as u8;
                1
            } else {
                let escape = c.escape_default();
                let room = self
                    .bytes
                    .get_mut(start..start + escape.len())
                    .ok_or(fmt::Error)?;
                room.iter_mut()
                    .zip(escape)
                    .for_each(|(byte, c)| *byte = c as u8);
                room.len()
            };
            self.len += written as u32;
        }
        Ok(())
    }
}

fn keep(info: &PanicHookInfo<'_>) {
    TEXT.with_borrow_mut(|text| text.keep(info));
}

/// Once per memory: the hook is kept there, so it is the one of every thread on it. With a hook of its own, std
/// formats a panic's message on the heap before calling it, on the audio thread too: that thread dies anyway, and
/// waits only while the build thread holds the allocator's lock.
pub fn install() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| panic::set_hook(Box::new(keep)));
}

/// This thread's text, empty until it panics; read by the thread's own JavaScript after the trap.
#[unsafe(no_mangle)]
pub extern "C" fn engine_panic_text() -> *mut PanicText {
    TEXT.with(RefCell::as_ptr)
}

#[cfg(test)]
mod tests {
    use super::*;

    impl PanicText {
        fn as_str(&self) -> &str {
            str::from_utf8(&self.bytes[..self.len as usize]).unwrap()
        }
    }

    /// The text the hook keeps; a failed assertion is still reported as usual.
    fn panicked(panic: impl FnOnce() + panic::UnwindSafe) -> String {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let usual = panic::take_hook();
            panic::set_hook(Box::new(move |info| {
                keep(info);
                usual(info);
            }));
        });
        assert!(panic::catch_unwind(panic).is_err());
        TEXT.with_borrow(|text| text.as_str().to_owned())
    }

    fn set(text: fmt::Arguments<'_>) -> String {
        let mut kept = PanicText::EMPTY;
        kept.set(text);
        kept.as_str().to_owned()
    }

    #[test]
    fn a_panic_leaves_where_it_was_and_what_it_said() {
        let line = line!() + 1;
        let text = panicked(|| panic!("PanicAudio {}", 3));
        assert!(
            text.starts_with(&format!("panicked at {}:{line}:", file!())),
            "{text}"
        );
        assert!(text.ends_with(": PanicAudio 3"), "{text}");
    }

    #[test]
    fn each_panic_replaces_the_text_before() {
        panicked(|| panic!("a long first message"));
        assert!(panicked(|| panic!("second")).ends_with(": second"));
    }

    #[test]
    fn anything_but_printable_ascii_is_escaped_onto_one_line() {
        assert_eq!(
            set(format_args!("left: 1\n\tж '\"\\")),
            r#"left: 1\n\t\u{436} '"\"#
        );
    }

    #[test]
    fn a_long_text_is_cut_short_where_it_says_so_and_never_inside_an_escape() {
        let room = "a".repeat(PANIC_TEXT_BYTES);
        assert_eq!(set(format_args!("{room}")), room);
        let before = &room[..PANIC_TEXT_BYTES - 5];
        assert_eq!(set(format_args!("{before}ж")), format!("{before}..."));
        assert_eq!(
            set(format_args!("{room}b")),
            format!("{}...", &room[..PANIC_TEXT_BYTES - CUT.len()])
        );
    }
}
