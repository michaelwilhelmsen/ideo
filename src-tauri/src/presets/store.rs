//! User presets on disk: one JSON file per preset, under `presets/`.
//!
//! See the module comment in `presets/mod.rs` for why these live at app level,
//! why their contents are opaque here, and why the library is a parameter.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::atomic::write_atomically;

/// The folder under `app_data_dir` style presets are kept in.
const PRESETS_DIR: &str = "presets";

/// And the one motion presets are kept in — a second, independent library (#29).
///
/// Nested under the first rather than beside it because it *is* a preset
/// library, and because `list` only ever looks at files: a folder inside
/// `presets/` is already skipped by the same filter that skips `notes.txt`.
const MOTION_PRESETS_DIR: &str = "presets/motion";

/// And the third — scenes rather than looks (#47), nested for the same reason.
const SOURCE_PRESETS_DIR: &str = "presets/source";

/// Where saved palettes go (#49) — beside `presets/`, not inside it.
///
/// The one folder here that is not nested, because a palette is not a preset: it
/// seeds no stage and composes no prompt, it is six colours a project copies in.
/// What it shares with the three is the *storage* problem — one validated-id JSON
/// document per file, written atomically — which is why it is a variant here
/// rather than a second copy of this module.
const PALETTES_DIR: &str = "palettes";

/// Which library a call is about.
///
/// An enum rather than the folder name itself, because a folder name is a
/// **path**. Threaded as `&str` through `dir`, `list`, `save` and `delete` it
/// only takes one call site passing something else — a typo, or worse a string
/// that came from outside — for presets to be read from or written to a
/// directory this module does not own, and `validate_id` guards the file name
/// and not the folder. Closed here, at the only place these constants are
/// read, so the set of writable directories is fixed at compile time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Library {
    /// Looks (#28) — `presets/`.
    Style,
    /// Movements (#29) — `presets/motion/`.
    Motion,
    /// Scenes (#47) — `presets/source/`.
    Source,
    /// Palettes (#49) — `palettes/`, beside the presets rather than under them.
    Palette,
}

impl Library {
    /// The folder under `app_data_dir`, relative.
    fn folder(self) -> &'static str {
        match self {
            Self::Style => PRESETS_DIR,
            Self::Motion => MOTION_PRESETS_DIR,
            Self::Source => SOURCE_PRESETS_DIR,
            Self::Palette => PALETTES_DIR,
        }
    }
}

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

/// Where one library lives, given the app data directory and which library.
pub fn dir(app_data: &Path, library: Library) -> PathBuf {
    app_data.join(library.folder())
}

fn preset_path(app_data: &Path, library: Library, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(dir(app_data, library).join(format!("{id}.json")))
}

