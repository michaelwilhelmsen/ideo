//! User presets on disk: one JSON file per preset, under `presets/`.
//!
//! See the module comment in `presets/mod.rs` for why these live at app level
//! and why their contents are opaque here.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::atomic::write_atomically;

/// The folder under `app_data_dir` these are kept in.
pub const PRESETS_DIR: &str = "presets";

/// A preset id becomes a file name, so it is checked rather than trusted.
const MAX_ID_LEN: usize = 64;

/// Rejects anything that is not a plain file name.
///
/// Rejected rather than sanitised, deliberately. Filtering the characters out
/// would let `../evil` and `evil` name the same file, so saving one preset could
/// silently overwrite another — and the id is what the frontend looks a preset up
/// by, so it has to survive the round trip unchanged.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(format!("Preset id has an implausible length: {id:?}"));
    }

    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Preset id has characters a file cannot: {id:?}"));
    }

    Ok(())
}

/// Where the library lives, given the app data directory.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join(PRESETS_DIR)
}

fn preset_path(app_data: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(dir(app_data).join(format!("{id}.json")))
}

/// Every preset document in the library, in a stable order.
///
/// A file that is not JSON at all is logged and skipped: it cannot become a
/// `Value`, and withholding the rest of somebody's library over one bad file
/// would be the wrong trade. Whether a *parseable* document is a valid preset is
/// not asked here — that is `readPresetLibrary`'s job, and it fails loudly.
pub fn list(app_data: &Path) -> Result<Vec<Value>, String> {
    let dir = dir(app_data);

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        // No folder yet is an empty library, not a failure.
        Err(_) => return Ok(Vec::new()),
    };

    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|e| e == "json"))
        .collect();

    // Stable, so the list does not reorder itself between launches.
    paths.sort();

    Ok(paths
        .into_iter()
        .filter_map(|path| match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Value>(&contents) {
                Ok(document) => Some(document),
                Err(e) => {
                    log::warn!("Skipping {}: not readable JSON: {e}", path.display());
                    None
                }
            },
            Err(e) => {
                log::warn!("Skipping {}: {e}", path.display());
                None
            }
        })
        .collect())
}

/// Writes one preset, creating the library folder if this is the first.
///
/// Atomic (`utils::atomic`), because a preset half-written by a crash is a file
/// the loader will refuse and the user will have to find and delete by hand.
pub fn save(app_data: &Path, id: &str, document: &Value) -> Result<(), String> {
    let path = preset_path(app_data, id)?;

    fs::create_dir_all(dir(app_data))
        .map_err(|e| format!("Could not create the presets folder: {e}"))?;

    let json = serde_json::to_string_pretty(document)
        .map_err(|e| format!("Could not serialise the preset: {e}"))?;

    write_atomically(&path, json.as_bytes())
}

