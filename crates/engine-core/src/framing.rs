//! Ring messages: a little-endian `u32` size of the rest, a one-byte kind, then that kind's record.

/// Size prefix included; anything bigger goes to the build thread as a device edit.
pub const MAX_MESSAGE: usize = 64 * 1024;

pub(crate) const SIZE_PREFIX: usize = size_of::<u32>();
const KIND: usize = 1;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Frame {
    /// Size prefix included.
    Whole(usize),
    Incomplete,
    /// Message boundaries are lost.
    TooLarge,
}

pub(crate) fn frame(bytes: &[u8]) -> Frame {
    let Some(prefix) = bytes.first_chunk::<SIZE_PREFIX>() else {
        return Frame::Incomplete;
    };
    // A `usize` holds any `u32` wherever the engine builds; compared before the sum, which could overflow in wasm32.
    let body = u32::from_le_bytes(*prefix) as usize;
    if body > MAX_MESSAGE - SIZE_PREFIX {
        return Frame::TooLarge;
    }
    match SIZE_PREFIX + body {
        size if size <= bytes.len() => Frame::Whole(size),
        _ => Frame::Incomplete,
    }
}

/// The kind and record of a whole message; `None` if it has no kind.
pub(crate) fn split(message: &[u8]) -> Option<(u8, &[u8])> {
    let (&kind, record) = message.get(SIZE_PREFIX..)?.split_first()?;
    Some((kind, record))
}

/// Writes a message at the start of `out` and returns its size; `None` if it doesn't fit.
pub(crate) fn write(out: &mut [u8], kind: u8, record: &[u8]) -> Option<usize> {
    let body = KIND + record.len();
    let message = out.get_mut(..SIZE_PREFIX + body)?;
    let (prefix, rest) = message.split_at_mut(SIZE_PREFIX);
    prefix.copy_from_slice(&u32::try_from(body).ok()?.to_le_bytes());
    rest[0] = kind;
    rest[KIND..].copy_from_slice(record);
    Some(SIZE_PREFIX + body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::commands::message;

    #[test]
    fn tells_whole_messages_from_parts() {
        assert_eq!(frame(&[]), Frame::Incomplete);
        assert_eq!(frame(&[2, 0, 0]), Frame::Incomplete);
        assert_eq!(frame(&[2, 0, 0, 0, 9]), Frame::Incomplete);
        assert_eq!(frame(&[2, 0, 0, 0, 9, 9, 7]), Frame::Whole(6));
    }

    #[test]
    fn a_size_beyond_the_limit_is_too_large_even_near_the_32_bit_limit() {
        let largest_body = u32::try_from(MAX_MESSAGE - SIZE_PREFIX).unwrap();
        assert_eq!(
            frame(&largest_body.to_le_bytes()),
            Frame::Incomplete,
            "the largest message is still waited for"
        );
        for body in [largest_body + 1, u32::MAX - 3, u32::MAX] {
            assert_eq!(frame(&body.to_le_bytes()), Frame::TooLarge, "body {body}");
        }
    }

    #[test]
    fn a_written_message_splits_into_its_kind_and_record() {
        let bytes = message(7, &[1, 2, 3]);
        assert_eq!(bytes, [4, 0, 0, 0, 7, 1, 2, 3]);
        assert_eq!(frame(&bytes), Frame::Whole(bytes.len()));
        assert_eq!(split(&bytes), Some((7, &[1, 2, 3][..])));
        assert_eq!(split(&[0, 0, 0, 0]), None);
    }

    #[test]
    fn a_message_that_does_not_fit_is_not_written() {
        let mut out = [0xaa; 7];
        assert_eq!(write(&mut out, 7, &[1, 2, 3]), None);
        assert_eq!(out, [0xaa; 7]);
    }
}
