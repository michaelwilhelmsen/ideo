//! The fal.ai queue client: submit → poll → fetch, plus cancel.
//!
//! The whole exchange happens in Rust so the API key never reaches the webview
//! (PRD §3.1), and because a queued job the user has already been charged for
//! is easier to nurse from here than from a hook.
//!
//! This module knows how to *talk to* the queue and nothing about what is in
//! flight — no database, no app handle, no loop. The lifecycle is `runner`,
//! which is what lets a resumed job and a fresh one share every line below.
//!
//! Started as the tracer bullet (#22): one model, one size. #23 gave it a
//! project to file the result under; #24 took the loop out of it. The model is
//! still hardcoded until #25.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::time::Duration;

const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);
pub const POLL_TIMEOUT: Duration = Duration::from_secs(30);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Whether an endpoint id is safe to put in a URL.
///
/// Deliberately not an allowlist of models — that list lives in the TypeScript
/// registry (PRD §5), which is also what builds the parameters, and duplicating
/// it here would give two places to forget to update. What Rust owns is the
/// part TypeScript cannot vouch for: the id becomes a URL path, so anything
/// that could climb out of it (`..`, a scheme, a query, whitespace) is refused
/// before a request is made, whatever sent it.
pub fn validate_model_id(id: &str) -> Result<(), GenerationError> {
    let reject = |why: &str| {
        Err(GenerationError::with_detail(
            GenerationErrorReason::RequestRejected,
            format!("{why}: {id:?}"),
        ))
    };

    if id.is_empty() {
        return reject("no model was named");
    }
    if id.len() > 128 {
        return reject("model id is implausibly long");
    }
    if id.starts_with('/') || id.ends_with('/') || id.contains("//") {
        return reject("model id has an empty path segment");
    }
    if id
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return reject("model id traverses its own path");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    {
        return reject("model id has characters that do not belong in a path");
    }

    Ok(())
}

/// Where a submitted job has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QueueStatus {
    Queued,
    Running,
    Completed,
}

/// Progress event payload. Emitted on every poll so the UI can say something
/// truthful while waiting.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProgress {
    pub request_id: String,
    pub project_id: String,
    pub generation_id: String,
    pub status: QueueStatus,
    /// Position in fal's queue, when it tells us.
    pub queue_position: Option<u32>,
    pub elapsed_ms: u32,
}

/// Why a generation did not produce an image.
///
/// A reason rather than a sentence: the sentence belongs in the locale files,
/// and the frontend is the only place that knows what language to say it in.
/// Same shape as `KeyCheck` in `api_key.rs` — unit enum plus optional detail —
/// so the frontend switches on one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GenerationErrorReason {
    /// Nothing was typed.
    EmptyPrompt,
    /// The stage had no usable input image (#28) — none was named, the file is
    /// not on disk, or it is too large to inline. `input_image` says which.
    ///
    /// A reason of its own rather than a `RequestRejected`, because fal never
    /// saw this one: it is refused here, before the key is fetched and before
    /// anything is charged. The Nano Banana edit endpoints do not require their
    /// image field, so the alternative is a paid text-to-image nobody asked for.
    InputImageUnusable,
    /// No key in the keychain — Settings first.
    NoApiKey,
    /// fal refused the key.
    KeyRejected,
    /// fal refused the request itself; `detail` says why.
    RequestRejected,
    /// Too many requests on this key.
    RateLimited,
    /// The call never reached fal.
    Offline,
    /// The input image could not be put where fal could fetch it (#50).
    ///
    /// Its own reason rather than an `Offline` or a `RequestRejected`, because
    /// it is the one failure that happens *before* the queue is ever asked and
    /// is therefore free: nothing has been submitted and nothing charged, and a
    /// retry costs the user an upload rather than a generation.
    UploadFailed,
    /// fal reported the job itself as failed.
    JobFailed,
    /// We stopped waiting. The job may still finish on fal's side.
    GaveUpWaiting,
    /// The image arrived but could not be written to disk.
    CouldNotSave,
    /// Anything else, with the status attached.
    Unexpected,
}

