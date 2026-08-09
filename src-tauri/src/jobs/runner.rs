//! The job lifecycle: submit, watch, resume, cancel (PRD §3.3).
//!
//! One loop serves every job. A job submitted a second ago and a job submitted
//! before the last quit differ only in where their queue URLs came from —
//! `start` submits and then watches, `resume` reads and then watches, and both
//! call the same `watch`. That is the point of the ticket: a resumed job is not
//! a special case, so it cannot rot separately from the fresh one.
//!
//! Nothing here returns a result to its caller. `generate_image` returns as
//! soon as the job is on the books, and what happens afterwards arrives as
//! events, because "afterwards" may be in a later run of the application.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Semaphore, SemaphorePermit};

use super::fal::{
    self, GenerationError, GenerationErrorReason, GenerationProgress, QueueResult, QueueStatus,
};
use super::store::{self, Job, JobStatus, JobTarget, NewJob};
use crate::commands::api_key::stored_key;
use crate::projects::store::{asset_file_name, assets_dir, validate_id};

/// PRD §3.3 — a 4-up batch is already four concurrent calls, and each one is
/// charged. The cap is on jobs rather than requests because a job holds its
/// slot from submit until it settles: it is the submit that costs money and
/// the poll that hits rate limits.
const MAX_CONCURRENT_JOBS: usize = 3;
static JOB_SLOTS: Semaphore = Semaphore::const_new(MAX_CONCURRENT_JOBS);

/// Poll interval, backing off from 2s. Progress granularity on a job of this
/// length doesn't justify streaming — see PRD §3.3.
const BASE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(8);

/// How long one run of the app watches a job before letting go.
///
/// Generous, because letting go is not free: the job stays on the books and
/// holds a concurrency slot until it does. Ten minutes is far beyond any
/// observed image job and still bounded, so three stuck jobs cannot occupy
/// every slot for a session.
///
/// Letting go marks the job stalled rather than failed. It may still finish at
/// fal, and the next launch picks it up rather than the money being written
/// off.
const MAX_WAIT: Duration = Duration::from_secs(600);

/// Progress, so a 30-second job isn't a freeze.
const PROGRESS_EVENT: &str = "generation-progress";
/// One job stopped mattering, whichever way.
const SETTLED_EVENT: &str = "generation-settled";

const JOBS_FILE: &str = "jobs.sqlite";
/// Where project folders live. The layout below that belongs to
/// `projects::store`, so this only names the root.
const PROJECTS_DIR: &str = "projects";

/// Everything needed to put one generation on the queue.
///
/// One struct rather than eight parameters: the list only grows as models gain
/// controls (#25), and a positional call of that length is a bug waiting for
/// two arguments of the same type to swap places.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub project_id: String,
    pub generation_id: String,
    pub stage: String,
    /// The draft, frozen. Opaque — see `jobs::store`.
    pub recipe: Value,
    pub prompt: String,
    /// Which endpoint to call. Checked against the capability registry on the
    /// TypeScript side before it is sent (PRD §5 — no arbitrary model ids) and
    /// checked for URL safety here, because Rust is the side that spends.
    pub model_id: String,
    /// The rest of the request body, keyed by the model's own field names and
    /// built by the registry. Opaque here on purpose: knowing that Luma spells
    /// duration `"5s"` requires the capability table, and there is one of
    /// those.
    pub params: Value,
}

/// What the caller gets back: a job that is now on the books, not a result.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedJob {
    pub request_id: String,
    pub generation_id: String,
}

/// How a job stopped being in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobOutcome {
    /// Finished, saved, and waiting to be written into the manifest.
    Completed,
    /// fal, the network or the disk said no. Off the books.
    Failed,
    /// The user asked us to stop. Off the books, and no promise of a refund.
    Cancelled,
    /// We stopped watching, but the job is still on the books and the next
    /// launch resumes it.
    Abandoned,
}

/// A job settled. Carries the ids rather than the result: the result is in the
/// store, and reading it from there is what makes a listener that missed the
/// event — because the app was not running — behave identically to one that
/// caught it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobSettled {
    pub request_id: String,
    pub project_id: String,
    pub generation_id: String,
    pub outcome: JobOutcome,
    /// Present for `Failed` and `Abandoned` — the frontend chooses the words.
    pub error: Option<GenerationError>,
}

