//! Image generation against fal's queue API.
//!
//! fal's queue is submit → poll → fetch. The whole exchange happens in Rust so
//! the API key never reaches the webview, and because a queued job the user has
//! already been charged for is easier to nurse from here than from a hook.
//!
//! Started as the tracer bullet (#22): one model, one size, no persistence.
//! #23 gave it a project — the file now lands in the project's own folder,
//! under the generation's id, which is what makes cleanup able to tell an
//! orphan from a candidate. The model is still hardcoded until #25.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::api_key::stored_key;
use crate::projects::store::{assets_dir, validate_id};

/// Hardcoded for the tracer bullet; #25 replaces this with the model registry.
/// Chosen because the spike ran this exact endpoint live: $0.04/image, returns
/// a seed, and its request shape is verified rather than inferred.
const MODEL_ID: &str = "fal-ai/flux-pro/v1.1";

/// The curated ratios of PRD §4.4, as pixels.
///
/// Every dimension is a multiple of 16 because fal snaps to one regardless
/// (PRD §12: 1280×720 came back as 1280×704, changing the ratio). Choosing
/// multiples ourselves is how the locked ratio survives the request.
fn image_size_for(aspect: &str) -> Result<(u32, u32), GenerationError> {
    match aspect {
        "16:9" => Ok((1280, 720)),
        "21:9" => Ok((1344, 576)),
        "2:1" => Ok((1280, 640)),
        "3:2" => Ok((1248, 832)),
        "1:1" => Ok((1024, 1024)),
        other => Err(GenerationError::with_detail(
            GenerationErrorReason::RequestRejected,
            format!("unknown aspect ratio {other}"),
        )),
    }
}

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

/// Where project folders live. The layout below that — the project folder, its
/// assets folder — belongs to `projects::store`, so this only names the root.
const PROJECTS_DIR: &str = "projects";

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
/// worth keeping. The seed is captured because it is what makes a generation
/// reproducible, and re-rolling costs money (PRD §4.3).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Generation {
    pub request_id: String,
    pub prompt: String,
    pub model_id: String,
    pub seed: Option<u64>,
    /// fal-hosted URL. Temporary — the file on disk is the durable copy.
    pub image_url: String,
    /// The file name inside the project's `assets` folder. This is what the
    /// manifest records, so it must survive the app-data folder moving.
    pub asset: String,
    /// The same file, resolved. Transient — for display, never for storage.
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

/// Builds the file name a generation is saved under.
///
/// Named after the generation rather than fal's request id, because the
/// manifest refers to candidates by generation id — a file named anything else
/// would be an orphan the moment cleanup looked at it. The id is still
/// filtered: it reaches here from the webview.
fn file_name_for(generation_id: &str, image_url: &str) -> String {
    let stem: String = generation_id
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

/// Generates one image from a prompt, files it under the project, and reports
/// back.
///
/// The generation id is minted by the caller and passed in rather than
/// returned: the file is named after it, so the manifest and the folder agree
/// without anyone having to reconcile them afterwards.
///
/// `pinned_seed` is the seed the recipe asked for, if it asked for one
/// (PRD §4.3). Passing it is what makes "same seed, one changed fragment" a
/// real comparison rather than an approximate one.
///
/// Progress arrives as `generation-progress` events rather than as a return
/// value, because the interesting part happens while this is still running.
#[tauri::command]
#[specta::specta]
pub async fn generate_image(
    app: AppHandle,
    project_id: String,
    generation_id: String,
    prompt: String,
    aspect: String,
    pinned_seed: Option<f64>,
) -> Result<Generation, GenerationError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(GenerationError::new(GenerationErrorReason::EmptyPrompt));
    }

    // The generation has to land in a folder that exists and belongs to a
    // project — a paid call filed nowhere is money spent on nothing.
    validate_id(&project_id)
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::CouldNotSave, e))?;

    let size = image_size_for(&aspect)?;

    let key = stored_key()
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::NoApiKey, e))?
        .ok_or_else(|| GenerationError::new(GenerationErrorReason::NoApiKey))?;

    let submitted = submit(&key, &prompt, size, pinned_seed).await?;
    log::info!("generation submitted, request {}", submitted.request_id);

    let result = await_result(&app, &key, &submitted).await?;

    let saved = save_image(&app, &project_id, &generation_id, &result.image_url).await?;

    log::info!(
        "generation {} complete, seed {:?}, saved to {}",
        submitted.request_id,
        result.seed,
        saved.path
    );

    Ok(Generation {
        request_id: submitted.request_id,
        prompt,
        model_id: MODEL_ID.to_string(),
        seed: result.seed,
        image_url: result.image_url,
        asset: saved.name,
        image_path: saved.path,
        width: result.width,
        height: result.height,
    })
}

