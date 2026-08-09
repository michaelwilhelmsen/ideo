//! Where this app is allowed to keep things.
//!
//! Here rather than beside any one caller because three of them wanted the same
//! four lines — the project store, the job store and the user's preset library
//! (#28) — and a fourth copy is a fourth place for the error message to drift.
//! Same argument as `utils::atomic`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The platform's app-data directory for this app.
///
/// Every folder the app owns hangs off this — `projects/`, `presets/`, the two
/// databases — so nothing has to name a path a user could talk it out of.
/// Resolved per call rather than cached: it is a string lookup, and holding one
/// would mean a startup failure could leave every later call talking to a stale
/// answer.
pub fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data directory: {e}"))
}
