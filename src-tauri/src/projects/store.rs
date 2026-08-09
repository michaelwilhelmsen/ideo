//! Projects on disk — the source of truth (PRD §3.2).
//!
//! One folder per project, holding a `project.json` manifest and an `assets`
//! folder. The database next door is an index and nothing more: everything in
//! here works with the database deleted, which is the property the whole
//! arrangement exists to buy.
//!
//! **Rust owns the folder, not the schema.** The manifest crosses as opaque
//! JSON and is written back byte-for-byte, because the recipe model lives in
//! TypeScript (`src/lib/recipe/manifest.ts`) and widens with every slice. A
//! shape declared in two languages drifts, and worse, a manifest written by a
//! newer build would lose whatever this one failed to model. The few fields
//! read here — id, name, aspect, timestamps, asset names — are read out of the
//! document rather than deserialised into a struct that claims to be it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::atomic::write_atomically;

/// The manifest file inside a project folder.
const MANIFEST_FILE: &str = "project.json";

/// Where a project's generated files live, and the only place cleanup looks.
const ASSETS_DIR: &str = "assets";

/// A project id is a folder name, so it is checked rather than trusted — it
/// arrives from the webview, and a manifest can be hand-edited.
const MAX_ID_LEN: usize = 64;

/// One row of the project list. Cheap enough to hold for every project, which
/// is the point of having an index at all (PRD §3.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub aspect: String,
    /// Milliseconds since the epoch. `f64` because that is what a JS number is
    /// — an `i64` would cross the boundary as a string and buy nothing.
    pub created_at: f64,
    pub updated_at: f64,
    pub generation_count: u32,
    /// Where the manifest was found. Not stored in the manifest: a copied
    /// folder must not insist it still lives where it was copied from.
    pub directory: String,
}

/// A loaded project: the manifest, and where it came from.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub directory: String,
    /// Opaque here, validated in TypeScript. See the module comment.
    pub manifest: Value,
}

/// What a project costs on disk, and how much of that nothing refers to
/// (PRD §10.3 — the visible pressure valve).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub total_bytes: f64,
    pub asset_count: u32,
    /// Files in `assets` no generation refers to.
    pub unused_bytes: f64,
    pub unused_count: u32,
}

/// The result of a cleanup, so the UI can say what it actually did rather than
/// "done".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    pub removed_count: u32,
    pub freed_bytes: f64,
}

/// Rejects anything that is not a plain folder name.
///
/// The id reaches here from the webview and from manifests on disk, so this is
/// the boundary where "a project id" stops being a string someone supplied.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(format!("Project id has an implausible length: {id:?}"));
    }

    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Project id has characters a folder cannot: {id:?}"));
    }

    Ok(())
}

pub fn project_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(root.join(id))
}

/// Every project folder that holds a manifest.
///
/// This is what makes the database rebuildable: the disk is walked, and any
/// folder without a manifest is not a project, whatever the index believes.
pub fn scan_ids(root: &Path) -> Vec<String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        // No root yet is not an error — it is an empty library.
        Err(_) => return Vec::new(),
    };

    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_id(&name).is_err() {
                return None;
            }
            entry.path().join(MANIFEST_FILE).is_file().then_some(name)
        })
        .collect();

    // Stable order so a rebuild is reproducible and tests do not chase the
    // filesystem's own ordering.
    ids.sort();
    ids
}

/// Where a project's generated files go.
pub fn assets_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(root, id)?.join(ASSETS_DIR))
}

/// The file name a generation's image is saved under, whether it was
/// downloaded from fal or copied off the user's disk (#27).
///
/// Named after the generation rather than its origin, because the manifest
/// refers to candidates by generation id — a file named anything else would be
/// an orphan the moment cleanup looked at it, and an upload has to be
/// indistinguishable from a generation once it has landed.
///
/// The id is filtered rather than trusted: it reaches here from the webview.
pub fn asset_file_name(generation_id: &str, extension: &str) -> String {
    format!("{}.{extension}", asset_stem(generation_id))
}

