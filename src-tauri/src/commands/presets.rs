//! User-preset commands — where an `AppHandle` becomes a folder of JSON files.
//!
//! Thin, and deliberately incurious: the documents cross as opaque JSON because
//! the preset schemas live in TypeScript, which is also the side that validates
//! them (`src/lib/recipe/presets.ts` and `src/lib/recipe/motion.ts`). See
//! `presets::store` for the rest.
//!
//! Three families of three, one per library (#29, #47). Nine commands rather
//! than three taking a library name, because a name crossing the boundary is a
//! folder crossing the boundary: the webview would then be choosing which
//! directory under app data gets written to, and `validate_id` guards the file
//! name and not the folder.

use serde_json::Value;
use tauri::AppHandle;

use crate::presets::store::{self, Library};
use crate::utils::paths::app_data;

/// Every style preset the user has saved, in a stable order.
///
/// Whether each document *is* a preset is not asked here — the frontend runs it
/// through `readPresetLibrary`, which fails loudly on a malformed one (PRD §6).
#[tauri::command]
#[specta::specta]
pub async fn user_presets_list(app: AppHandle) -> Result<Vec<Value>, String> {
    store::list(&app_data(&app)?, Library::Style)
}

/// Writes one style preset, by id — creating it, or updating one of the user's
/// own in place. Atomically, so an interrupted save cannot leave a half-written
/// fork.
#[tauri::command]
#[specta::specta]
pub async fn user_preset_save(app: AppHandle, id: String, document: Value) -> Result<(), String> {
    store::save(&app_data(&app)?, Library::Style, &id, &document)
}

/// Removes one style preset. Deleting one that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn user_preset_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::delete(&app_data(&app)?, Library::Style, &id)
}

/// Every motion preset the user has saved, in a stable order.
///
/// A second library, independent of the style one (#29): look and movement are
/// orthogonal, so the same id may exist in both and mean two different things.
#[tauri::command]
#[specta::specta]
pub async fn motion_presets_list(app: AppHandle) -> Result<Vec<Value>, String> {
    store::list(&app_data(&app)?, Library::Motion)
}

/// Writes one motion preset, by id — creating it, or updating one of the user's
/// own in place.
#[tauri::command]
#[specta::specta]
pub async fn motion_preset_save(app: AppHandle, id: String, document: Value) -> Result<(), String> {
    store::save(&app_data(&app)?, Library::Motion, &id, &document)
}

/// Removes one motion preset. Deleting one that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn motion_preset_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::delete(&app_data(&app)?, Library::Motion, &id)
}

/// Every source preset the user has saved, in a stable order.
///
/// A third library, independent of the other two (#47). A source preset is a
/// whole scene where a style preset is a transform applied to somebody else's
/// composition — so the same id may exist in both and mean two different things.
#[tauri::command]
#[specta::specta]
pub async fn source_presets_list(app: AppHandle) -> Result<Vec<Value>, String> {
    store::list(&app_data(&app)?, Library::Source)
}

/// Writes one source preset, by id — creating it, or updating one of the user's
/// own in place.
#[tauri::command]
#[specta::specta]
pub async fn source_preset_save(app: AppHandle, id: String, document: Value) -> Result<(), String> {
    store::save(&app_data(&app)?, Library::Source, &id, &document)
}

/// Removes one source preset. Deleting one that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn source_preset_delete(app: AppHandle, id: String) -> Result<(), String> {
    store::delete(&app_data(&app)?, Library::Source, &id)
}
