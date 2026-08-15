//! The SQLite index (PRD §3.2) — a cache of the project list, and nothing the
//! app cannot rebuild by looking at the disk.
//!
//! The rule this module exists to enforce: **deleting the database is a
//! non-event.** Not "recoverable", not "re-derivable with a migration" — a
//! non-event. `reconcile` is called on every listing, so the index catches up
//! with the disk before anyone reads it, and a missing database file is just
//! an index that happens to be empty.
//!
//! The reconciliation is against the folders, not against a change feed. That
//! makes it O(projects) per listing rather than O(1), which for a design tool
//! holding tens of projects is a directory read — and buys a guarantee no
//! bookkeeping scheme could match, since the bookkeeping is exactly what a
//! corrupted database has lost.

use rusqlite::{params, Connection};
use std::path::Path;

use super::store::{self, ProjectSummary};

/// Bumped when the columns change. The whole table is a cache, so an
/// unrecognised schema is dropped rather than migrated — the manifests it was
/// summarising have not moved.
const SCHEMA_VERSION: i64 = 2;

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the database folder: {e}"))?;
    }

    let connection =
        Connection::open(path).map_err(|e| format!("Could not open the project index: {e}"))?;

    prepare(&connection)?;
    Ok(connection)
}

/// Creates the table, discarding one written by a different schema.
fn prepare(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Could not read the index version: {e}"))?;

    if version != SCHEMA_VERSION {
        connection
            .execute("DROP TABLE IF EXISTS projects", [])
            .map_err(|e| format!("Could not clear the stale index: {e}"))?;
    }

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS projects (
                id                 TEXT PRIMARY KEY,
                name               TEXT NOT NULL,
                aspect             TEXT NOT NULL,
                created_at         INTEGER NOT NULL,
                updated_at         INTEGER NOT NULL,
                generation_count   INTEGER NOT NULL,
                directory          TEXT NOT NULL,
                latest_activity_at INTEGER NOT NULL,
                thumbnail          TEXT,
                thumbnail_asset    TEXT,
                thumbnail_is_video INTEGER NOT NULL,
                cost_usd           REAL NOT NULL,
                uncosted_count     INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Could not create the project index: {e}"))?;

    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| format!("Could not stamp the index version: {e}"))?;

    Ok(())
}

pub fn upsert(connection: &Connection, summary: &ProjectSummary) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO projects (
                id, name, aspect, created_at, updated_at, generation_count, directory,
                latest_activity_at, thumbnail, thumbnail_asset, thumbnail_is_video,
                cost_usd, uncosted_count
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                aspect = excluded.aspect,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                generation_count = excluded.generation_count,
                directory = excluded.directory,
                latest_activity_at = excluded.latest_activity_at,
                thumbnail = excluded.thumbnail,
                thumbnail_asset = excluded.thumbnail_asset,
                thumbnail_is_video = excluded.thumbnail_is_video,
                cost_usd = excluded.cost_usd,
                uncosted_count = excluded.uncosted_count",
            params![
                summary.id,
                summary.name,
                summary.aspect,
                summary.created_at as i64,
                summary.updated_at as i64,
                summary.generation_count,
                summary.directory,
                summary.latest_activity_at as i64,
                summary.thumbnail,
                summary.thumbnail_asset,
                summary.thumbnail_is_video,
                summary.cost_usd,
                summary.uncosted_count,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("Could not index the project: {e}"))
}

pub fn remove(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| format!("Could not un-index the project: {e}"))
}

/// The project list, most recently *worked in* first.
///
/// Ordered by the newest generation rather than by the manifest's timestamp
/// (ADR 0004): the overview is a grid of work, and a rename is not work.
pub fn list(connection: &Connection) -> Result<Vec<ProjectSummary>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, aspect, created_at, updated_at, generation_count, directory,
                    latest_activity_at, thumbnail, thumbnail_asset, thumbnail_is_video,
                    cost_usd, uncosted_count
             FROM projects ORDER BY latest_activity_at DESC, id ASC",
        )
        .map_err(|e| format!("Could not read the project index: {e}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                aspect: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as f64,
                updated_at: row.get::<_, i64>(4)? as f64,
                generation_count: row.get(5)?,
                directory: row.get(6)?,
                latest_activity_at: row.get::<_, i64>(7)? as f64,
                thumbnail: row.get(8)?,
                thumbnail_asset: row.get(9)?,
                thumbnail_is_video: row.get(10)?,
                cost_usd: row.get(11)?,
                uncosted_count: row.get(12)?,
            })
        })
        .map_err(|e| format!("Could not read the project index: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not read a project row: {e}"))
}