/// The file name a generation's image carries, without its extension.
///
/// Separate from `asset_file_name` because reading an asset back has to find it
/// without knowing which of the three formats it was saved in — a source may be
/// a PNG the user dropped in or a JPEG fal produced, and the style stage has to
/// send either one (#28).
fn asset_stem(generation_id: &str) -> String {
    let stem: String = generation_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();

    if stem.is_empty() {
        "generation".to_string()
    } else {
        stem
    }
}

/// The file one generation produced, whatever extension it ended up with.
///
/// `None` rather than an error when there is no such file: a generation with no
/// asset is a normal state — a fixture-driven candidate, or one whose job has
/// not landed — and the caller decides whether that is fatal. Matched on the
/// stem rather than read out of the manifest so this answers for a project
/// whose manifest the running build cannot parse, and so a style run does not
/// depend on the schema Rust deliberately does not model.
pub fn asset_path(
    root: &Path,
    project_id: &str,
    generation_id: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = assets_dir(root, project_id)?;
    let wanted = asset_stem(generation_id);

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        // No assets folder is an empty one, not a failure.
        Err(_) => return Ok(None),
    };

    let mut found: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.metadata().map(|m| m.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem == wanted)
        })
        .collect();

    // Stable, so a folder holding both a `.png` and a `.jpeg` for one
    // generation does not send a different file on each run.
    found.sort();

    Ok(found.into_iter().next())
}

/// Reads a project, with the folder as the last word on its identity.
///
/// The folder name wins over whatever `id` the manifest claims. A folder
/// duplicated in Finder — a plausible way to fork a project in a tool whose
/// output is meant to be Finder-inspectable — otherwise carries the original's
/// id, and would save itself back over the project it was copied from.
pub fn load(root: &Path, id: &str) -> Result<ProjectRecord, String> {
    let dir = project_dir(root, id)?;
    let mut manifest = read_manifest(&dir)?;

    if field_str(&manifest, "id") != Some(id) {
        log::info!("Project folder {id} holds a manifest claiming another id");
        manifest["id"] = Value::String(id.to_string());
    }

    Ok(ProjectRecord {
        directory: dir.to_string_lossy().to_string(),
        manifest,
    })
}

/// Writes the manifest and returns the summary the index should now hold.
///
/// The write is atomic (PRD §3.2, and the template's own rule): a full temp
/// file is flushed to the filesystem and then renamed over the old one, so a
/// crash leaves either the previous manifest or this one — never half of
/// either.
pub fn save(root: &Path, manifest: &Value) -> Result<ProjectSummary, String> {
    let id = field_str(manifest, "id").ok_or("Manifest has no id")?;
    let dir = project_dir(root, id)?;

    fs::create_dir_all(dir.join(ASSETS_DIR))
        .map_err(|e| format!("Could not create the project folder: {e}"))?;

    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Could not serialise the manifest: {e}"))?;

    write_atomically(&dir.join(MANIFEST_FILE), json.as_bytes())?;

    summarize(manifest, &dir)
}

/// Deletes a project outright — folder, assets and all.
///
/// The one place anything is deleted without being asked twice, which is why
/// the caller is expected to have asked (PRD §10.3 keeps *candidates*, not
/// projects the user has explicitly thrown away).
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let dir = project_dir(root, id)?;

    if !dir.exists() {
        return Ok(());
    }

    fs::remove_dir_all(&dir).map_err(|e| format!("Could not delete the project folder: {e}"))
}

/// What the project costs, and how much of that is unreferenced.
pub fn usage(root: &Path, id: &str) -> Result<ProjectUsage, String> {
    let dir = project_dir(root, id)?;
    let referenced = referenced_assets(&read_manifest(&dir)?);

    let mut usage = ProjectUsage {
        total_bytes: manifest_size(&dir),
        asset_count: 0,
        unused_bytes: 0.0,
        unused_count: 0,
    };

    for (name, size) in asset_files(&dir) {
        usage.total_bytes += size as f64;
        usage.asset_count += 1;

        if !referenced.contains(&name) {
            usage.unused_bytes += size as f64;
            usage.unused_count += 1;
        }
    }

    Ok(usage)
}

