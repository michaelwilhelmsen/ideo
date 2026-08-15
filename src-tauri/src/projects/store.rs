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

use super::thumbnail;
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
    /// When this project last actually produced something — the newest
    /// generation's creation time, falling back to the project's own.
    ///
    /// Deliberately **not** `updated_at` (ADR 0004). The overview is ordered by
    /// this, and renaming a project writes the manifest: sorting on the file's
    /// timestamp would put a rename at the front of a grid whose whole subject
    /// is work.
    pub latest_activity_at: f64,
    /// The card's picture, as a bare name inside `assets` — never a path, for
    /// the reason a generation's asset is not one (PRD §3.2).
    ///
    /// `None` while a project has nothing to show, or while a clip is waiting
    /// for the webview to draw its poster.
    pub thumbnail: Option<String>,
    /// The generation's own file, which the card's thumbnail was made from.
    ///
    /// Carried because a card with no poster and a video here is precisely the
    /// case the webview has to capture a frame from (ADR 0004).
    pub thumbnail_asset: Option<String>,
    /// Whether that file is a clip — a card shows a play affordance rather than
    /// an autoplaying element (ADR 0004).
    pub thumbnail_is_video: bool,
    /// What the project has cost, in USD, as far as anything can tell.
    ///
    /// Per generation, fal's confirmed charge where there is one and the
    /// estimate stamped at collection where there is not (ADR 0003). Never a
    /// mix of both for the same candidate: an `actualCostUsd` *replaces* its
    /// estimate rather than being added to it.
    pub cost_usd: f64,
    /// Generations carrying no cost at all — token-priced models never
    /// reconciled, and anything recorded before costs were stamped. Named
    /// rather than folded into the sum, so "unknown" and "free" never look the
    /// same (ADR 0003).
    pub uncosted_count: u32,
    /// Generations whose cost is fal's own figure rather than our estimate.
    ///
    /// The whole reason the sum can ever drop its tilde: a total is exact only
    /// when this equals `generation_count` (ADR 0003). Counted here rather than
    /// worked out on the card, because the overview must not open a manifest to
    /// draw a grid.
    pub reconciled_count: u32,
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

        if !is_spoken_for(&name, &referenced) {
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
        if is_spoken_for(&name, &referenced) {
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
///
/// Writes a thumbnail as a side effect when the card's picture does not have
/// one yet (ADR 0004). That is what makes them derived data rather than a
/// second source of truth: this runs on every save *and* on every reconcile, so
/// deleting the whole `assets` folder's worth of thumbnails costs one listing.
pub fn summarize(manifest: &Value, dir: &Path) -> Result<ProjectSummary, String> {
    let created_at = field_f64(manifest, "createdAt");
    let generations = manifest
        .get("generations")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let thumbnail_asset = card_asset(generations);
    let thumbnail = thumbnail_asset
        .as_deref()
        .and_then(|asset| thumbnail::ensure(&dir.join(ASSETS_DIR), asset));

    Ok(ProjectSummary {
        id: field_str(manifest, "id")
            .ok_or("Manifest has no id")?
            .to_string(),
        name: field_str(manifest, "name")
            .unwrap_or("Untitled")
            .to_string(),
        aspect: field_str(manifest, "aspect").unwrap_or("16:9").to_string(),
        created_at,
        updated_at: field_f64(manifest, "updatedAt"),
        generation_count: generations.len() as u32,
        directory: dir.to_string_lossy().to_string(),
        latest_activity_at: generations
            .iter()
            .map(|generation| field_f64(generation, "createdAt"))
            .fold(f64::NEG_INFINITY, f64::max)
            .max(created_at),
        thumbnail_is_video: thumbnail_asset.as_deref().is_some_and(thumbnail::is_video),
        thumbnail,
        thumbnail_asset,
        cost_usd: generations.iter().filter_map(charged).sum(),
        uncosted_count: generations
            .iter()
            .filter(|generation| charged(generation).is_none())
            .count() as u32,
        reconciled_count: generations
            .iter()
            .filter(|generation| actual_cost(generation).is_some())
            .count() as u32,
    })
}

/// What one generation cost, or `None` when nothing honest can be said.
///
/// fal's figure wins wherever there is one, and the estimate is the fallback
/// rather than a second term (ADR 0003) — a reconciled candidate has been
/// charged once. `None` is a real answer: a token-priced model outside the
/// billing window has no number at all, and counting it as zero would report a
/// project of them as free.
fn charged(generation: &Value) -> Option<f64> {
    actual_cost(generation).or_else(|| finite(generation.get("costUsd")))
}

fn actual_cost(generation: &Value) -> Option<f64> {
    finite(generation.get("actualCostUsd"))
}

/// A number the sum can carry. A hand-edited `NaN` would make a whole project's
/// total unreadable, which is a worse failure than one missing figure.
fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite())
}