pub fn open_store(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    store::open(&app_data(app)?.join(JOBS_FILE))
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data directory: {e}"))
}

/// Submits one generation and starts watching it.
///
/// Returns once the job is recorded, which is deliberately before it has
/// produced anything: the user has been charged by then, and the record is
/// what makes that survivable.
pub async fn start(app: AppHandle, request: StartRequest) -> Result<SubmittedJob, GenerationError> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(GenerationError::new(GenerationErrorReason::EmptyPrompt));
    }

    // A paid call filed nowhere is money spent on nothing, so the folder is
    // checked before the request rather than after it.
    validate_id(&request.project_id)
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::CouldNotSave, e))?;

    // Before the key is fetched and long before the charge: an unusable
    // endpoint id is not worth a keychain prompt.
    fal::validate_model_id(&request.model_id)?;

    let key = stored_key()
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::NoApiKey, e))?
        .ok_or_else(|| GenerationError::new(GenerationErrorReason::NoApiKey))?;

    // Held from here until the job settles. Taken before the submit because
    // the submit is the charge — queueing behind the cap is the point.
    let permit = slot().await;

    let submitted = fal::submit(&key, &request.model_id, &prompt, &request.params).await?;
    log::info!("generation submitted, request {}", submitted.request_id);

    let target = JobTarget {
        request_id: submitted.request_id.clone(),
        project_id: request.project_id.clone(),
        generation_id: request.generation_id.clone(),
        status_url: submitted.status_url.clone(),
        response_url: submitted.response_url.clone(),
        cancel_url: submitted.cancel_url.clone(),
    };

    // Before the first poll (PRD §3.3). A store that will not take the row is
    // not a reason to abandon a job already paid for — it only means this run
    // of the app is the last chance to collect it.
    match open_store(&app).and_then(|connection| {
        store::record(
            &connection,
            &NewJob {
                request_id: &submitted.request_id,
                project_id: &request.project_id,
                generation_id: &request.generation_id,
                stage: &request.stage,
                recipe: &request.recipe,
                model_id: &request.model_id,
                status_url: &submitted.status_url,
                response_url: &submitted.response_url,
                cancel_url: submitted.cancel_url.as_deref(),
                submitted_at: now_ms(),
            },
        )
    }) {
        Ok(()) => {}
        Err(e) => log::error!(
            "Job {} is running but could not be recorded, so a quit would lose it: {e}",
            submitted.request_id
        ),
    }

    tauri::async_runtime::spawn(watch(app, target, permit));

    Ok(SubmittedJob {
        request_id: submitted.request_id,
        generation_id: request.generation_id,
    })
}

/// Picks every unfinished job back up. Called once at startup.
///
/// Spawned rather than awaited: a slow or unreachable fal must not hold up the
/// window, and each job takes its own slot so resuming a batch of six respects
/// the same cap a fresh batch of six does.
pub fn resume(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let unfinished = match open_store(&app).and_then(|c| store::unfinished(&c)) {
            Ok(unfinished) => unfinished,
            Err(e) => {
                log::warn!("Could not look for unfinished jobs: {e}");
                return;
            }
        };

        if unfinished.is_empty() {
            return;
        }

        log::info!("Resuming {} unfinished job(s)", unfinished.len());

        for target in unfinished {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let permit = slot().await;
                watch(app, target, permit).await;
            });
        }
    });
}