async fn submit(
    key: &str,
    prompt: &str,
    (width, height): (u32, u32),
    pinned_seed: Option<f64>,
) -> Result<SubmitResponse, GenerationError> {
    let mut body = json!({
        "prompt": prompt,
        "image_size": { "width": width, "height": height },
    });

    // `f64` on the way in rather than an integer type: a `u64` crosses the
    // boundary as a string (see `bindings.rs`), and the recipe model holds
    // seeds as JS numbers regardless. Exact to 2^53 — the same ceiling the
    // frontend has, rather than the 2^32 an integer parameter would impose.
    if let Some(seed) = pinned_seed {
        body["seed"] = json!(seed as u64);
    }

    let response = client(SUBMIT_TIMEOUT)?
        .post(format!("https://queue.fal.run/{MODEL_ID}"))
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

/// A written file: what the manifest records, and where it actually is.
struct SavedAsset {
    name: String,
    path: String,
}

/// Downloads the image and writes it into the project's assets folder. No auth
/// header — the media host doesn't need one, and the key has no business being
/// sent there.
async fn save_image(
    app: &AppHandle,
    project_id: &str,
    generation_id: &str,
    image_url: &str,
) -> Result<SavedAsset, GenerationError> {
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

    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| {
            log::error!("Could not locate the app data directory: {e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?
        .join(PROJECTS_DIR);

    // The store owns the layout inside a project folder, and validates the id
    // on the way — one module decides where a project's files are.
    let dir = assets_dir(&root, project_id).map_err(|e| {
        log::error!("Refusing to file a generation: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    std::fs::create_dir_all(&dir).map_err(|e| {
        log::error!("Could not create the project's assets directory: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    let name = file_name_for(generation_id, image_url);
    let path = dir.join(&name);

    std::fs::write(&path, &bytes).map_err(|e| {
        log::error!("Could not write the generated image: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    Ok(SavedAsset {
        name,
        path: path.to_string_lossy().to_string(),
    })
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
            file_name_for("gen-1", "https://v3.fal.media/files/x/out.png"),
            "gen-1.png"
        );
    }

    #[test]
    fn an_extensionless_url_falls_back_to_jpeg() {
        assert_eq!(
            file_name_for("gen-1", "https://v3.fal.media/files/x/out"),
            "gen-1.jpeg"
        );
    }

    #[test]
    fn a_file_is_named_after_the_generation_that_the_manifest_will_refer_to() {
        // Cleanup matches manifest entries against file names, so this is the
        // only naming that keeps a candidate from looking like an orphan.
        assert_eq!(
            file_name_for(
                "9f1c8e4a-1111-2222-3333-444455556666",
                "https://v3.fal.media/x.jpeg"
            ),
            "9f1c8e4a-1111-2222-3333-444455556666.jpeg"
        );
    }

    #[test]
    fn a_generation_id_cannot_escape_the_assets_directory() {
        let name = file_name_for("../../etc/passwd", "https://v3.fal.media/x.png");

        assert!(!name.contains('/'), "got: {name}");
        assert!(!name.contains(".."), "got: {name}");
    }

    #[test]
    fn every_curated_ratio_asks_for_dimensions_fal_will_not_reshape() {
        // PRD §12 — fal snaps to a multiple of 16, which silently changed
        // 1280×720 into 1280×704 and the ratio from 1.78 to 1.82.
        for aspect in ["16:9", "21:9", "2:1", "3:2", "1:1"] {
            let (width, height) = image_size_for(aspect).expect(aspect);
            assert_eq!(width % 16, 0, "{aspect} width");
            assert_eq!(height % 16, 0, "{aspect} height");
        }
    }

    #[test]
    fn the_requested_dimensions_actually_match_the_named_ratio() {
        let (width, height) = image_size_for("21:9").unwrap();
        assert!(
            ((width as f64 / height as f64) - (21.0 / 9.0)).abs() < 0.02,
            "{width}×{height}"
        );
    }

    #[test]
    fn a_ratio_outside_the_curated_list_is_refused_before_it_is_paid_for() {
        assert_eq!(
            image_size_for("4:3").unwrap_err().reason,
            GenerationErrorReason::RequestRejected
        );
    }
}
