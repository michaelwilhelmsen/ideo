//! Web-ready files out of a project (PRD §8, #31).
//!
//! Two halves and one seam between them: `plan` decides what to ask for and
//! `ffmpeg` finds something to ask, so every judgement about codecs and quality
//! is testable without an encoder and every question about which binary is in
//! use has exactly one place to live. Nothing outside this module ever spawns
//! ffmpeg — that is the "abstraction that does not care which ffmpeg it talks
//! to" PRD §8 asks for, and what keeps bundling one later a contained change.

pub mod ffmpeg;
pub mod plan;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Why an export produced nothing.
///
/// A reason rather than a sentence, so the refusal can be said in the user's
/// own language (PRD §10.4) — the same shape `ImportError` takes for the same
/// reason. `EncodeFailed` carries a detail because ffmpeg's own last words are
/// the only thing that distinguishes a codec this build lacks from a disk that
/// filled up, and neither is something we can phrase in advance.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ExportError {
    /// No ffmpeg on this machine. The one error with an action attached.
    FfmpegMissing,
    /// The candidate has no file — a paid result that never landed, or a
    /// generation the manifest knows about and the assets folder does not.
    NoAsset,
    /// An MP4 or WebM was asked of a still. A styled still exports its poster.
    NotAClip,
    /// Every format was switched off.
    NothingRequested,
    DestinationUnusable {
        message: String,
    },
    EncodeFailed {
        deliverable: String,
        detail: String,
    },
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExportError::FfmpegMissing => write!(f, "ffmpeg is not installed"),
            ExportError::NoAsset => write!(f, "that generation has no file"),
            ExportError::NotAClip => write!(f, "that generation is not a clip"),
            ExportError::NothingRequested => write!(f, "no formats were requested"),
            ExportError::DestinationUnusable { message } => {
                write!(f, "the destination could not be written to: {message}")
            }
            ExportError::EncodeFailed {
                deliverable,
                detail,
            } => write!(f, "the {deliverable} could not be encoded: {detail}"),
        }
    }
}