/// Removes the files in `assets` that no generation refers to.
///
/// Deliberate rather than automatic (PRD §10.3): "actually the second one was
/// better" happens constantly and re-rolling costs money, so nothing is
/// discarded until someone asks for it. What this removes is only what the
/// manifest has already stopped pointing at.
pub fn cleanup_unused(root: &Path, id: &str) -> Result<CleanupOutcome, String> {
    let dir = project_dir(root, id)?;
    let referenced = referenced_assets(&read_manifest(&dir)?);

    let mut outcome = CleanupOutcome {
        removed_count: 0,
        freed_bytes: 0.0,
    };

    for (name, size) in asset_files(&dir) {
        if referenced.contains(&name) {
            continue;
        }

        match fs::remove_file(dir.join(ASSETS_DIR).join(&name)) {
            Ok(()) => {
                outcome.removed_count += 1;
                outcome.freed_bytes += size as f64;
            }
            // One stubborn file is not a reason to abandon the rest.
            Err(e) => log::warn!("Could not remove unused asset {name}: {e}"),
        }
    }

    Ok(outcome)
}

/// The index row a manifest implies. Reads the document rather than
/// deserialising it — see the module comment.
pub fn summarize(manifest: &Value, dir: &Path) -> Result<ProjectSummary, String> {
    Ok(ProjectSummary {
        id: field_str(manifest, "id")
            .ok_or("Manifest has no id")?
            .to_string(),
        name: field_str(manifest, "name")
            .unwrap_or("Untitled")
            .to_string(),
        aspect: field_str(manifest, "aspect").unwrap_or("16:9").to_string(),
        created_at: field_f64(manifest, "createdAt"),
        updated_at: field_f64(manifest, "updatedAt"),
        generation_count: manifest
            .get("generations")
            .and_then(Value::as_array)
            .map(|generations| generations.len() as u32)
            .unwrap_or(0),
        directory: dir.to_string_lossy().to_string(),
    })
}

fn read_manifest(dir: &Path) -> Result<Value, String> {
    let path = dir.join(MANIFEST_FILE);

    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;

    serde_json::from_str(&contents)
        .map_err(|e| format!("{} is not readable JSON: {e}", path.display()))
}

/// Every asset name the manifest still points at.
fn referenced_assets(manifest: &Value) -> std::collections::HashSet<String> {
    manifest
        .get("generations")
        .and_then(Value::as_array)
        .map(|generations| {
            generations
                .iter()
                .filter_map(|generation| field_str(generation, "asset"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The files in the assets folder, with their sizes. Folders are ignored —
/// nothing writes one, and recursing would make cleanup's blast radius depend
/// on something we do not control.
fn asset_files(dir: &Path) -> Vec<(String, u64)> {
    let entries = match fs::read_dir(dir.join(ASSETS_DIR)) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    entry.file_name().to_string_lossy().to_string(),
                    metadata.len(),
                )
            })
        })
        .collect()
}

fn manifest_size(dir: &Path) -> f64 {
    fs::metadata(dir.join(MANIFEST_FILE))
        .map(|m| m.len() as f64)
        .unwrap_or(0.0)
}

