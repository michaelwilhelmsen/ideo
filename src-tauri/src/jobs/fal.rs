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

/// What the queue produced, before it becomes a file.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueResult {
    pub image_url: String,
    pub seed: Option<u64>,
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

    let response = client(SUBMIT_TIMEOUT)?
        .post(format!("https://queue.fal.run/{model_id}"))
        .header("Authorization", format!("Key {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| offline("Could not submit the generation", e))?;

    let status = response.status().as_u16();
    if status != 200 {
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
        .map_err(|e| offline("Could not read job status", e))?;

    let status_code = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    if status_code != 200 {
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
        .map_err(|e| offline("Could not fetch the finished result", e))?;

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();

    if status != 200 {
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
        .map_err(|e| offline("Could not reach fal to cancel", e))?;

    let status = response.status().as_u16();
    if status == 200 {
        return Ok(true);
    }

    let body = response.text().await.unwrap_or_default();
    log::info!("fal.ai would not cancel the job ({status}): {body}");
    Ok(false)
}

/// Downloads a finished image. No auth header — the media host doesn't need
/// one, and the key has no business being sent there.
pub async fn download(image_url: &str) -> Result<Vec<u8>, GenerationError> {
    let bytes = client(DOWNLOAD_TIMEOUT)?
        .get(image_url)
        .send()
        .await
        .map_err(|e| {
            log::warn!("Could not download the generated image: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?
        .bytes()
        .await
        .map_err(|e| {
            log::error!("Could not read the image bytes: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?;

    Ok(bytes.to_vec())
}

/// The extension a saved file should carry, from the URL fal produced.
pub fn extension_for(image_url: &str) -> &str {
    image_url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.rsplit_once('.'))
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("jpeg")
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
fn extract_result(payload: &Value) -> Result<QueueResult, GenerationError> {
    let image = payload
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .ok_or_else(|| {
            GenerationError::with_detail(GenerationErrorReason::JobFailed, "no image returned")
        })?;

    let image_url = image.get("url").and_then(Value::as_str).ok_or_else(|| {
        GenerationError::with_detail(GenerationErrorReason::JobFailed, "image had no URL")
    })?;

    Ok(QueueResult {
        image_url: image_url.to_string(),
        seed: payload.get("seed").and_then(Value::as_u64),
    })
}

/// Classifies any non-200 answer from fal, whichever call produced it.
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

fn offline(context: &str, e: impl std::fmt::Display) -> GenerationError {
    log::warn!("{context}: {e}");
    GenerationError::new(GenerationErrorReason::Offline)
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

        assert_eq!(result.image_url, "https://v3.fal.media/files/x/out.jpeg");
        assert_eq!(result.seed, Some(1234567890));
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
        assert_eq!(extension_for("https://v3.fal.media/files/x/out.png"), "png");
    }

    #[test]
    fn an_extensionless_url_falls_back_to_jpeg() {
        assert_eq!(extension_for("https://v3.fal.media/files/x/out"), "jpeg");
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
