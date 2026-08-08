//! Image generation against fal's queue API.
//!
//! fal's queue is submit → poll → fetch. The whole exchange happens in Rust so
//! the API key never reaches the webview, and because a queued job the user has
//! already been charged for is easier to nurse from here than from a hook.
//!
//! This is the tracer bullet (#22): one model, one size, no persistence and no
//! batching. Everything hardcoded here is something a later slice widens.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::api_key::stored_key;

/// Hardcoded for the tracer bullet; #25 replaces this with the model registry.
/// Chosen because the spike ran this exact endpoint live: $0.04/image, returns
/// a seed, and its request shape is verified rather than inferred.
const MODEL_ID: &str = "fal-ai/flux-pro/v1.1";

/// Also hardcoded — #23 and #25 bring per-project aspect ratios. Note that fal
/// snaps dimensions to a multiple of 16, so the result may not be exactly this.
const IMAGE_WIDTH: u32 = 1280;
const IMAGE_HEIGHT: u32 = 720;

const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// Poll interval, backing off from 2s. Progress granularity on a job of this
/// length doesn't justify streaming — see PRD §3.3.
const BASE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(8);

/// Ceiling on how long we wait before giving up on a queued job. The job may
/// still complete on fal's side; we just stop watching.
const MAX_WAIT: Duration = Duration::from_secs(300);

/// Event carrying queue progress to the UI, so a 30-second job isn't a freeze.
const PROGRESS_EVENT: &str = "generation-progress";

/// Where a generation ends up while there are no projects to file it under.
const GENERATIONS_DIR: &str = "generations";

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
pub struct GenerationProgress {
    pub request_id: String,
    pub status: QueueStatus,
    /// Position in fal's queue, when it tells us.
    pub queue_position: Option<u32>,
    pub elapsed_ms: u32,
}

/// A finished generation: the image, where it landed, and the recipe fragments
/// worth keeping. The seed is captured even though nothing shows it yet — it is
/// what makes a generation reproducible, and re-rolling costs money (PRD §4.3).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Generation {
    pub request_id: String,
    pub prompt: String,
    pub model_id: String,
    pub seed: Option<u64>,
    /// fal-hosted URL. Temporary — the file on disk is the durable copy.
    pub image_url: String,
    pub image_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
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

/// A failure, as it crosses to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GenerationError {
    pub reason: GenerationErrorReason,
    /// Text fal supplied about this specific failure, when there was any.
    pub detail: Option<String>,
    /// HTTP status, for `Unexpected`.
    pub status: Option<u16>,
}

impl GenerationError {
    fn new(reason: GenerationErrorReason) -> Self {
        Self {
            reason,
            detail: None,
            status: None,
        }
    }

    fn with_detail(reason: GenerationErrorReason, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(reason)
        }
    }
}

/// What the queue told us, before it becomes an event.
#[derive(Debug, Clone, PartialEq)]
struct QueueResult {
    image_url: String,
    seed: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
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

/// Linear backoff from 2s to the cap.
fn poll_delay(attempt: u32) -> Duration {
    let delay = BASE_POLL_INTERVAL + Duration::from_millis(500) * attempt;
    delay.min(MAX_POLL_INTERVAL)
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
        width: image.get("width").and_then(Value::as_u64).map(|w| w as u32),
        height: image
            .get("height")
            .and_then(Value::as_u64)
            .map(|h| h as u32),
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

/// Builds the filename a generation is saved under. The request id comes from
/// fal, so it is treated as untrusted: only its final segment is used, and only
/// characters that cannot walk out of the directory.
fn file_name_for(request_id: &str, image_url: &str) -> String {
    let stem: String = request_id
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();

    let stem = if stem.is_empty() {
        "generation".to_string()
    } else {
        stem
    };

    let extension = image_url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.rsplit_once('.'))
        .map(|(_, ext)| ext)
        .filter(|ext| ext.chars().all(|c| c.is_ascii_alphanumeric()) && !ext.is_empty())
        .unwrap_or("jpeg");

    format!("{stem}.{extension}")
}

/// The three URLs fal hands back on submit. Never construct these — the spike
/// found the versioned forms we'd build ourselves return 405.
#[derive(Debug, Deserialize)]
struct SubmitResponse {
    request_id: String,
    status_url: String,
    response_url: String,
}

fn client(timeout: Duration) -> Result<reqwest::Client, GenerationError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| {
            log::error!("Could not build the HTTP client: {e}");
            GenerationError::new(GenerationErrorReason::Offline)
        })
}

fn offline(context: &str, e: impl std::fmt::Display) -> GenerationError {
    log::warn!("{context}: {e}");
    GenerationError::new(GenerationErrorReason::Offline)
}

/// Generates one image from a prompt, saves it, and reports back.
///
/// Progress arrives as `generation-progress` events rather than as a return
/// value, because the interesting part happens while this is still running.
#[tauri::command]
#[specta::specta]
pub async fn generate_image(app: AppHandle, prompt: String) -> Result<Generation, GenerationError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(GenerationError::new(GenerationErrorReason::EmptyPrompt));
    }

    let key = stored_key()
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::NoApiKey, e))?
        .ok_or_else(|| GenerationError::new(GenerationErrorReason::NoApiKey))?;

    let submitted = submit(&key, &prompt).await?;
    log::info!("generation submitted, request {}", submitted.request_id);

    let result = await_result(&app, &key, &submitted).await?;

    let image_path = save_image(&app, &submitted.request_id, &result.image_url).await?;

    log::info!(
        "generation {} complete, seed {:?}, saved to {image_path}",
        submitted.request_id,
        result.seed
    );

    Ok(Generation {
        request_id: submitted.request_id,
        prompt,
        model_id: MODEL_ID.to_string(),
        seed: result.seed,
        image_url: result.image_url,
        image_path,
        width: result.width,
        height: result.height,
    })
}