/// What was wrong with a stage's input image (#28).
///
/// A code, plus the numbers the sentence needs, rather than the sentence: this
/// refusal is ours rather than fal's — it happens before the request exists — so
/// unlike `detail` there is nobody to quote, and an English sentence built here
/// is one the user's locale can never translate (PRD §10.4). The frontend maps
/// each code to a key in `locales/`. Technical particulars stay on this side, in
/// the log, per `docs/developer/error-handling.md`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum InputImageProblem {
    /// No input generation was named at all — a restyle with nothing to restyle.
    NoneNamed,
    /// The generation is named but has no file in the project's assets folder.
    NotOnDisk,
    /// The file is there and could not be read, or holds nothing.
    Unreadable,
    /// Not a PNG, JPEG or WebP, whatever its extension claims.
    UnsupportedFormat,
    /// Over the ceiling on an inlined image, in bytes.
    TooLarge { bytes: f64, limit: f64 },
    /// The registry named no field to put the image in.
    NoField,
}

/// A failure, as it crosses to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GenerationError {
    pub reason: GenerationErrorReason,
    /// Text fal supplied about this specific failure, when there was any.
    pub detail: Option<String>,
    /// HTTP status, for `Unexpected`.
    pub status: Option<u16>,
    /// Which input-image problem it was, when `reason` is `InputImageUnusable`.
    pub input_image: Option<InputImageProblem>,
}

impl GenerationError {
    pub fn new(reason: GenerationErrorReason) -> Self {
        Self {
            reason,
            detail: None,
            status: None,
            input_image: None,
        }
    }

    pub fn with_detail(reason: GenerationErrorReason, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(reason)
        }
    }

    /// The one refusal fal never sees, and therefore never supplies words for.
    pub fn unusable_input(problem: InputImageProblem) -> Self {
        Self {
            input_image: Some(problem),
            ..Self::new(GenerationErrorReason::InputImageUnusable)
        }
    }
}

/// The URLs fal hands back on submit. Never construct these — the spike found
/// the versioned forms we'd build ourselves return 405 (PRD §12).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Submitted {
    pub request_id: String,
    pub status_url: String,
    pub response_url: String,
    /// Optional only in the type: it is what makes cancellation possible, and a
    /// job submitted by a build that did not record it is still watchable.
    pub cancel_url: Option<String>,
}

/// One answer from the status endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct PollState {
    pub status: QueueStatus,
    pub queue_position: Option<u32>,
}

/// Which medium a finished job produced.
///
/// Not cosmetic: it decides the extension a result with no usable one in its
/// URL is saved under, and an `.mp4` filed as `.jpeg` is a file nothing in the
/// app can play and nothing on the desktop can open (#29).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultKind {
    Image,
    Video,
}

/// What the queue produced, before it becomes a file.
///
/// `asset_url` rather than `image_url` since #29: the animate stage returns a
/// clip under `video.url`, and a field called `image_url` holding an `.mp4` is
/// the kind of name that survives until somebody trusts it.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueResult {
    pub asset_url: String,
    pub seed: Option<u64>,
    pub kind: ResultKind,
}

pub fn client(timeout: Duration) -> Result<reqwest::Client, GenerationError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| {
            log::error!("Could not build the HTTP client: {e}");
            GenerationError::new(GenerationErrorReason::Offline)
        })
}

