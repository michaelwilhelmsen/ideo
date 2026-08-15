//! The one effect command — a still through a diffusion kernel (#36).
//!
//! Thin over `effects::render`, and the split is the point: this module knows
//! about projects, app data and how big a deliverable ships, that one knows
//! about pixels, and neither knows about the other's problems.
//!
//! Everything else the effects tab renders is a shader in the webview and never
//! comes here. Only Floyd–Steinberg and Atkinson do, because error diffusion is
//! sequential by construction — see `effects/mod.rs`.

use std::path::PathBuf;
use tauri::AppHandle;

use crate::effects::render::{render_png, CpuEffect, EffectError, Grid};
use crate::export::bake::shipped_size;
use crate::export::plan::ExportSize;
use crate::projects::store;
use crate::utils::paths::app_data;

const PROJECTS_DIR: &str = "projects";

/// One still, treated, as PNG bytes, **at the size that export ships at**.
///
/// The two grids are worked out here rather than in `effects::render`, whose
/// business is pixels, and rather than in the request, which neither caller can
/// fill in honestly: the bake could pass what `begin_bake` computed, but the
/// effects tab has no idea how big a candidate is — a `Generation` records no
/// dimensions — so it would have to decode the source in the webview to learn a
/// number this side is already holding the bytes for. Both callers name a
/// [`ExportSize`] instead, which is the same thing the shader path names, and
/// this side turns it into pixels with the same `shipped_size` the bake uses on
/// the same file. So a treated still arrives at exactly the resolution
/// `begin_bake` promised, and `Input::TreatedStill` can go on refusing to scale
/// it.
///
/// The preview asks for `Web` and always will: the look is defined at the web
/// width, every size above it is that look with more pixels resolving its
/// edges, and a preview that had to follow the export choice around the app is
/// the arrangement #58 rejected.
///
/// Runs on a blocking thread: #52 measured error diffusion at ~81 ms for a
/// full-resolution frame, which is fine for a debounced preview and is not fine
/// on an async runtime thread.
///
/// A PNG rather than raw pixels, because a 2560×1440 frame is ~11 MB raw and
/// dithered output compresses hard — the encode pays for itself several times
/// over on the way through IPC. That holds harder at 2×, where the magnified
/// pattern is flat blocks of two colours.
#[tauri::command]
#[specta::specta]
pub async fn render_treated_still(
    app: AppHandle,
    project_id: String,
    generation_id: String,
    effect: CpuEffect,
    size: ExportSize,
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

        // From the bytes in hand rather than by opening the file a second time
        // — `blob_size` reads the header and stops, so this costs nothing next
        // to the decode below and cannot disagree with what gets decoded.
        let header = imagesize::blob_size(&bytes).map_err(|e| EffectError::Undecodable {
            detail: e.to_string(),
        })?;
        let (width, height) = (header.width as u32, header.height as u32);

        render_png(
            &bytes,
            &effect,
            Grid {
                look: shipped_size(width, height, ExportSize::Web),
                shipped: shipped_size(width, height, size),
            },
        )
    })
    .await
    .map_err(|e| EffectError::EncodeFailed {
        detail: e.to_string(),
    })?
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join(PROJECTS_DIR))
}