/// Stops watching a job and asks fal to stop running it.
///
/// The row goes first: whatever fal says, the poll loop is meant to stop, and
/// a cancel that hangs on the network must not leave a job the user has
/// already given up on still running. Nothing here claims a refund — a job far
/// enough along is charged regardless (PRD §3.3).
pub async fn cancel(app: &AppHandle, request_id: &str) -> Result<(), String> {
    let connection = open_store(app)?;

    let Some(target) = store::target(&connection, request_id)? else {
        // Already settled or already cancelled. Nothing to do, and saying so
        // would be a lie about a job that finished a moment ago.
        return Ok(());
    };

    store::forget(&connection, request_id)?;
    drop(connection);

    match (target.cancel_url.as_deref(), stored_key()) {
        (Some(url), Ok(Some(key))) => match fal::cancel(&key, url).await {
            Ok(true) => log::info!("fal.ai accepted the cancellation of {request_id}"),
            Ok(false) => log::info!("Job {request_id} was too far along for fal.ai to cancel"),
            Err(e) => log::warn!("Could not ask fal.ai to cancel {request_id}: {e:?}"),
        },
        (None, _) => log::info!("Job {request_id} has no cancel URL; only local watching stopped"),
        (_, key) => {
            log::warn!("Cancelled {request_id} locally, without a key to tell fal: {key:?}")
        }
    }

    settle(app, &target, JobOutcome::Cancelled, None);

    Ok(())
}

/// A project's jobs in one state.
pub fn jobs_for(app: &AppHandle, project_id: &str, status: JobStatus) -> Result<Vec<Job>, String> {
    store::for_project(&open_store(app)?, project_id, status)
}

/// Takes a collected job off the books. Called once its candidate is in the
/// manifest — never before, or a crash in between would lose a paid result.
pub fn claim(app: &AppHandle, request_id: &str) -> Result<(), String> {
    store::forget(&open_store(app)?, request_id)
}

async fn slot() -> SemaphorePermit<'static> {
    JOB_SLOTS
        .acquire()
        .await
        .expect("the job semaphore is never closed")
}

/// Watches one job to its end, whatever that turns out to be.
async fn watch(app: AppHandle, target: JobTarget, permit: SemaphorePermit<'static>) {
    // A job being watched is a job the UI can honestly call running. Resuming
    // one that stalled last session moves it back, which is what makes a
    // resumed job indistinguishable from a fresh one from here on.
    set_watching(&app, &target.request_id, true);

    match poll_until_done(&app, &target).await {
        Ok(Some(result)) => collect(&app, &target, result).await,
        // The row went away underneath us: cancelled, or claimed by another
        // watcher. Either way somebody else has already said so.
        Ok(None) => log::info!(
            "Stopped watching {} — it is off the books",
            target.request_id
        ),
        Err(error) => {
            let outcome = if keeps_watching_later(&error) {
                // Stays on the books for the next launch, but stops counting as
                // running — nothing is watching it, and a stage that claimed
                // otherwise would refuse to start anything else all session.
                stall(&app, &target.request_id);
                JobOutcome::Abandoned
            } else {
                forget(&app, &target.request_id);
                JobOutcome::Failed
            };

            log::warn!(
                "Job {} settled as {outcome:?}: {error:?}",
                target.request_id
            );
            settle(&app, &target, outcome, Some(error));
        }
    }

    drop(permit);
}

/// Polls until the job finishes, is taken off the books, or this run of the
/// app gives up on it.
///
/// `Ok(None)` means the row is gone — the loop asks the store on every pass,
/// which is how a cancel reaches a task that is asleep between polls.
async fn poll_until_done(
    app: &AppHandle,
    target: &JobTarget,
) -> Result<Option<QueueResult>, GenerationError> {
    let key = stored_key()
        .map_err(|e| GenerationError::with_detail(GenerationErrorReason::NoApiKey, e))?
        .ok_or_else(|| GenerationError::new(GenerationErrorReason::NoApiKey))?;

    let client = fal::client(fal::POLL_TIMEOUT)?;
    let started = Instant::now();
    let mut attempt = 0u32;

    // One connection for the whole loop rather than one per pass. Cancellation
    // arrives through this file, and a reader sees another connection's commits
    // as soon as they land — a fresh connection every two seconds would only
    // re-run the schema check.
    let store = open_store(app).ok();

    loop {
        if !still_wanted(store.as_ref(), &target.request_id) {
            return Ok(None);
        }

        let state = match fal::poll(&client, &key, &target.status_url).await {
            Ok(state) => state,
            // A blip is not an answer about the job. The money is spent either
            // way, so a dropped connection or a rate limit is worth waiting out
            // rather than handing back — the ceiling below still applies.
            Err(error) if is_transient(&error) && started.elapsed() <= MAX_WAIT => {
                log::warn!("Retrying job {}: {error:?}", target.request_id);
                tokio::time::sleep(poll_delay(attempt)).await;
                attempt += 1;
                continue;
            }
            Err(error) => return Err(error),
        };

        emit_progress(
            app,
            GenerationProgress {
                request_id: target.request_id.clone(),
                project_id: target.project_id.clone(),
                generation_id: target.generation_id.clone(),
                status: state.status,
                queue_position: state.queue_position,
                elapsed_ms: started.elapsed().as_millis() as u32,
            },
        );

        if state.status == QueueStatus::Completed {
            return fal::fetch_result(&client, &key, &target.response_url)
                .await
                .map(Some);
        }

        if started.elapsed() > MAX_WAIT {
            return Err(GenerationError::new(GenerationErrorReason::GaveUpWaiting));
        }

        tokio::time::sleep(poll_delay(attempt)).await;
        attempt += 1;
    }
}

