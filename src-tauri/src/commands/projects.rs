//! Project commands — where an `AppHandle` becomes a folder on disk.
//!
//! Every command that touches the list reconciles the index against the disk
//! first, so the frontend never has to know whether the database is fresh,
//! stale or absent (PRD §3.2).
//!
//! The connection is opened per call rather than held in Tauri state. That
//! looks wasteful and is not: opening SQLite is sub-millisecond, these
//! commands run on user actions rather than in a loop, and holding one would
//! mean a startup failure could leave every later call talking to a mutex
//! around nothing. The index is a cache — treating it as disposable at every
//! level is what keeps "delete the database" uninteresting.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::projects::import::{self, ImportError, ImportedImage};
use crate::projects::index;
use crate::projects::store::{self, CleanupOutcome, ProjectRecord, ProjectSummary, ProjectUsage};

/// Under `app_data_dir`, so it lands where the platform expects app data and
/// nowhere a path can be talked into.
const PROJECTS_DIR: &str = "projects";
const INDEX_FILE: &str = "index.sqlite";

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data directory: {e}"))
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join(PROJECTS_DIR))
}

fn open_index(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    index::open(&app_data(app)?.join(INDEX_FILE))
}

/// The project list (PRD §10's left sidebar).
///
/// Reconciles first, so a deleted database, a project restored from a backup
/// and a folder copied in by hand all show up as simply "the projects".
#[tauri::command]
#[specta::specta]
pub async fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let root = projects_root(&app)?;
    let connection = open_index(&app)?;

    index::reconcile(&connection, &root)?;
    index::list(&connection)
}

/// One project's manifest, as it is on disk.
#[tauri::command]
#[specta::specta]
pub async fn load_project(app: AppHandle, project_id: String) -> Result<ProjectRecord, String> {
    store::load(&projects_root(&app)?, &project_id)
}

/// Writes a manifest and updates its index row.
///
/// Also the create path: a project is created by saving one. There is no
/// separate "new project" on disk, so creation and every later edit take the
/// identical code path — including the atomic write.
#[tauri::command]
#[specta::specta]
pub async fn save_project(app: AppHandle, manifest: Value) -> Result<ProjectSummary, String> {
    let summary = store::save(&projects_root(&app)?, &manifest)?;

    // A failed index write is not a failed save: the manifest is already on
    // disk, and the next listing rebuilds the row from it.
    match open_index(&app).and_then(|connection| index::upsert(&connection, &summary)) {
        Ok(()) => {}
        Err(e) => log::warn!("Saved project {} but could not index it: {e}", summary.id),
    }

    Ok(summary)
}

/// Deletes a project and everything in its folder.
///
/// The one thing here that removes anything without being asked twice, which
/// is why the caller is expected to have asked. PRD §10.3 keeps *candidates*,
/// not projects someone has explicitly thrown away.
#[tauri::command]
#[specta::specta]
pub async fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    store::delete(&projects_root(&app)?, &project_id)?;

    if let Err(e) = open_index(&app).and_then(|connection| index::remove(&connection, &project_id))
    {
        // The folder is gone, so the next reconcile drops the row anyway.
        log::warn!("Deleted project {project_id} but could not un-index it: {e}");
    }

    log::info!("Deleted project {project_id}");
    Ok(())
}

/// Copies an image the user already has into a project (#27).
///
/// The convergence point of the slice: what comes back is a file in the
/// project's `assets` folder named after its generation — the same artefact a
/// finished job produces — so nothing downstream has to know the pixels were
/// not generated.
///
/// Fails with a *reason* rather than a sentence, so the refusal can be said in
/// the user's own language (PRD §10.4), and fails before anything is recorded
/// so an unusable file never becomes a candidate.
#[tauri::command]
#[specta::specta]
pub async fn import_source_image(
    app: AppHandle,
    project_id: String,
    generation_id: String,
    source_path: String,
) -> Result<ImportedImage, ImportError> {
    let root = projects_root(&app).map_err(|e| {
        log::error!("{e}");
        ImportError::could_not_save()
    })?;

    let imported = import::import(
        &root,
        &project_id,
        &generation_id,
        std::path::Path::new(&source_path),
    )?;

    log::info!(
        "Imported {}×{} image into {project_id} as {}",
        imported.width,
        imported.height,
        imported.asset_name
    );

    Ok(imported)
}

/// What the project costs on disk, and how much of it nothing points at
/// (PRD §10.3).
#[tauri::command]
#[specta::specta]
pub async fn project_usage(app: AppHandle, project_id: String) -> Result<ProjectUsage, String> {
    store::usage(&projects_root(&app)?, &project_id)
}

/// Removes the unreferenced assets, and only those. Deliberate, never
/// automatic — nothing is discarded until someone asks (PRD §10.3).
#[tauri::command]
#[specta::specta]
pub async fn cleanup_unused_assets(
    app: AppHandle,
    project_id: String,
) -> Result<CleanupOutcome, String> {
    let outcome = store::cleanup_unused(&projects_root(&app)?, &project_id)?;

    log::info!(
        "Cleanup on {project_id} removed {} files",
        outcome.removed_count
    );
    Ok(outcome)
}
