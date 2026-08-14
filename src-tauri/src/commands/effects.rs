//! The one effect command — a still through a diffusion kernel (#36).
//!
//! Thin over `effects::render`, and the split is the point: this module knows
//! about projects and app data, that one knows about pixels, and neither knows
//! about the other's problems.
//!
//! Everything else the effects tab renders is a shader in the webview and never
//! comes here. Only Floyd–Steinberg and Atkinson do, because error diffusion is
//! sequential by construction — see `effects/mod.rs`.

use std::path::PathBuf;
use tauri::AppHandle;

use crate::effects::render::{render_png, CpuEffect, EffectError};
use crate::projects::store;
use crate::utils::paths::app_data;

const PROJECTS_DIR: &str = "projects";

/// One still, treated, as PNG bytes.
///
/// Runs on a blocking thread: #52 measured error diffusion at ~81 ms for a
/// full-resolution frame, which is fine for a debounced preview and is not fine
/// on an async runtime thread.
///
/// A PNG rather than raw pixels, because a 2560×1440 frame is ~11 MB raw and
/// dithered output compresses hard — the encode pays for itself several times
/// over on the way through IPC.
#[tauri::command]
#[specta::specta]
pub async fn render_treated_still(
    app: AppHandle,
    project_id: String,
    generation_id: String,
    effect: CpuEffect,
) -> Result<Vec<u8>, EffectError> {
    let root = projects_root(&app).map_err(|message| {
        log::error!("Could not locate the projects folder: {message}");
        EffectError::NoAsset
    })?;

    let source = store::asset_path(&root, &project_id, &generation_id)
        .map_err(|message| {
            log::error!("Could not look for the asset: {message}");
            EffectError::NoAsset
        })?
        .ok_or(EffectError::NoAsset)?;

    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&source).map_err(|e| EffectError::Undecodable {
            detail: e.to_string(),
        })?;
        render_png(&bytes, &effect)
    })
    .await
    .map_err(|e| EffectError::EncodeFailed {
        detail: e.to_string(),
    })?
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join(PROJECTS_DIR))
}