/// Every preset document in the library, in a stable order.
///
/// A file that is not JSON at all is logged and skipped: it cannot become a
/// `Value`, and withholding the rest of somebody's library over one bad file
/// would be the wrong trade. Whether a *parseable* document is a valid preset is
/// not asked here — that is `readPresetLibrary`'s job, and it fails loudly.
pub fn list(app_data: &Path, library: Library) -> Result<Vec<Value>, String> {
    let dir = dir(app_data, library);

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
pub fn save(app_data: &Path, library: Library, id: &str, document: &Value) -> Result<(), String> {
    let path = preset_path(app_data, library, id)?;

    fs::create_dir_all(dir(app_data, library))
        .map_err(|e| format!("Could not create the presets folder: {e}"))?;

    let json = serde_json::to_string_pretty(document)
        .map_err(|e| format!("Could not serialise the preset: {e}"))?;

    write_atomically(&path, json.as_bytes())
}

/// Removes one preset. Deleting one that is already gone is not an error — the
/// caller wanted it absent, and it is.
pub fn delete(app_data: &Path, library: Library, id: &str) -> Result<(), String> {
    let path = preset_path(app_data, library, id)?;

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

        save(
            root.path(),
            Library::Style,
            "forked-glass",
            &preset("forked-glass"),
        )
        .unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("forked-glass")]
        );
    }

    #[test]
    fn fields_this_build_does_not_model_survive_a_round_trip() {
        // The schema is TypeScript's and widens with every slice; dropping what
        // Rust cannot model would quietly downgrade somebody's fork.
        let root = TempDir::new().unwrap();
        let mut document = preset("forked-glass");
        document["variants"]["tags"] = json!({ "transform": "x", "unknownToRust": 4 });

        save(root.path(), Library::Style, "forked-glass", &document).unwrap();

        assert_eq!(list(root.path(), Library::Style).unwrap(), vec![document]);
    }

    #[test]
    fn an_empty_library_lists_clean_rather_than_failing() {
        let root = TempDir::new().unwrap();
        assert!(list(&root.path().join("never-created"), Library::Style)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn saving_the_same_id_twice_updates_it_in_place() {
        // Updating one of your own presets is the other half of the fork flow.
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            Library::Style,
            "forked-glass",
            &preset("forked-glass"),
        )
        .unwrap();

        let mut edited = preset("forked-glass");
        edited["name"] = json!("Forked glass, warmer");
        save(root.path(), Library::Style, "forked-glass", &edited).unwrap();

        let library = list(root.path(), Library::Style).unwrap();
        assert_eq!(library.len(), 1);
        assert_eq!(library[0]["name"], json!("Forked glass, warmer"));
    }

    #[test]
    fn the_library_is_listed_in_a_stable_order() {
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Style, "second", &preset("second")).unwrap();
        save(root.path(), Library::Style, "first", &preset("first")).unwrap();

        let library = list(root.path(), Library::Style).unwrap();
        let ids: Vec<&str> = library
            .iter()
            .map(|document| document["id"].as_str().unwrap())
            .collect();

        assert_eq!(ids, vec!["first", "second"]);
    }

    #[test]
    fn a_file_that_is_not_json_is_skipped_rather_than_failing_the_library() {
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Style, "good", &preset("good")).unwrap();
        fs::write(
            dir(root.path(), Library::Style).join("broken.json"),
            "{ half",
        )
        .unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("good")]
        );
    }

    #[test]
    fn anything_that_is_not_a_preset_file_is_ignored() {
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Style, "good", &preset("good")).unwrap();
        fs::write(dir(root.path(), Library::Style).join("notes.txt"), "hello").unwrap();
        fs::create_dir_all(dir(root.path(), Library::Style).join("a-folder.json")).unwrap();

        assert_eq!(list(root.path(), Library::Style).unwrap().len(), 1);
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
                save(root.path(), Library::Style, id, &preset(id)).is_err(),
                "accepted {id:?}"
            );
            assert!(
                delete(root.path(), Library::Style, id).is_err(),
                "accepted {id:?}"
            );
        }

        assert!(save(root.path(), Library::Style, "forked_glass-01", &preset("x")).is_ok());
    }

    #[test]
    fn a_rejected_id_writes_nothing_at_all() {
        let root = TempDir::new().unwrap();

        assert!(save(root.path(), Library::Style, "../escape", &preset("escape")).is_err());

        assert!(!root.path().join("escape.json").exists());
        assert!(list(root.path(), Library::Style).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_preset_removes_only_that_one() {
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Style, "keep", &preset("keep")).unwrap();
        save(root.path(), Library::Style, "drop", &preset("drop")).unwrap();

        delete(root.path(), Library::Style, "drop").unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("keep")]
        );
    }

    #[test]
    fn deleting_a_preset_that_is_already_gone_is_not_an_error() {
        let root = TempDir::new().unwrap();
        assert!(delete(root.path(), Library::Style, "never-existed").is_ok());
    }

    fn motion(id: &str) -> Value {
        json!({ "version": 1, "id": id, "name": "My drift", "prompt": "a slow drift" })
    }

    fn scene(id: &str) -> Value {
        json!({
            "version": 1,
            "id": id,
            "name": "My monolith",
            "family": "user",
            "aspect": "3:2",
            "variants": { "prose": null, "tags": null },
        })
    }

    #[test]
    fn the_three_libraries_are_independent_even_when_ids_collide() {
        // #29, #47 — a scene, a look and a movement are three separate choices,
        // so a fork called "warm" in one library must not be able to shadow or
        // clobber a fork called "warm" in another. Same id, three folders,
        // three files.
        let root = TempDir::new().unwrap();

        save(root.path(), Library::Style, "warm", &preset("warm")).unwrap();
        save(root.path(), Library::Motion, "warm", &motion("warm")).unwrap();
        save(root.path(), Library::Source, "warm", &scene("warm")).unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("warm")]
        );
        assert_eq!(
            list(root.path(), Library::Motion).unwrap(),
            vec![motion("warm")]
        );
        assert_eq!(
            list(root.path(), Library::Source).unwrap(),
            vec![scene("warm")]
        );

        delete(root.path(), Library::Motion, "warm").unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("warm")]
        );
        assert_eq!(
            list(root.path(), Library::Source).unwrap(),
            vec![scene("warm")]
        );
        assert!(list(root.path(), Library::Motion).unwrap().is_empty());
    }

    #[test]
    fn the_nested_libraries_are_not_mistaken_for_style_presets() {
        // Both nested libraries sit inside `presets/`, and `list` only reads
        // files — so the folders are skipped by the same filter that skips a
        // stray `notes.txt` rather than by a rule of their own.
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Motion, "drift", &motion("drift")).unwrap();
        save(root.path(), Library::Source, "monolith", &scene("monolith")).unwrap();

        assert!(list(root.path(), Library::Style).unwrap().is_empty());
    }

    #[test]
    fn a_source_preset_id_cannot_walk_out_of_its_folder_either() {
        let root = TempDir::new().unwrap();

        assert!(save(root.path(), Library::Source, "../escape", &scene("escape")).is_err());
        assert!(delete(root.path(), Library::Source, "a/b").is_err());
        assert!(!root.path().join("presets").join("escape.json").exists());
    }

    #[test]
    fn a_motion_preset_id_cannot_walk_out_of_its_folder_either() {
        let root = TempDir::new().unwrap();

        assert!(save(root.path(), Library::Motion, "../escape", &motion("escape")).is_err());
        assert!(delete(root.path(), Library::Motion, "a/b").is_err());
        assert!(!root.path().join("presets").join("escape.json").exists());
    }

    fn palette(id: &str) -> Value {
        json!({
            "version": 1,
            "id": id,
            "name": "My palette",
            "roles": { "primary": { "hex": "#D9662C" } },
            "extras": [],
        })
    }

    #[test]
    fn palettes_are_kept_beside_the_presets_rather_than_inside_them() {
        // A palette is not a preset — it seeds no stage and composes no prompt
        // — so its folder is not one `presets/` contains.
        let root = TempDir::new().unwrap();
        save(root.path(), Library::Palette, "dusk", &palette("dusk")).unwrap();

        assert!(root.path().join("palettes").join("dusk.json").is_file());
        assert!(!root.path().join("presets").exists());
        assert_eq!(
            list(root.path(), Library::Palette).unwrap(),
            vec![palette("dusk")]
        );
    }

    #[test]
    fn a_palette_id_cannot_walk_out_of_its_folder_either() {
        let root = TempDir::new().unwrap();

        assert!(save(
            root.path(),
            Library::Palette,
            "../escape",
            &palette("escape")
        )
        .is_err());
        assert!(delete(root.path(), Library::Palette, "a/b").is_err());
        assert!(!root.path().join("escape.json").exists());
    }

    #[test]
    fn a_palette_and_a_preset_may_share_an_id() {
        // Nothing records a palette id, so it joins no uniqueness rule: two
        // folders, two files, neither shadowing the other.
        let root = TempDir::new().unwrap();

        save(root.path(), Library::Style, "warm", &preset("warm")).unwrap();
        save(root.path(), Library::Palette, "warm", &palette("warm")).unwrap();

        assert_eq!(
            list(root.path(), Library::Style).unwrap(),
            vec![preset("warm")]
        );
        assert_eq!(
            list(root.path(), Library::Palette).unwrap(),
            vec![palette("warm")]
        );
    }

    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            Library::Style,
            "forked-glass",
            &preset("forked-glass"),
        )
        .unwrap();

        let names: Vec<String> = fs::read_dir(dir(root.path(), Library::Style))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["forked-glass.json"]);
    }
}