/// Files the image and marks the job collectable.
async fn collect(app: &AppHandle, target: &JobTarget, result: QueueResult) {
    let asset = match save_image(app, target, &result.image_url).await {
        Ok(asset) => asset,
        Err(error) => {
            // The result exists and is paid for; a disk that would not take it
            // is worth another attempt next launch, so the row stays.
            log::error!(
                "Could not file the result of {}: {error:?}",
                target.request_id
            );
            settle(app, target, JobOutcome::Abandoned, Some(error));
            return;
        }
    };

    let seed = result.seed.map(|seed| seed as f64);

    match open_store(app).and_then(|c| store::finish(&c, &target.request_id, &asset, seed)) {
        Ok(()) => {}
        // The file is on disk under the generation's own name, so the worst
        // case is a candidate the manifest never hears about — not a lost one.
        Err(e) => log::error!("Saved {} but could not record it: {e}", target.request_id),
    }

    log::info!(
        "generation {} complete, seed {:?}, saved as {asset}",
        target.request_id,
        result.seed
    );

    settle(app, target, JobOutcome::Completed, None);
}

/// Writes the image into the project's assets folder, named after the
/// generation.
///
/// Named after the generation rather than fal's request id, because the
/// manifest refers to candidates by generation id — a file named anything else
/// would be an orphan the moment cleanup looked at it.
async fn save_image(
    app: &AppHandle,
    target: &JobTarget,
    image_url: &str,
) -> Result<String, GenerationError> {
    let bytes = fal::download(image_url).await?;

    let root = app_data(app)
        .map_err(|e| {
            log::error!("{e}");
            GenerationError::new(GenerationErrorReason::CouldNotSave)
        })?
        .join(PROJECTS_DIR);

    // The store owns the layout inside a project folder, and validates the id
    // on the way — one module decides where a project's files are.
    let dir = assets_dir(&root, &target.project_id).map_err(|e| {
        log::error!("Refusing to file a generation: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    std::fs::create_dir_all(&dir).map_err(|e| {
        log::error!("Could not create the project's assets directory: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    let name = asset_file_name(&target.generation_id, fal::extension_for(image_url));

    std::fs::write(dir.join(&name), &bytes).map_err(|e| {
        log::error!("Could not write the generated image: {e}");
        GenerationError::new(GenerationErrorReason::CouldNotSave)
    })?;

    Ok(name)
}

/// Whether a failure is worth another launch's attention.
///
/// "We stopped waiting" is about us, not about the job: fal may well finish it,
/// and the row is the only claim we have on something already paid for.
fn keeps_watching_later(error: &GenerationError) -> bool {
    matches!(
        error.reason,
        GenerationErrorReason::GaveUpWaiting
            | GenerationErrorReason::Offline
            | GenerationErrorReason::RateLimited
            | GenerationErrorReason::CouldNotSave
    )
}

/// Linear backoff from 2s to the cap.
fn poll_delay(attempt: u32) -> Duration {
    let delay = BASE_POLL_INTERVAL + Duration::from_millis(500) * attempt;
    delay.min(MAX_POLL_INTERVAL)
}

/// Is anyone still waiting for this job? A store we cannot read answers "yes",
/// because giving up on a paid job over a database error is the wrong way
/// round.
fn still_wanted(store: Option<&rusqlite::Connection>, request_id: &str) -> bool {
    let Some(connection) = store else {
        return true;
    };

    match store::target(connection, request_id) {
        Ok(target) => target.is_some(),
        Err(e) => {
            log::warn!("Could not check whether {request_id} is still wanted: {e}");
            true
        }
    }
}

/// Whether a failure says something about the network rather than the job.
fn is_transient(error: &GenerationError) -> bool {
    matches!(
        error.reason,
        GenerationErrorReason::Offline | GenerationErrorReason::RateLimited
    )
}

fn set_watching(app: &AppHandle, request_id: &str, watching: bool) {
    if let Err(e) = open_store(app).and_then(|c| store::set_watching(&c, request_id, watching)) {
        log::warn!("Could not record that {request_id} is watched: {e}");
    }
}

/// Leaves the job on the books, unwatched, for the next launch.
fn stall(app: &AppHandle, request_id: &str) {
    set_watching(app, request_id, false);
}

fn forget(app: &AppHandle, request_id: &str) {
    if let Err(e) = open_store(app).and_then(|c| store::forget(&c, request_id)) {
        log::warn!("Could not clear job {request_id}: {e}");
    }
}

fn settle(
    app: &AppHandle,
    target: &JobTarget,
    outcome: JobOutcome,
    error: Option<GenerationError>,
) {
    let settled = JobSettled {
        request_id: target.request_id.clone(),
        project_id: target.project_id.clone(),
        generation_id: target.generation_id.clone(),
        outcome,
        error,
    };

    if let Err(e) = app.emit(SETTLED_EVENT, &settled) {
        // The frontend re-reads the store when it next looks, so a lost event
        // costs immediacy rather than the result.
        log::warn!("Could not announce that {} settled: {e}", target.request_id);
    }
}

fn emit_progress(app: &AppHandle, progress: GenerationProgress) {
    if let Err(e) = app.emit(PROGRESS_EVENT, &progress) {
        // Losing a progress tick is not worth failing a paid job over.
        log::warn!("Could not emit generation progress: {e}");
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_starts_near_two_seconds_and_backs_off_to_a_cap() {
        assert_eq!(poll_delay(0), Duration::from_secs(2));
        assert!(poll_delay(5) > poll_delay(0));
        assert_eq!(poll_delay(99), MAX_POLL_INTERVAL);
    }

    #[test]
    fn a_file_is_named_after_the_generation_the_manifest_will_refer_to() {
        // Cleanup matches manifest entries against file names, so this is the
        // only naming that keeps a candidate from looking like an orphan.
        assert_eq!(
            asset_file_name("9f1c8e4a-1111-2222-3333-444455556666", "jpeg"),
            "9f1c8e4a-1111-2222-3333-444455556666.jpeg"
        );
    }

    #[test]
    fn a_generation_id_cannot_escape_the_assets_directory() {
        let name = asset_file_name("../../etc/passwd", "png");

        assert!(!name.contains('/'), "got: {name}");
        assert!(!name.contains(".."), "got: {name}");
    }

    #[test]
    fn a_nameless_generation_still_produces_a_file_name() {
        assert_eq!(asset_file_name("///", "jpeg"), "generation.jpeg");
    }

    #[test]
    fn giving_up_waiting_leaves_the_job_for_the_next_launch() {
        // The money is already spent, and fal may well still finish the job.
        assert!(keeps_watching_later(&GenerationError::new(
            GenerationErrorReason::GaveUpWaiting
        )));
        assert!(keeps_watching_later(&GenerationError::new(
            GenerationErrorReason::Offline
        )));
    }

    #[test]
    fn a_job_fal_refused_is_not_kept_for_a_retry_that_cannot_work() {
        assert!(!keeps_watching_later(&GenerationError::new(
            GenerationErrorReason::JobFailed
        )));
        assert!(!keeps_watching_later(&GenerationError::new(
            GenerationErrorReason::KeyRejected
        )));
    }

    #[test]
    fn the_concurrency_cap_is_the_two_to_three_the_prd_asks_for() {
        assert!((2..=3).contains(&MAX_CONCURRENT_JOBS));
        assert_eq!(JOB_SLOTS.available_permits(), MAX_CONCURRENT_JOBS);
    }
}