/// Puts a job on the queue. The charge lands here, which is why the caller
/// writes the returned ids down before it polls (PRD §3.3).
///
/// `params` is the registry's work, arriving whole: `image_size` or
/// `aspect_ratio`, a seed only on a model that has one, a duration in that
/// model's own primitive. Rust does not interpret it — every one of those
/// choices needs the capability table to make, and there is exactly one of
/// those, in TypeScript. What happens here is that `prompt` is put in
/// afterwards, so no parameter set can quietly replace the thing the user
/// typed and the emptiness check just passed.
pub async fn submit(
    key: &str,
    model_id: &str,
    prompt: &str,
    params: &Value,
) -> Result<Submitted, GenerationError> {
    validate_model_id(model_id)?;

    let mut body = match params {
        Value::Object(fields) => Value::Object(fields.clone()),
        _ => {
            return Err(GenerationError::with_detail(
                GenerationErrorReason::RequestRejected,
                "model parameters were not an object",
            ))
        }
    };
    body["prompt"] = json!(prompt);

    // Serialised here rather than by `.json()` so the size can be logged. An
    // inlined image is the bulk of it and a looping animate run carries the same
    // one twice (#30), so "how big was the body we just failed to send" is the
    // first question worth answering about a transport failure, and it is
    // unanswerable after the fact.
    let payload = serde_json::to_vec(&body).map_err(|e| {
        log::error!("Could not encode the request body: {e}");
        GenerationError::new(GenerationErrorReason::Unexpected)
    })?;

    log::info!(
        "Submitting to {model_id} with a {} KB body",
        payload.len() / 1024
    );

    let response = client(SUBMIT_TIMEOUT)?
        .post(format!("https://queue.fal.run/{model_id}"))
        .header("Authorization", format!("Key {key}"))
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| offline("Could not submit the generation", &e))?;

    let status = response.status().as_u16();
    if !is_accepted(status) {
        let body = response.text().await.unwrap_or_default();
        log::error!("fal.ai refused the submit with status {status}: {body}");
        return Err(fal_error(status, &body));
    }

    response.json::<Submitted>().await.map_err(|e| {
        log::error!("Could not read fal.ai's submit response: {e}");
        GenerationError::new(GenerationErrorReason::Unexpected)
    })
}

/// Asks where a job has got to. One question, no loop — the loop belongs to
/// whoever is allowed to stop it.
pub async fn poll(
    client: &reqwest::Client,
    key: &str,
    status_url: &str,
) -> Result<PollState, GenerationError> {
    let response = client
        .get(status_url)
        .header("Authorization", format!("Key {key}"))
        .send()
        .await
        .map_err(|e| offline("Could not read job status", &e))?;

    let status_code = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    if !is_accepted(status_code) {
        log::error!("fal.ai status check failed with {status_code}: {body}");
        return Err(fal_error(status_code, &body));
    }

    let payload: Value = serde_json::from_str(&body).map_err(|e| {
        log::error!("Could not parse the status response: {e}");
        GenerationError::new(GenerationErrorReason::Unexpected)
    })?;

    if let Some(failure) = terminal_error(&payload) {
        return Err(failure);
    }

    Ok(PollState {
        status: parse_queue_status(payload.get("status").and_then(Value::as_str).unwrap_or("")),
        queue_position: payload
            .get("queue_position")
            .and_then(Value::as_u64)
            .map(|p| p as u32),
    })
}

pub async fn fetch_result(
    client: &reqwest::Client,
    key: &str,
    response_url: &str,
) -> Result<QueueResult, GenerationError> {
    let response = client
        .get(response_url)
        .header("Authorization", format!("Key {key}"))
        .send()
        .await
        .map_err(|e| offline("Could not fetch the finished result", &e))?;

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    if !is_accepted(status) {
        log::error!("fal.ai result fetch failed with {status}: {body}");
        return Err(fal_error(status, &body));
    }

    let payload: Value = serde_json::from_str(&body).map_err(|e| {
        log::error!("Could not parse the result payload: {e}");
        GenerationError::new(GenerationErrorReason::Unexpected)
    })?;

    extract_result(&payload)
}