/// Brings the index in line with what is actually on disk.
///
/// Every id on disk is re-read and re-indexed, and every row without a folder
/// is dropped. Re-reading unconditionally rather than trusting the row is the
/// point: the manifest may have been edited by hand or restored from a backup,
/// and neither of those tells the database anything.
///
/// A project whose manifest cannot be read is skipped and logged. It stays on
/// disk — the recipe is the expensive artefact and an unreadable file is a
/// thing to fix, not to garbage-collect.
pub fn reconcile(connection: &Connection, root: &Path) -> Result<(), String> {
    let on_disk = store::scan_ids(root);

    for id in &on_disk {
        match store::load(root, id) {
            Ok(record) => {
                let directory = Path::new(&record.directory);
                match store::summarize(&record.manifest, directory) {
                    Ok(summary) => upsert(connection, &summary)?,
                    Err(e) => log::warn!("Project {id} has an unusable manifest: {e}"),
                }
            }
            Err(e) => log::warn!("Could not read project {id}: {e}"),
        }
    }

    for indexed in list(connection)? {
        if !on_disk.contains(&indexed.id) {
            log::info!("Project {} is indexed but not on disk", indexed.id);
            remove(connection, &indexed.id)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn manifest(id: &str, name: &str, updated_at: i64) -> serde_json::Value {
        json!({
            "version": 1,
            "id": id,
            "name": name,
            "aspect": "16:9",
            "createdAt": 1_700_000_000_000_i64,
            "updatedAt": updated_at,
            "drafts": {},
            "selection": {},
            "generations": [],
        })
    }

    /// The same manifest, with one generation dated so the overview can order
    /// on it.
    fn worked_on(id: &str, name: &str, generation_at: i64) -> serde_json::Value {
        let mut document = manifest(id, name, 1_700_000_000_000);
        document["generations"] = json!([{
            "id": format!("{id}-gen-1"),
            "verdict": "unrated",
            "createdAt": generation_at,
        }]);
        document
    }

    /// A library on disk, and an index next to it.
    fn library(ids: &[(&str, &str, i64)]) -> (TempDir, Connection) {
        let root = TempDir::new().unwrap();
        for (id, name, updated) in ids {
            store::save(root.path(), &manifest(id, name, *updated)).unwrap();
        }
        let connection = open(&root.path().join("index.sqlite")).unwrap();
        (root, connection)
    }

    #[test]
    fn an_index_built_from_disk_lists_every_project() {
        let (root, connection) = library(&[("atlas", "Atlas", 2), ("ledger", "Ledger", 1)]);

        reconcile(&connection, root.path()).unwrap();

        let listed: Vec<String> = list(&connection)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        // Most recently touched first — the sidebar's order.
        assert_eq!(listed, vec!["atlas", "ledger"]);
    }

    #[test]
    fn deleting_the_database_file_costs_nothing_but_a_rescan() {
        // The acceptance criterion of #23, as an assertion: this is the whole
        // reason disk is authoritative (PRD §3.2).
        let (root, connection) = library(&[("atlas", "Atlas", 2), ("ledger", "Ledger", 1)]);
        let db = root.path().join("index.sqlite");
        reconcile(&connection, root.path()).unwrap();
        drop(connection);

        std::fs::remove_file(&db).unwrap();

        let rebuilt = open(&db).unwrap();
        reconcile(&rebuilt, root.path()).unwrap();

        let listed = list(&rebuilt).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "Atlas");
    }

    #[test]
    fn an_index_written_by_a_different_schema_is_discarded_not_trusted() {
        let root = TempDir::new().unwrap();
        let db = root.path().join("index.sqlite");

        let stale = Connection::open(&db).unwrap();
        stale
            .execute("CREATE TABLE projects (id TEXT, something_else TEXT)", [])
            .unwrap();
        stale
            .execute("INSERT INTO projects VALUES ('ghost', 'x')", [])
            .unwrap();
        drop(stale);

        let connection = open(&db).unwrap();

        // The old table is gone rather than queried into an error, and the
        // manifests it was summarising are untouched.
        assert!(list(&connection).unwrap().is_empty());
    }

    #[test]
    fn a_project_deleted_from_disk_leaves_the_index() {
        let (root, connection) = library(&[("atlas", "Atlas", 2), ("ledger", "Ledger", 1)]);
        reconcile(&connection, root.path()).unwrap();

        store::delete(root.path(), "ledger").unwrap();
        reconcile(&connection, root.path()).unwrap();

        let listed: Vec<String> = list(&connection)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed, vec!["atlas"]);
    }

    #[test]
    fn the_overview_is_ordered_by_work_rather_than_by_the_manifests_timestamp() {
        // #55 — a rename writes the manifest, and sorting on that would put a
        // rename at the front of a grid whose whole subject is generations.
        let root = TempDir::new().unwrap();
        store::save(root.path(), &worked_on("atlas", "Atlas", 1_700_000_000_100)).unwrap();
        store::save(
            root.path(),
            &worked_on("ledger", "Ledger", 1_700_000_000_900),
        )
        .unwrap();
        let connection = open(&root.path().join("index.sqlite")).unwrap();
        reconcile(&connection, root.path()).unwrap();

        // Rename the older one, which writes it with the newest `updatedAt` in
        // the library.
        let mut renamed = worked_on("atlas", "Atlas, renamed", 1_700_000_000_100);
        renamed["updatedAt"] = json!(1_800_000_000_000_i64);
        store::save(root.path(), &renamed).unwrap();
        reconcile(&connection, root.path()).unwrap();

        let listed: Vec<String> = list(&connection)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed, vec!["ledger", "atlas"]);
    }

    #[test]
    fn a_manifest_edited_behind_our_back_is_re_read_rather_than_believed() {
        let (root, connection) = library(&[("atlas", "Atlas", 2)]);
        reconcile(&connection, root.path()).unwrap();

        std::fs::write(
            root.path().join("atlas/project.json"),
            serde_json::to_string(&manifest("atlas", "Atlas, renamed by hand", 9)).unwrap(),
        )
        .unwrap();
        reconcile(&connection, root.path()).unwrap();

        assert_eq!(list(&connection).unwrap()[0].name, "Atlas, renamed by hand");
    }

    #[test]
    fn one_unreadable_manifest_does_not_hide_the_rest_of_the_library() {
        let (root, connection) = library(&[("atlas", "Atlas", 2), ("broken", "Broken", 1)]);
        std::fs::write(root.path().join("broken/project.json"), "{ not json").unwrap();

        reconcile(&connection, root.path()).unwrap();

        let listed: Vec<String> = list(&connection)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed, vec!["atlas"]);
        // And the file it could not read is still there to be fixed.
        assert!(root.path().join("broken/project.json").exists());
    }
}