fn field_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn field_f64(value: &Value, field: &str) -> f64 {
    value.get(field).and_then(Value::as_f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn manifest(id: &str, generations: Value) -> Value {
        json!({
            "version": 1,
            "id": id,
            "name": "Atlas — hero",
            "aspect": "21:9",
            "createdAt": 1_700_000_000_000_i64,
            "updatedAt": 1_700_000_000_001_i64,
            "drafts": {},
            "selection": {},
            "generations": generations,
        })
    }

    fn write_asset(root: &Path, id: &str, name: &str, bytes: usize) {
        let path = root.join(id).join(ASSETS_DIR).join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn a_saved_project_comes_back_exactly_as_it_went_in() {
        let root = TempDir::new().unwrap();
        let original = manifest("atlas", json!([{ "id": "gen-1", "asset": "gen-1.jpeg" }]));

        save(root.path(), &original).unwrap();

        assert_eq!(load(root.path(), "atlas").unwrap().manifest, original);
    }

    #[test]
    fn fields_this_build_does_not_model_survive_a_round_trip() {
        // The manifest is the source of truth and a newer build may have
        // written it. Dropping what we cannot model would silently downgrade
        // the recipe — the one artefact PRD §1 says is expensive.
        let root = TempDir::new().unwrap();
        let mut original = manifest("atlas", json!([]));
        original["upscale"] = json!({ "factor": 4 });

        save(root.path(), &original).unwrap();

        assert_eq!(
            load(root.path(), "atlas").unwrap().manifest["upscale"]["factor"],
            json!(4)
        );
    }

    #[test]
    fn saving_reports_the_row_the_index_should_hold() {
        let root = TempDir::new().unwrap();

        let summary = save(root.path(), &manifest("atlas", json!([{}, {}]))).unwrap();

        assert_eq!(summary.id, "atlas");
        assert_eq!(summary.name, "Atlas — hero");
        assert_eq!(summary.aspect, "21:9");
        assert_eq!(summary.generation_count, 2);
        assert_eq!(summary.created_at, 1_700_000_000_000.0);
    }

    #[test]
    fn a_save_leaves_no_temp_file_behind() {
        // A stray `project.json.tmp` is what a half-written folder looks like
        // to anyone inspecting it in Finder.
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([]))).unwrap();

        let names: Vec<String> = fs::read_dir(root.path().join("atlas"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "got: {names:?}");
    }

    #[test]
    fn an_interrupted_write_leaves_the_previous_manifest_intact() {
        // Simulates the crash the atomic write exists for: a temp file that
        // never got renamed. The old manifest must still be the one that
        // loads, and its contents must be untouched.
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([{ "id": "gen-1" }]))).unwrap();

        fs::write(
            root.path().join("atlas").join("project.json.tmp"),
            "{ \"half\": ",
        )
        .unwrap();

        let loaded = load(root.path(), "atlas").unwrap();
        assert_eq!(loaded.manifest["generations"][0]["id"], json!("gen-1"));
    }

    #[test]
    fn every_project_folder_holding_a_manifest_is_found() {
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([]))).unwrap();
        save(root.path(), &manifest("ledger", json!([]))).unwrap();
        // A folder with no manifest is not a project, whatever else it holds.
        fs::create_dir_all(root.path().join("not-a-project")).unwrap();

        assert_eq!(scan_ids(root.path()), vec!["atlas", "ledger"]);
    }

    #[test]
    fn an_empty_library_scans_clean_rather_than_failing() {
        let root = TempDir::new().unwrap();
        assert!(scan_ids(&root.path().join("never-created")).is_empty());
    }

    #[test]
    fn deleting_a_project_takes_its_assets_with_it() {
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([]))).unwrap();
        write_asset(root.path(), "atlas", "gen-1.jpeg", 10);

        delete(root.path(), "atlas").unwrap();

        assert!(!root.path().join("atlas").exists());
        assert!(scan_ids(root.path()).is_empty());
    }

    #[test]
    fn deleting_a_project_that_is_already_gone_is_not_an_error() {
        let root = TempDir::new().unwrap();
        assert!(delete(root.path(), "never-existed").is_ok());
    }

    #[test]
    fn usage_counts_the_assets_and_names_the_unreferenced_ones() {
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            &manifest("atlas", json!([{ "id": "gen-1", "asset": "kept.jpeg" }])),
        )
        .unwrap();
        write_asset(root.path(), "atlas", "kept.jpeg", 100);
        write_asset(root.path(), "atlas", "orphan.jpeg", 40);

        let usage = usage(root.path(), "atlas").unwrap();

        assert_eq!(usage.asset_count, 2);
        assert_eq!(usage.unused_count, 1);
        assert_eq!(usage.unused_bytes, 40.0);
        // The manifest itself is part of what the project costs.
        assert!(usage.total_bytes > 140.0);
    }

    #[test]
    fn cleanup_removes_only_what_nothing_points_at() {
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            &manifest("atlas", json!([{ "id": "gen-1", "asset": "kept.jpeg" }])),
        )
        .unwrap();
        write_asset(root.path(), "atlas", "kept.jpeg", 100);
        write_asset(root.path(), "atlas", "orphan.jpeg", 40);

        let outcome = cleanup_unused(root.path(), "atlas").unwrap();

        assert_eq!(outcome.removed_count, 1);
        assert_eq!(outcome.freed_bytes, 40.0);
        assert!(root.path().join("atlas/assets/kept.jpeg").exists());
        assert!(!root.path().join("atlas/assets/orphan.jpeg").exists());
    }

    #[test]
    fn cleanup_keeps_the_file_of_a_rejected_candidate() {
        // PRD §10.3 — a rejected candidate is a filter, not a tombstone. It is
        // still in the manifest, so its file is still referenced.
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            &manifest(
                "atlas",
                json!([{ "id": "gen-1", "asset": "rejected.jpeg", "verdict": "rejected" }]),
            ),
        )
        .unwrap();
        write_asset(root.path(), "atlas", "rejected.jpeg", 100);

        assert_eq!(
            cleanup_unused(root.path(), "atlas").unwrap().removed_count,
            0
        );
    }

    #[test]
    fn a_project_id_cannot_walk_out_of_the_projects_folder() {
        let root = TempDir::new().unwrap();

        assert!(project_dir(root.path(), "../../etc").is_err());
        assert!(project_dir(root.path(), "a/b").is_err());
        assert!(project_dir(root.path(), "").is_err());
        assert!(project_dir(root.path(), "atlas-01_A").is_ok());
    }

    #[test]
    fn the_folder_has_the_last_word_on_which_project_this_is() {
        // A folder duplicated in Finder is a plausible way to fork a project
        // in a tool whose output is meant to be inspectable there. Believing
        // the manifest would make the copy save itself over the original.
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([]))).unwrap();

        let copy = root.path().join("atlas-copy");
        fs::create_dir_all(&copy).unwrap();
        fs::copy(
            root.path().join("atlas/project.json"),
            copy.join("project.json"),
        )
        .unwrap();

        assert_eq!(
            load(root.path(), "atlas-copy").unwrap().manifest["id"],
            json!("atlas-copy")
        );
    }

    #[test]
    fn a_generations_file_is_found_whichever_format_it_was_saved_in() {
        // The style stage has to send the source to fal, and the source may be
        // a PNG the user dropped in or a JPEG fal produced (#28).
        let root = TempDir::new().unwrap();
        write_asset(root.path(), "atlas", "gen-1.png", 3);

        let path = asset_path(root.path(), "atlas", "gen-1").unwrap();

        assert_eq!(path.unwrap().file_name().unwrap(), "gen-1.png");
    }

    #[test]
    fn a_generation_with_no_file_is_absent_rather_than_an_error() {
        let root = TempDir::new().unwrap();
        write_asset(root.path(), "atlas", "gen-1.png", 3);

        assert_eq!(asset_path(root.path(), "atlas", "gen-2").unwrap(), None);
        // A project with no assets folder at all answers the same way.
        assert_eq!(asset_path(root.path(), "ledger", "gen-1").unwrap(), None);
    }

    #[test]
    fn looking_up_an_asset_cannot_walk_out_of_the_project() {
        let root = TempDir::new().unwrap();

        assert!(asset_path(root.path(), "../../etc", "gen-1").is_err());
        // A traversing generation id is filtered to a plain stem, so the worst
        // it can do is fail to match anything.
        assert_eq!(
            asset_path(root.path(), "atlas", "../../../etc/passwd").unwrap(),
            None
        );
    }

    #[test]
    fn a_manifest_with_no_id_is_refused_rather_than_filed_somewhere() {
        let root = TempDir::new().unwrap();
        assert!(save(root.path(), &json!({ "name": "nameless" })).is_err());
    }
}