/// Asks fal to stop a job (PRD §3.3).
///
/// Best-effort by nature: a job far enough along cannot be stopped, and fal
/// says so with a 4xx. That is not a failure the user needs to see — what
/// stops locally is that we no longer watch it — so this only reports whether
/// fal accepted, and nothing anywhere promises a refund.
pub async fn cancel(key: &str, cancel_url: &str) -> Result<bool, GenerationError> {
    let response = client(CANCEL_TIMEOUT)?
        .put(cancel_url)
        .header("Authorization", format!("Key {key}"))
        .send()
        .await
        .map_err(|e| offline("Could not reach fal to cancel", &e))?;

    let status = response.status().as_u16();
    if status == 200 {
        return Ok(true);
    }

    let body = response.text().await.unwrap_or_default();
    log::info!("fal.ai would not cancel the job ({status}): {body}");
    Ok(false)
}

/// Downloads a finished image or clip. No auth header — the media host doesn't
/// need one, and the key has no business being sent there.
pub async fn download(asset_url: &str) -> Result<Vec<u8>, GenerationError> {
    let bytes = client(DOWNLOAD_TIMEOUT)?
        .get(asset_url)
        .send()
        .await
        .map_err(|e| {
            log::warn!("Could not download the generated asset: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?
        .bytes()
        .await
        .map_err(|e| {
            log::error!("Could not read the asset bytes: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?;

    Ok(bytes.to_vec())
}

/// The extension a saved file should carry, from the URL fal produced.
///
/// The fallback is per medium since #29. A URL with no usable extension is rare
/// but real — a signed or query-suffixed one, which the alphanumeric filter
/// below rejects on purpose — and defaulting a clip to `jpeg` produces a file
/// the `<video>` element will not play and Finder will not preview.
pub fn extension_for(asset_url: &str, kind: ResultKind) -> &str {
    asset_url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.rsplit_once('.'))
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or(match kind {
            ResultKind::Image => "jpeg",
            ResultKind::Video => "mp4",
        })
}

/// Maps fal's queue states. Anything unrecognised counts as still running: the
/// user has already paid for this job, so a new state name is a reason to keep
/// waiting, not to throw the result away.
fn parse_queue_status(raw: &str) -> QueueStatus {
    match raw {
        "IN_QUEUE" => QueueStatus::Queued,
        "COMPLETED" => QueueStatus::Completed,
        _ => QueueStatus::Running,
    }
}

/// Pulls the parts of a result payload this slice needs.
///
/// Two shapes, because the two media are two shapes: an image endpoint answers
/// with `images: [{url}]` and a video endpoint with `video: {url}` — a single
/// object, not an array, since one call produces one clip. The video is read
/// first so a payload carrying both (a model returning a preview still
/// alongside its clip) files the clip, which is what was paid for.
fn extract_result(payload: &Value) -> Result<QueueResult, GenerationError> {
    let seed = payload.get("seed").and_then(Value::as_u64);

    if let Some(video) = payload.get("video") {
        let url = video.get("url").and_then(Value::as_str).ok_or_else(|| {
            GenerationError::with_detail(GenerationErrorReason::JobFailed, "video had no URL")
        })?;

        return Ok(QueueResult {
            asset_url: url.to_string(),
            seed,
            kind: ResultKind::Video,
        });
    }

    let image = payload
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .ok_or_else(|| {
            GenerationError::with_detail(
                GenerationErrorReason::JobFailed,
                "no image or video returned",
            )
        })?;

    let image_url = image.get("url").and_then(Value::as_str).ok_or_else(|| {
        GenerationError::with_detail(GenerationErrorReason::JobFailed, "image had no URL")
    })?;

    Ok(QueueResult {
        asset_url: image_url.to_string(),
        seed,
        kind: ResultKind::Image,
    })
}

/// Whether fal's answer means "taken", whichever call asked.
///
/// Any 2xx, not `== 200`, and the difference is the whole queue. **Submit
/// answers `202 Accepted`** — the point of a queue is that it accepts work
/// rather than doing it — so a 200-only check rejects every generation at the
/// first step and reports the acceptance itself as an unexpected error, which
/// is what it did until 2026-08-09. Nothing downstream needs the distinction:
/// a submit is read for its ids and a poll for its `status` field, and both
/// are there on any answer fal calls successful.
pub(super) fn is_accepted(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Classifies any non-2xx answer from fal, whichever call produced it.
fn fal_error(status: u16, body: &str) -> GenerationError {
    match status {
        401 | 403 => GenerationError::new(GenerationErrorReason::KeyRejected),
        422 => {
            // fal returns FastAPI-shaped validation errors; the message is the
            // only part worth passing on.
            let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| {
                v.get("detail")
                    .and_then(Value::as_array)
                    .and_then(|d| d.first())
                    .and_then(|d| d.get("msg"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });

            GenerationError {
                detail,
                ..GenerationError::new(GenerationErrorReason::RequestRejected)
            }
        }
        429 => GenerationError::new(GenerationErrorReason::RateLimited),
        other => GenerationError {
            status: Some(other),
            ..GenerationError::new(GenerationErrorReason::Unexpected)
        },
    }
}

/// A status payload carrying an `error` is a job that died, not one still
/// running. Without this an already-failed job would be polled until the
/// wait ceiling and then reported as merely slow.
fn terminal_error(payload: &Value) -> Option<GenerationError> {
    let error = payload.get("error")?;

    if error.is_null() {
        return None;
    }

    let detail = error
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            payload
                .get("error_type")
                .and_then(Value::as_str)
                .map(str::to_string)
        });

    Some(match detail {
        Some(detail) => GenerationError::with_detail(GenerationErrorReason::JobFailed, detail),
        None => GenerationError::new(GenerationErrorReason::JobFailed),
    })
}

fn offline(context: &str, e: &reqwest::Error) -> GenerationError {
    let kind = transport_kind(e);
    log::warn!("{context}: {kind} ({e})");
    GenerationError::new(GenerationErrorReason::Offline)
}

/// Which transport failure this was, in words.
///
/// reqwest says `error sending request for url (…)` for a timeout, a refused
/// connection and a body that died halfway alike — one Display for three
/// problems with three different fixes. A submit that times out on a 13 MB
/// inlined payload is a size problem and wants the upload endpoint
/// (`models-gaps.md` §4); a refused connection is the user's network and wants
/// nothing from us. Guessing between them from the log is how the wrong one
/// gets fixed, so the distinction reqwest keeps in its flags is named here.
fn transport_kind(e: &reqwest::Error) -> &'static str {
    classify_transport(e.is_timeout(), e.is_connect(), e.is_body())
}

fn classify_transport(timeout: bool, connect: bool, body: bool) -> &'static str {
    match (timeout, connect, body) {
        (true, _, _) => "timed out",
        (_, true, _) => "could not open a connection",
        (_, _, true) => "died while sending the body",
        _ => "failed in transport",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_states_map_to_progress() {
        assert_eq!(parse_queue_status("IN_QUEUE"), QueueStatus::Queued);
        assert_eq!(parse_queue_status("IN_PROGRESS"), QueueStatus::Running);
        assert_eq!(parse_queue_status("COMPLETED"), QueueStatus::Completed);
    }

    #[test]
    fn an_unknown_queue_state_keeps_polling_rather_than_failing() {
        // A state we don't recognise is not evidence the job died, and the user
        // has already been charged for it.
        assert_eq!(parse_queue_status("SOMETHING_NEW"), QueueStatus::Running);
    }

    #[test]
    fn result_yields_the_image_url_and_the_seed() {
        let payload = json!({
            "images": [{ "url": "https://v3.fal.media/files/x/out.jpeg", "width": 1280, "height": 704 }],
            "seed": 1234567890_u64,
        });

        let result = extract_result(&payload).unwrap();

        assert_eq!(result.asset_url, "https://v3.fal.media/files/x/out.jpeg");
        assert_eq!(result.seed, Some(1234567890));
        assert_eq!(result.kind, ResultKind::Image);
    }

    #[test]
    fn a_video_endpoint_answers_with_one_object_rather_than_an_array() {
        // #29 — every image-to-video endpoint surveyed returns `video: {url}`,
        // not `images: [...]`. Reading only the array would have reported every
        // paid clip as a job that produced nothing.
        let payload = json!({
            "video": { "url": "https://v3.fal.media/files/x/out.mp4" },
            "seed": 7_u64,
        });

        let result = extract_result(&payload).unwrap();

        assert_eq!(result.asset_url, "https://v3.fal.media/files/x/out.mp4");
        assert_eq!(result.seed, Some(7));
        assert_eq!(result.kind, ResultKind::Video);
    }

    #[test]
    fn a_payload_carrying_both_files_the_clip_that_was_paid_for() {
        let payload = json!({
            "video": { "url": "https://v3.fal.media/files/x/out.mp4" },
            "images": [{ "url": "https://v3.fal.media/files/x/preview.jpeg" }],
        });

        assert_eq!(extract_result(&payload).unwrap().kind, ResultKind::Video);
    }

    #[test]
    fn a_video_result_with_no_url_is_a_failure_and_not_a_fallback_to_the_still() {
        // Falling through to a preview image here would file a still under the
        // generation the user paid for a clip for, and nothing on screen would
        // say which they had got.
        let payload = json!({
            "video": { "duration": 5 },
            "images": [{ "url": "https://v3.fal.media/files/x/preview.jpeg" }],
        });

        assert_eq!(
            extract_result(&payload).unwrap_err().reason,
            GenerationErrorReason::JobFailed
        );
    }

    #[test]
    fn a_missing_seed_is_not_fatal() {
        let payload = json!({ "images": [{ "url": "https://v3.fal.media/files/x/out.jpeg" }] });

        assert_eq!(extract_result(&payload).unwrap().seed, None);
    }

    #[test]
    fn a_result_with_no_images_is_an_error_not_an_empty_success() {
        let payload = json!({ "images": [], "seed": 1 });

        assert_eq!(
            extract_result(&payload).unwrap_err().reason,
            GenerationErrorReason::JobFailed
        );
    }

    #[test]
    fn a_rejected_key_is_named_as_such_not_left_as_a_status_code() {
        assert_eq!(
            fal_error(401, "").reason,
            GenerationErrorReason::KeyRejected
        );
    }

    #[test]
    fn a_rejected_prompt_carries_what_the_api_objected_to() {
        let body = r#"{"detail":[{"loc":["body","prompt"],"msg":"field required"}]}"#;

        let error = fal_error(422, body);

        assert_eq!(error.reason, GenerationErrorReason::RequestRejected);
        assert_eq!(error.detail.as_deref(), Some("field required"));
    }

    #[test]
    fn a_queued_submit_is_a_success_not_an_error() {
        // The bug this exists to prevent: fal's submit answers `202 Accepted`,
        // and a 200-only check turned every generation into
        // "unexpected error (status 202)" before anything was even queued.
        assert!(is_accepted(202));
        assert!(is_accepted(200));
    }

    #[test]
    fn a_refusal_is_still_a_refusal() {
        assert!(!is_accepted(401));
        assert!(!is_accepted(422));
        assert!(!is_accepted(500));
        // A redirect is not an acceptance — fal does not issue one, and reading
        // a 3xx body for request ids would find nothing.
        assert!(!is_accepted(302));
    }

    #[test]
    fn a_transport_failure_is_named_rather_than_left_as_one_sentence() {
        // reqwest's Display is the same line for all of these, which is what
        // made a 13 MB submit indistinguishable from an unplugged cable.
        assert_eq!(classify_transport(true, false, false), "timed out");
        assert_eq!(
            classify_transport(false, true, false),
            "could not open a connection"
        );
        assert_eq!(
            classify_transport(false, false, true),
            "died while sending the body"
        );
        assert_eq!(
            classify_transport(false, false, false),
            "failed in transport"
        );
        // A timeout that reqwest also flags as a body failure is still a
        // timeout — the deadline is the thing worth acting on.
        assert_eq!(classify_transport(true, false, true), "timed out");
    }

    #[test]
    fn an_unhandled_status_keeps_the_code_for_the_message() {
        let error = fal_error(503, "upstream down");

        assert_eq!(error.reason, GenerationErrorReason::Unexpected);
        assert_eq!(error.status, Some(503));
    }

    #[test]
    fn a_job_fal_reports_as_failed_stops_the_poll_immediately() {
        let payload = json!({ "status": "IN_PROGRESS", "error": { "message": "content policy" } });

        let error = terminal_error(&payload).expect("a failed job is terminal");

        assert_eq!(error.reason, GenerationErrorReason::JobFailed);
        assert_eq!(error.detail.as_deref(), Some("content policy"));
    }

    #[test]
    fn a_healthy_status_payload_is_not_treated_as_a_failure() {
        assert!(terminal_error(&json!({ "status": "IN_QUEUE", "queue_position": 2 })).is_none());
        assert!(terminal_error(&json!({ "status": "IN_PROGRESS", "error": null })).is_none());
    }

    #[test]
    fn a_submit_response_without_a_cancel_url_is_still_a_job_we_can_watch() {
        // Every observed response carries one, but a job we cannot cancel is
        // preferable to a paid job we refuse to poll.
        let submitted: Submitted = serde_json::from_value(json!({
            "request_id": "abc",
            "status_url": "https://queue.fal.run/fal-ai/flux-pro/requests/abc/status",
            "response_url": "https://queue.fal.run/fal-ai/flux-pro/requests/abc",
        }))
        .unwrap();

        assert_eq!(submitted.cancel_url, None);
    }

    #[test]
    fn saved_files_keep_the_extension_the_api_produced() {
        assert_eq!(
            extension_for("https://v3.fal.media/files/x/out.png", ResultKind::Image),
            "png"
        );
        assert_eq!(
            extension_for("https://v3.fal.media/files/x/out.mp4", ResultKind::Video),
            "mp4"
        );
        assert_eq!(
            extension_for("https://v3.fal.media/files/x/out.webm", ResultKind::Video),
            "webm"
        );
    }

    #[test]
    fn an_extensionless_url_falls_back_to_the_medium_it_is() {
        // A clip saved as `.jpeg` is a file the app will not play and the
        // desktop will not preview (#29).
        assert_eq!(
            extension_for("https://v3.fal.media/files/x/out", ResultKind::Image),
            "jpeg"
        );
        assert_eq!(
            extension_for("https://v3.fal.media/files/x/out", ResultKind::Video),
            "mp4"
        );
        // A query string is not an extension, so the fallback applies there too.
        assert_eq!(
            extension_for(
                "https://v3.fal.media/files/x/out.mp4?token=abc",
                ResultKind::Video
            ),
            "mp4"
        );
    }

    #[test]
    fn the_registrys_own_endpoint_ids_are_accepted() {
        for id in [
            "fal-ai/flux/schnell",
            "fal-ai/flux-pro/kontext/text-to-image",
            "openai/gpt-image-2",
            "xai/grok-imagine-image",
            "bytedance/seedance-2.5/image-to-video",
            "blackforestlabs/flux-3/first-last-frame-to-video",
        ] {
            assert!(validate_model_id(id).is_ok(), "{id}");
        }
    }

    #[test]
    fn an_id_that_could_climb_out_of_the_url_is_refused() {
        // The id is interpolated into a queue URL, so this is the one thing
        // Rust must not take on trust from the webview.
        for id in [
            "",
            "/fal-ai/flux",
            "fal-ai/flux/",
            "fal-ai//flux",
            "fal-ai/../admin",
            "fal-ai/flux?debug=1",
            "https://evil.example/x",
            "fal-ai/flux schnell",
        ] {
            assert_eq!(
                validate_model_id(id).unwrap_err().reason,
                GenerationErrorReason::RequestRejected,
                "{id:?}"
            );
        }
    }
}
