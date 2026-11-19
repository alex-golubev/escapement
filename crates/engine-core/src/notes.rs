//! What a note the engine plays may be.

use engine_plugins::NoteId;

use crate::schema::Rejection;

/// MIDI's: a key past it is refused.
pub const HIGHEST_KEY: u8 = 127;
/// A velocity past these is clamped.
pub const MIN_VELOCITY: f32 = 0.0;
pub const MAX_VELOCITY: f32 = 1.0;

/// Notes the page names lie below it; the pattern's take the rest, so the two never meet.
pub(crate) const PAGE_NOTES: u32 = 1 << 31;

/// A note the page names past [`PAGE_NOTES`] is refused.
pub(crate) fn page_note(note: u32) -> Result<NoteId, Rejection> {
    if note >= PAGE_NOTES {
        return Err(Rejection::InvalidValue);
    }
    Ok(NoteId::new(note))
}

/// The velocity a plugin gets for a note. A key past MIDI's or a velocity not a number is refused.
pub(crate) fn note_velocity(key: u8, velocity: f32) -> Result<f32, Rejection> {
    if key > HIGHEST_KEY || !velocity.is_finite() {
        return Err(Rejection::InvalidValue);
    }
    Ok(velocity.clamp(MIN_VELOCITY, MAX_VELOCITY))
}