/// The generation whose picture the card shows.
///
/// Approved first, then unrated, then rejected — and newest within each tier
/// (#55). A card must not show back an image the user explicitly turned down
/// unless that is all the project has; showing nothing instead would be worse,
/// because a rejected candidate is a filter and not a tombstone (PRD §10.3).
fn card_asset(generations: &[Value]) -> Option<String> {
    /// Lower sorts first.
    fn tier(generation: &Value) -> u8 {
        match field_str(generation, "verdict") {
            Some("approved") => 0,
            Some("rejected") => 2,
            // An unreadable verdict reads as unrated, the same way the manifest
            // reader treats one.
            _ => 1,
        }
    }

    generations
        .iter()
        .filter(|generation| field_str(generation, "asset").is_some())
        .min_by(|a, b| {
            tier(a).cmp(&tier(b)).then_with(|| {
                field_f64(b, "createdAt")
                    .partial_cmp(&field_f64(a, "createdAt"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .and_then(|generation| field_str(generation, "asset"))
        .map(str::to_string)
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

/// Whether something still points at this file.
///
/// A thumbnail is spoken for by the generation it was made from, even though
/// nothing in the manifest names it (ADR 0004): thumbnails are derived, so the
/// manifest deliberately does not record them, and a cleanup that only asked
/// the manifest would offer to reclaim every card picture in the library —
/// then draw them all again on the next listing.
fn is_spoken_for(name: &str, referenced: &std::collections::HashSet<String>) -> bool {
    if referenced.contains(name) {
        return true;
    }

    let Some(stem) = thumbnail::thumbnailed_stem(name) else {
        return false;
    };

    referenced.iter().any(|asset| {
        Path::new(asset)
            .file_stem()
            .and_then(|asset_stem| asset_stem.to_str())
            .is_some_and(|asset_stem| asset_stem == stem)
    })
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

    /// A real, decodable still — thumbnailing decodes what it is pointed at.
    fn write_still(root: &Path, id: &str, name: &str, width: u32, height: u32) {
        let image = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .expect("a synthetic PNG encodes");

        let path = root.join(id).join(ASSETS_DIR).join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, out.into_inner()).unwrap();
    }

    fn generation(id: &str, asset: &str, verdict: &str, created_at: i64) -> Value {
        json!({
            "id": id,
            "asset": asset,
            "verdict": verdict,
            "createdAt": created_at,
        })
    }

    #[test]
    fn the_card_shows_the_newest_approved_generation() {
        // #55 — a card must not show back an image the user turned down.
        let root = TempDir::new().unwrap();
        save(
            root.path(),
            &manifest(
                "atlas",
                json!([
                    generation("gen-1", "gen-1.png", "approved", 10),
                    generation("gen-2", "gen-2.png", "approved", 20),
                    generation("gen-3", "gen-3.png", "unrated", 30),
                    generation("gen-4", "gen-4.png", "rejected", 40),
                ]),
            ),
        )
        .unwrap();
        for name in ["gen-1.png", "gen-2.png", "gen-3.png", "gen-4.png"] {
            write_still(root.path(), "atlas", name, 800, 450);
        }

        let summary = save(
            root.path(),
            &load(root.path(), "atlas").unwrap().manifest.clone(),
        )
        .unwrap();

        assert_eq!(summary.thumbnail_asset.as_deref(), Some("gen-2.png"));
        assert_eq!(summary.thumbnail.as_deref(), Some("gen-2.thumb.jpg"));
    }

    #[test]
    fn a_rejected_candidate_is_shown_only_when_it_is_all_there_is() {
        let root = TempDir::new().unwrap();
        let with_unrated = manifest(
            "atlas",
            json!([
                generation("gen-1", "gen-1.png", "rejected", 40),
                generation("gen-2", "gen-2.png", "unrated", 10),
            ]),
        );
        save(root.path(), &with_unrated).unwrap();
        write_still(root.path(), "atlas", "gen-1.png", 400, 400);
        write_still(root.path(), "atlas", "gen-2.png", 400, 400);

        assert_eq!(
            save(root.path(), &with_unrated).unwrap().thumbnail_asset,
            Some("gen-2.png".to_string())
        );

        let only_rejected = manifest(
            "atlas",
            json!([generation("gen-1", "gen-1.png", "rejected", 40)]),
        );
        assert_eq!(
            save(root.path(), &only_rejected).unwrap().thumbnail_asset,
            Some("gen-1.png".to_string())
        );
    }

    #[test]
    fn recency_follows_the_newest_generation_not_the_file() {
        // #55's acceptance criterion: renaming a project must not move it to
        // the front of the overview.
        let root = TempDir::new().unwrap();
        let mut original = manifest(
            "atlas",
            json!([generation(
                "gen-1",
                "gen-1.png",
                "unrated",
                1_700_000_000_500_i64
            )]),
        );
        original["updatedAt"] = json!(1_700_000_009_000_i64);

        let before = save(root.path(), &original).unwrap();

        let mut renamed = original.clone();
        renamed["name"] = json!("Atlas, renamed");
        renamed["updatedAt"] = json!(1_700_000_999_999_i64);
        let after = save(root.path(), &renamed).unwrap();

        assert_eq!(before.latest_activity_at, 1_700_000_000_500.0);
        assert_eq!(after.latest_activity_at, before.latest_activity_at);
        assert_ne!(after.updated_at, before.updated_at);
    }

    #[test]
    fn a_project_with_no_generations_falls_back_to_when_it_was_made() {
        let root = TempDir::new().unwrap();
        let summary = save(root.path(), &manifest("atlas", json!([]))).unwrap();

        assert_eq!(summary.latest_activity_at, summary.created_at);
        assert_eq!(summary.thumbnail, None);
    }

    #[test]
    fn a_project_costs_what_its_generations_were_stamped_with() {
        let root = TempDir::new().unwrap();
        let summary = save(
            root.path(),
            &manifest(
                "atlas",
                json!([
                    { "id": "gen-1", "costUsd": 0.04 },
                    { "id": "gen-2", "costUsd": 0.011 },
                    // Token-priced, or recorded before costs were stamped.
                    { "id": "gen-3" },
                ]),
            ),
        )
        .unwrap();

        assert!((summary.cost_usd - 0.051).abs() < 1e-9);
        // Named rather than folded in, so "unknown" and "free" do not look the
        // same (ADR 0003).
        assert_eq!(summary.uncosted_count, 1);
        assert_eq!(summary.reconciled_count, 0);
    }

    #[test]
    fn a_reconciled_generation_reports_fals_charge_rather_than_our_estimate() {
        // ADR 0003 — the actual *replaces* the estimate. Adding them would
        // charge the user twice for one call.
        let root = TempDir::new().unwrap();
        let summary = save(
            root.path(),
            &manifest(
                "atlas",
                json!([
                    { "id": "gen-1", "costUsd": 0.04, "actualCostUsd": 0.037 },
                    // Token-priced: no estimate was possible, and fal answered
                    // for it anyway — which is exactly what reconciliation buys.
                    { "id": "gen-2", "actualCostUsd": 0.012 },
                ]),
            ),
        )
        .unwrap();

        assert!((summary.cost_usd - 0.049).abs() < 1e-9);
        assert_eq!(summary.uncosted_count, 0);
        // Every generation, so the card may drop its tilde.
        assert_eq!(summary.reconciled_count, 2);
    }

    #[test]
    fn a_part_reconciled_project_is_still_only_part_reconciled() {
        let root = TempDir::new().unwrap();
        let summary = save(
            root.path(),
            &manifest(
                "atlas",
                json!([
                    { "id": "gen-1", "costUsd": 0.04, "actualCostUsd": 0.037 },
                    // Older than fal's 90-day window, or simply not read yet.
                    { "id": "gen-2", "costUsd": 0.02 },
                    { "id": "gen-3" },
                ]),
            ),
        )
        .unwrap();

        assert!((summary.cost_usd - 0.057).abs() < 1e-9);
        assert_eq!(summary.uncosted_count, 1);
        assert_eq!(summary.reconciled_count, 1);
        // Which is what the card reads as approximate: not every generation is
        // fal's own figure.
        assert_ne!(summary.reconciled_count, summary.generation_count);
    }

    #[test]
    fn a_hand_edited_cost_that_is_not_a_number_does_not_take_the_total_with_it() {
        let root = TempDir::new().unwrap();
        let summary = save(
            root.path(),
            &manifest(
                "atlas",
                json!([
                    { "id": "gen-1", "costUsd": 0.04 },
                    { "id": "gen-2", "costUsd": "free" },
                ]),
            ),
        )
        .unwrap();

        assert!((summary.cost_usd - 0.04).abs() < 1e-9);
        assert_eq!(summary.uncosted_count, 1);
    }

    #[test]
    fn cleanup_does_not_reclaim_the_pictures_the_overview_draws() {
        // ADR 0004 — thumbnails are derived, so nothing in the manifest names
        // them. A cleanup that only asked the manifest would delete every card
        // picture in the library and then draw them all again.
        let root = TempDir::new().unwrap();
        let document = manifest(
            "atlas",
            json!([generation("gen-1", "gen-1.png", "approved", 10)]),
        );
        save(root.path(), &document).unwrap();
        write_still(root.path(), "atlas", "gen-1.png", 600, 400);
        let summary = save(root.path(), &document).unwrap();
        let thumbnail = summary.thumbnail.expect("the card has a picture");
        write_asset(root.path(), "atlas", "orphan.jpeg", 40);

        let usage = usage(root.path(), "atlas").unwrap();
        let outcome = cleanup_unused(root.path(), "atlas").unwrap();

        assert_eq!(usage.unused_count, 1, "only the orphan is unreferenced");
        assert_eq!(outcome.removed_count, 1);
        assert!(root.path().join("atlas/assets").join(&thumbnail).exists());
    }

    #[test]
    fn a_thumbnail_whose_original_is_gone_is_reclaimable() {
        // The other half of the rule: a thumbnail is spoken for by *its*
        // generation, not by thumbnails being sacred.
        let root = TempDir::new().unwrap();
        save(root.path(), &manifest("atlas", json!([]))).unwrap();
        write_asset(root.path(), "atlas", "gen-9.thumb.jpg", 40);

        assert_eq!(
            cleanup_unused(root.path(), "atlas").unwrap().removed_count,
            1
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
    fn a_clip_is_found_by_the_same_lookup_that_finds_a_still() {
        // #29 — the animate stage files an `.mp4` under the generation id, and
        // matching on the stem meant the whole video path needed nothing here.
        let root = TempDir::new().unwrap();
        write_asset(root.path(), "atlas", "gen-ani-1.mp4", 3);

        let path = asset_path(root.path(), "atlas", "gen-ani-1").unwrap();

        assert_eq!(path.unwrap().file_name().unwrap(), "gen-ani-1.mp4");
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
