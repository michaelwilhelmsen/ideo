//! Putting an input image somewhere fal can fetch it (#50).
//!
//! Replaces the inline base64 data URI that `image_input` used to build. That
//! transfer worked and was the one `models-gaps.md` §4 could confirm, but it
//! put the image *inside* the submit body — so a seamless loop, which names the
//! same still as both first and last frame, carried it twice. A styled PNG made
//! that body ~13 MB and the submit timed out before fal answered.
//!
//! ## Which of the two flows this is
//!
//! fal's own clients disagree, and both are real. The Python client takes a
//! short-lived bearer token from `/storage/auth/token` and posts the file to
//! `{base_url}/files/upload`. The JavaScript client asks
//! `/storage/upload/initiate` for a pair of URLs and PUTs the bytes at one of
//! them. This is the JavaScript flow, for two reasons: it needs no token
//! lifecycle — nothing to cache, expire, or renew mid-run — and it
//! authenticates with the same `Key {key}` header as every other call in this
//! codebase, so there is one auth scheme here rather than two.
//!
//! `models-gaps.md` §4 called this path "alternate/older". It is neither: it is
//! what the current JS client does. What that note had *wrong* mattered more —
//! it gave the host as `rest.alpha.fal.ai` (it is `rest.fal.ai`), a hardcoded
//! `Bearer` scheme, and no response field names. Verified 2026-08-09 against
//! `fal-ai/fal-js` and `fal-ai/fal` at source.

use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use super::fal::{client, GenerationError, GenerationErrorReason};
use crate::projects::import::sniff_format;

/// fal's REST host — not the queue host the rest of `fal.rs` talks to.
const REST_URL: &str = "https://rest.fal.ai";

/// The storage backend the initiate endpoint is asked for by name. Both of
/// fal's own clients pass this, and neither documents a default.
const STORAGE_TYPE: &str = "fal-cdn-v3";

/// Generous next to the queue's own 30s: this call carries the whole file, and
/// being slower than a submit is the entire point of moving the bytes out of
/// one. Still bounded — a stalled upload should fail rather than hang a run.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Where fal will serve the file from, and where to put it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UploadTicket {
    /// The public URL to hand the model. Usable only once the PUT succeeds.
    pub file_url: String,
    /// The one-shot destination for the bytes.
    pub upload_url: String,
}

fn initiate_url() -> String {
    format!("{REST_URL}/storage/upload/initiate?storage_type={STORAGE_TYPE}")
}

/// The two URLs, or a refusal naming what was missing.
///
/// Parsed strictly. A ticket with no `upload_url` would otherwise PUT into the
/// empty string, and one with no `file_url` would hand the model nothing to
/// fetch — both of which surface far from here, as a model failure rather than
/// an upload one.
fn parse_ticket(body: &str) -> Result<UploadTicket, GenerationError> {
    serde_json::from_str::<UploadTicket>(body).map_err(|e| {
        log::error!("fal's upload ticket was not the shape we expect: {e}");
        GenerationError::new(GenerationErrorReason::UploadFailed)
    })
}

/// Puts one image where fal can fetch it, and answers with the URL to send.
///
/// Two calls: ask for a destination, then PUT the bytes at it. The second one
/// deliberately carries **no** `Authorization` header — `upload_url` is already
/// a signed, single-purpose URL, and adding our key to it is at best redundant
/// and at worst a signature mismatch on whichever bucket is behind it. Only the
/// `Content-Type` goes, exactly as fal's own client sends it.
pub async fn upload(key: &str, bytes: Vec<u8>, file_name: &str) -> Result<String, GenerationError> {
    // Sniffed from the bytes rather than the name, as everything else here
    // does: a `.png` holding a JPEG would be announced as something it is not,
    // and the content type is what the CDN will serve it back as.
    let content_type = sniff_format(&bytes)
        .map(|format| format.mime())
        .unwrap_or("application/octet-stream");

    let http = client(UPLOAD_TIMEOUT)?;

    let response = http
        .post(initiate_url())
        .header("Authorization", format!("Key {key}"))
        .json(&json!({ "content_type": content_type, "file_name": file_name }))
        .send()
        .await
        .map_err(|e| failed("Could not ask fal where to put the input image", &e))?;

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !super::fal::is_accepted(status) {
        log::error!("fal refused to start an upload ({status}): {body}");
        return Err(GenerationError::new(GenerationErrorReason::UploadFailed));
    }

    let ticket = parse_ticket(&body)?;
    let size = bytes.len();

    let put = http
        .put(&ticket.upload_url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| failed("Could not upload the input image", &e))?;

    let put_status = put.status().as_u16();
    if !super::fal::is_accepted(put_status) {
        let detail = put.text().await.unwrap_or_default();
        log::error!("The input image upload was rejected ({put_status}): {detail}");
        return Err(GenerationError::new(GenerationErrorReason::UploadFailed));
    }

    log::info!("Uploaded {size} B of input image to {}", ticket.file_url);
    Ok(ticket.file_url)
}

/// An upload that never got an answer.
///
/// Separate from `fal.rs`'s `offline` so the reason stays `UploadFailed`: this
/// happens before anything is submitted, so unlike a failed poll it costs
/// nothing to retry, and telling the user to check their connection when the
/// queue was never asked would be pointing at the wrong thing.
fn failed(context: &str, e: &reqwest::Error) -> GenerationError {
    log::warn!("{context}: {e}");
    GenerationError::new(GenerationErrorReason::UploadFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_yields_the_place_to_put_it_and_the_place_to_read_it() {
        let body = r#"{
            "file_url": "https://v3.fal.media/files/panda/abc_hero.jpg",
            "upload_url": "https://storage.googleapis.com/isolate-dev/abc?signature=xyz"
        }"#;

        assert_eq!(
            parse_ticket(body).expect("a well-formed ticket parses"),
            UploadTicket {
                file_url: "https://v3.fal.media/files/panda/abc_hero.jpg".into(),
                upload_url: "https://storage.googleapis.com/isolate-dev/abc?signature=xyz".into(),
            }
        );
    }

    #[test]
    fn a_ticket_missing_half_of_itself_is_refused_here_not_downstream() {
        let body = r#"{"file_url": "https://v3.fal.media/files/panda/abc_hero.jpg"}"#;

        assert_eq!(
            parse_ticket(body).unwrap_err().reason,
            GenerationErrorReason::UploadFailed
        );
    }

    #[test]
    fn the_initiate_call_names_the_storage_backend() {
        assert_eq!(
            initiate_url(),
            "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"
        );
    }
}
