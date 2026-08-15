//! Job commands — where the webview asks for work and asks about it.
//!
//! Thin on purpose: the lifecycle is `jobs::runner` and the fal exchange is
//! `jobs::fal`. What lives here is the shape each call takes crossing the
//! boundary.
//!
//! Note what `generate_image` does *not* return: an image. A generation
//! outlives the call that started it — that is the whole of #24 — so the
//! command returns a receipt and the result arrives through the job store.

use tauri::AppHandle;

use crate::jobs::fal::GenerationError;
use crate::jobs::runner::{self, StartRequest, SubmittedJob};
use crate::jobs::store::{Job, JobStatus};

/// Submits one generation and returns as soon as it is on the books.
///
/// The generation id is minted by the caller and passed in rather than
/// returned: the file is named after it, so the manifest and the folder agree
/// without anyone having to reconcile them afterwards.
///
/// `recipe` is the draft frozen at submit, stored opaquely and handed back when
/// the job is collected. It travels with the job because a resumed job lands
/// in a session whose draft may say something else entirely, and a generation
/// has to carry the recipe that produced it (PRD §1).
///
/// `pinned_seed` is the seed the recipe asked for, if it asked for one
/// (PRD §4.3). Passing it is what makes "same seed, one changed fragment" a
/// real comparison rather than an approximate one.
#[tauri::command]
#[specta::specta]
pub async fn generate_image(
    app: AppHandle,
    request: StartRequest,
) -> Result<SubmittedJob, GenerationError> {
    runner::start(app, request).await
}

/// What this project still has in flight — including anything a previous run
/// of the app submitted.
#[tauri::command]
#[specta::specta]
pub async fn active_jobs(app: AppHandle, project_id: String) -> Result<Vec<Job>, String> {
    runner::jobs_for(&app, &project_id, JobStatus::Running)
}

/// Finished jobs whose candidate is not in the manifest yet.
#[tauri::command]
#[specta::specta]
pub async fn finished_jobs(app: AppHandle, project_id: String) -> Result<Vec<Job>, String> {
    runner::jobs_for(&app, &project_id, JobStatus::Completed)
}

/// What the whole library has in flight (ADR 0002).
///
/// The overview's cards cover projects nobody has open, and a card that could
/// only see the open project's work would mark the wrong projects as busy.
#[tauri::command]
#[specta::specta]
pub async fn active_jobs_everywhere(app: AppHandle) -> Result<Vec<Job>, String> {
    runner::jobs_everywhere(&app, JobStatus::Running)
}

/// Every finished job across the library, waiting to be written into whichever
/// manifest it belongs to.
///
/// Collection stopped being bound to the open project (ADR 0002): a result is
/// paid for whether or not anyone is looking at it, and the point of a front
/// door is watching work arrive.
#[tauri::command]
#[specta::specta]
pub async fn finished_jobs_everywhere(app: AppHandle) -> Result<Vec<Job>, String> {
    runner::jobs_everywhere(&app, JobStatus::Completed)
}

/// Takes a collected job off the books.
///
/// Called after the manifest has been written, never before: the row is the
/// only record that a paid result exists, so dropping it first would turn a
/// badly timed crash into a lost generation.
#[tauri::command]
#[specta::specta]
pub async fn claim_job(app: AppHandle, request_id: String) -> Result<(), String> {
    runner::claim(&app, &request_id)
}

/// Stops a running job.
///
/// Cancelling stops us watching and asks fal to stop working. It does **not**
/// promise a refund — a job far enough along is charged regardless (PRD §3.3),
/// and the copy around this button says so.
#[tauri::command]
#[specta::specta]
pub async fn cancel_job(app: AppHandle, request_id: String) -> Result<(), String> {
    runner::cancel(&app, &request_id).await
}
