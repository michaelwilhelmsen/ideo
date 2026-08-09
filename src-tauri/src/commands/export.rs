//! Export commands — where a candidate becomes files on a landing page.
//!
//! Thin over `export::plan` and `export::ffmpeg`, and the split is the point
//! (PRD §8): this module knows about projects and app data, those two know
//! about encoding, and neither knows about the other's problems.

use std::path::PathBuf;
use tauri::AppHandle;

use crate::export::ffmpeg::{self, FfmpegStatus};
use crate::export::plan::{self, Formats};
use crate::export::ExportError;
use crate::projects::store;
use crate::utils::paths::app_data;

const PROJECTS_DIR: &str = "projects";

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join(PROJECTS_DIR))
}

/// Whether there is an ffmpeg, from the answer taken at startup.
///
/// Cheap and cached, because the export panel asks on every render and the
/// answer changes about once per `brew install`.
///
/// Still on a blocking thread, for the case the cache is cold: a probe spawns a
/// process per candidate path, and a stalled binary on the `PATH` would
/// otherwise stall the runtime rather than one thread of it.
#[tauri::command]
#[specta::specta]
pub async fn ffmpeg_status() -> Result<FfmpegStatus, String> {
    probing(ffmpeg::status).await
}

/// Looks again — the panel's re-check button, so installing ffmpeg while the
/// app is open does not need a relaunch.
///
/// Always spawns processes, so always off the runtime.
#[tauri::command]
#[specta::specta]
pub async fn recheck_ffmpeg() -> Result<FfmpegStatus, String> {
    probing(ffmpeg::refresh).await
}

async fn probing(
    look: impl FnOnce() -> FfmpegStatus + Send + 'static,
) -> Result<FfmpegStatus, String> {
    tauri::async_runtime::spawn_blocking(look)
        .await
        .map_err(|e| format!("Could not look for ffmpeg: {e}"))
}

/// What one export was asked for.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub project_id: String,
    pub generation_id: String,
    /// Absolute, and chosen by the user through the system picker — remembered
    /// in preferences between runs (PRD §11).
    pub destination: String,
    /// What the files are called, before the extension. The frontend builds it
    /// from the project and candidate names, because those are its own; this
    /// side filters it into something a file can be called.
    pub base_name: String,
    pub mp4: bool,
    pub webm: bool,
    pub poster: bool,
    /// PRD §4.5's ping-pong. Ignored on a still, which has no time axis.
    pub rewind: bool,
}

/// What it produced.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ExportOutcome {
    /// File names, not paths — they all landed in the destination that was
    /// asked for, and the frontend already knows where that was.
    pub files: Vec<String>,
}

/// Encodes one candidate into the files a landing page can use.
///
/// Runs on a blocking thread: a WebM of a ten-second hero is tens of seconds of
/// CPU, and tens of seconds on an async runtime thread is the whole UI.
#[tauri::command]
#[specta::specta]
pub async fn export_generation(
    app: AppHandle,
    request: ExportRequest,
) -> Result<ExportOutcome, ExportError> {
    // Both of these mean "there is no file to encode", and neither is about the
    // folder the user picked — reporting an unreadable app-data directory as
    // `DestinationUnusable` would tell them their own choice was at fault.
    let root = projects_root(&app).map_err(|message| {
        log::error!("Could not locate the projects folder: {message}");
        ExportError::NoAsset
    })?;

    let source = store::asset_path(&root, &request.project_id, &request.generation_id)
        .map_err(|message| {
            log::error!("Could not look for the asset: {message}");
            ExportError::NoAsset
        })?
        .ok_or(ExportError::NoAsset)?;

    let plan = plan::plan(
        &source,
        &request.base_name,
        Formats {
            mp4: request.mp4,
            webm: request.webm,
            poster: request.poster,
        },
        request.rewind,
        plan::medium_of(&source),
    )?;

    let destination = PathBuf::from(&request.destination);

    let files = tauri::async_runtime::spawn_blocking(move || ffmpeg::run(&plan, &destination))
        .await
        .map_err(|e| ExportError::EncodeFailed {
            deliverable: "export".to_string(),
            detail: e.to_string(),
        })??;

    log::info!(
        "Exported {} file(s) from {} to {}",
        files.len(),
        request.generation_id,
        request.destination
    );

    Ok(ExportOutcome { files })
}