async fn submit(key: &str, prompt: &str) -> Result<SubmitResponse, GenerationError> {
    let response = client(SUBMIT_TIMEOUT)?
        .post(format!("https://queue.fal.run/{MODEL_ID}"))
        .header("Authorization", format!("Key {key}"))
        .json(&json!({
            "prompt": prompt,
            "image_size": { "width": IMAGE_WIDTH, "height": IMAGE_HEIGHT },
        }))
        .send()
        .await
        .map_err(|e| offline("Could not submit the generation", e))?;

    let status = response.status().as_u16();
    if status != 200 {
        let body = response.text().await.unwrap_or_default();
        log::error!("fal.ai refused the submit with status {status}: {body}");
        return Err(fal_error(status, &body));
    }

    response.json::<SubmitResponse>().await.map_err(|e| {
        log::error!("Could not read fal.ai's submit response: {e}");
        GenerationError::new(GenerationErrorReason::Unexpected)
    })
}

/// Polls until the job finishes, emitting progress as it goes.
async fn await_result(
    app: &AppHandle,
    key: &str,
    submitted: &SubmitResponse,
) -> Result<QueueResult, GenerationError> {
    let client = client(POLL_TIMEOUT)?;
    let started = Instant::now();
    let mut attempt = 0u32;

    loop {
        let response = client
            .get(&submitted.status_url)
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
            log::error!("fal.ai reported job {} as failed", submitted.request_id);
            return Err(failure);
        }

        let status =
            parse_queue_status(payload.get("status").and_then(Value::as_str).unwrap_or(""));

        emit_progress(
            app,
            GenerationProgress {
                request_id: submitted.request_id.clone(),
                status,
                queue_position: payload
                    .get("queue_position")
                    .and_then(Value::as_u64)
                    .map(|p| p as u32),
                elapsed_ms: started.elapsed().as_millis() as u32,
            },
        );

        if status == QueueStatus::Completed {
            return fetch_result(&client, key, &submitted.response_url).await;
        }

        if started.elapsed() > MAX_WAIT {
            log::error!("gave up waiting on request {}", submitted.request_id);
            return Err(GenerationError::new(GenerationErrorReason::GaveUpWaiting));
        }

        tokio::time::sleep(poll_delay(attempt)).await;
        attempt += 1;
    }
}

async fn fetch_result(
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

/// Downloads the image and writes it next to the others. No auth header — the
/// media host doesn't need one, and the key has no business being sent there.
async fn save_image(
    app: &AppHandle,
    request_id: &str,
    image_url: &str,
) -> Result<String, GenerationError> {
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

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            log::error!("Could not locate the app data directory: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?
        .join(GENERATIONS_DIR);

    std::fs::create_dir_all(&dir).map_err(|e| {
        log::error!("Could not create the generations directory: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    let path = dir.join(file_name_for(request_id, image_url));

    std::fs::write(&path, &bytes).map_err(|e| {
        log::error!("Could not write the generated image: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    Ok(path.to_string_lossy().to_string())
}

fn emit_progress(app: &AppHandle, progress: GenerationProgress) {
    if let Err(e) = app.emit(PROGRESS_EVENT, &progress) {
        // Losing a progress tick is not worth failing a paid job over.
        log::warn!("Could not emit generation progress: {e}");
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
    fn polling_starts_near_two_seconds_and_backs_off_to_a_cap() {
        assert_eq!(poll_delay(0), Duration::from_secs(2));
        assert!(poll_delay(5) > poll_delay(0));
        assert_eq!(poll_delay(99), MAX_POLL_INTERVAL);
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
        assert_eq!(result.width, Some(1280));
        assert_eq!(result.height, Some(704));
    }

    #[test]
    fn a_missing_seed_is_not_fatal() {
        let payload = json!({ "images": [{ "url": "https://v3.fal.media/files/x/out.jpeg" }] });

        let result = extract_result(&payload).unwrap();

        assert_eq!(result.seed, None);
        assert_eq!(result.width, None);
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
    fn saved_files_keep_the_extension_the_api_produced() {
        assert_eq!(
            file_name_for("req-1", "https://v3.fal.media/files/x/out.png"),
            "req-1.png"
        );
    }

    #[test]
    fn an_extensionless_url_falls_back_to_jpeg() {
        assert_eq!(
            file_name_for("req-1", "https://v3.fal.media/files/x/out"),
            "req-1.jpeg"
        );
    }

    #[test]
    fn a_request_id_cannot_escape_the_generations_directory() {
        let name = file_name_for("../../etc/passwd", "https://v3.fal.media/x.png");

        assert!(!name.contains('/'), "got: {name}");
        assert!(!name.contains(".."), "got: {name}");
    }
}