/// Removes one preset. Deleting one that is already gone is not an error — the
/// caller wanted it absent, and it is.
pub fn delete(app_data: &Path, id: &str) -> Result<(), String> {
    let path = preset_path(app_data, id)?;

    if !path.exists() {
        return Ok(());
    }

    fs::remove_file(&path).map_err(|e| format!("Could not delete the preset: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn preset(id: &str) -> Value {
        json!({
            "id": id,
            "name": "Forked glass",
            "family": "glass",
            "variants": { "prose": null, "tags": null },
        })
    }

    #[test]
    fn a_saved_preset_comes_back_exactly_as_it_went_in() {
        let root = TempDir::new().unwrap();

        save(root.path(), "forked-glass", &preset("forked-glass")).unwrap();

        assert_eq!(list(root.path()).unwrap(), vec![preset("forked-glass")]);
    }

    #[test]
    fn fields_this_build_does_not_model_survive_a_round_trip() {
        // The schema is TypeScript's and widens with every slice; dropping what
        // Rust cannot model would quietly downgrade somebody's fork.
        let root = TempDir::new().unwrap();
        let mut document = preset("forked-glass");
        document["variants"]["tags"] = json!({ "transform": "x", "unknownToRust": 4 });

        save(root.path(), "forked-glass", &document).unwrap();

        assert_eq!(list(root.path()).unwrap(), vec![document]);
    }

    #[test]
    fn an_empty_library_lists_clean_rather_than_failing() {
        let root = TempDir::new().unwrap();
        assert!(list(&root.path().join("never-created")).unwrap().is_empty());
    }

    #[test]
    fn saving_the_same_id_twice_updates_it_in_place() {
        // Updating one of your own presets is the other half of the fork flow.
        let root = TempDir::new().unwrap();
        save(root.path(), "forked-glass", &preset("forked-glass")).unwrap();

        let mut edited = preset("forked-glass");
        edited["name"] = json!("Forked glass, warmer");
        save(root.path(), "forked-glass", &edited).unwrap();

        let library = list(root.path()).unwrap();
        assert_eq!(library.len(), 1);
        assert_eq!(library[0]["name"], json!("Forked glass, warmer"));
    }

    #[test]
    fn the_library_is_listed_in_a_stable_order() {
        let root = TempDir::new().unwrap();
        save(root.path(), "second", &preset("second")).unwrap();
        save(root.path(), "first", &preset("first")).unwrap();

        let library = list(root.path()).unwrap();
        let ids: Vec<&str> = library
            .iter()
            .map(|document| document["id"].as_str().unwrap())
            .collect();

        assert_eq!(ids, vec!["first", "second"]);
    }

    #[test]
    fn a_file_that_is_not_json_is_skipped_rather_than_failing_the_library() {
        let root = TempDir::new().unwrap();
        save(root.path(), "good", &preset("good")).unwrap();
        fs::write(dir(root.path()).join("broken.json"), "{ half").unwrap();

        assert_eq!(list(root.path()).unwrap(), vec![preset("good")]);
    }

    #[test]
    fn anything_that_is_not_a_preset_file_is_ignored() {
        let root = TempDir::new().unwrap();
        save(root.path(), "good", &preset("good")).unwrap();
        fs::write(dir(root.path()).join("notes.txt"), "hello").unwrap();
        fs::create_dir_all(dir(root.path()).join("a-folder.json")).unwrap();

        assert_eq!(list(root.path()).unwrap().len(), 1);
    }

    #[test]
    fn a_preset_id_cannot_walk_out_of_the_presets_folder() {
        let root = TempDir::new().unwrap();

        for id in [
            "../../etc/passwd",
            "a/b",
            "..",
            ".",
            "",
            "with space",
            "dot.json",
        ] {
            assert!(
                save(root.path(), id, &preset(id)).is_err(),
                "accepted {id:?}"
            );
            assert!(delete(root.path(), id).is_err(), "accepted {id:?}");
        }

        assert!(save(root.path(), "forked_glass-01", &preset("x")).is_ok());
    }

    #[test]
    fn a_rejected_id_writes_nothing_at_all() {
        let root = TempDir::new().unwrap();

        assert!(save(root.path(), "../escape", &preset("escape")).is_err());

        assert!(!root.path().join("escape.json").exists());
        assert!(list(root.path()).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_preset_removes_only_that_one() {
        let root = TempDir::new().unwrap();
        save(root.path(), "keep", &preset("keep")).unwrap();
        save(root.path(), "drop", &preset("drop")).unwrap();

        delete(root.path(), "drop").unwrap();

        assert_eq!(list(root.path()).unwrap(), vec![preset("keep")]);
    }

    #[test]
    fn deleting_a_preset_that_is_already_gone_is_not_an_error() {
        let root = TempDir::new().unwrap();
        assert!(delete(root.path(), "never-existed").is_ok());
    }

    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        let root = TempDir::new().unwrap();
        save(root.path(), "forked-glass", &preset("forked-glass")).unwrap();

        let names: Vec<String> = fs::read_dir(dir(root.path()))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["forked-glass.json"]);
    }
}
