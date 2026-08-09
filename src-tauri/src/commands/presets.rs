//! User-preset commands — where an `AppHandle` becomes a folder of JSON files.
//!
//! Thin, and deliberately incurious: the documents cross as opaque JSON because
//! the preset schema lives in TypeScript, which is also the side that validates
//! it (`src/lib/recipe/presets.ts`). See `presets::store` for the rest.

use serde_json::Value;
use tauri::AppHandle;

use crate::presets::store;
use crate::utils::paths::app_data;

/// Every preset the user has saved, in a stable order.
///
/// Whether each document *is* a preset is not asked here — the frontend runs it
/// through `readPresetLibrary`, which fails loudly on a malformed one (PRD §6).
#[tauri::command]
#[specta::specta]
pub async fn user_presets_list(app: AppHandle) -> Result<Vec<Value>, String> {
    store::list(&app_data(&app)?)
}

/// Writes one preset, by id — creating it, or updating one of the user's own in
/// place. Atomically, so an interrupted save cannot leave a half-written fork.
#[tauri::command]
#[specta::specta]
pub async fn user_preset_save(app: AppHandle, id: String, document: Value) -> Result<(), String> {
    store::save(&app_data(&app)?, &id, &document)
}

/// Removes one preset. Deleting one that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn user_preset_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::delete(&app_data(&app)?, &id)
}
