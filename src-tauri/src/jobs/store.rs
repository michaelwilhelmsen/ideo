//! What has been submitted and not yet collected (PRD §3.3).
//!
//! A row is written **before the first poll**, because the charge lands at
//! submit: a job that exists only in a running process is money staked on the
//! app not being quit. Relaunching reads this table and picks the same loop
//! back up.
//!
//! Its own SQLite file, next to the project index rather than inside it. The
//! index is a cache that gets dropped whenever its schema moves (`projects::
//! index`), and dropping live jobs to rebuild a project list would throw away
//! the one thing here that cannot be rebuilt — the disk has no idea what is in
//! flight at fal.
//!
//! **Rust owns the row, not the recipe.** The frozen recipe crosses as opaque
//! JSON and comes back byte-for-byte, for the same reason the manifest does
//! (`projects::store`): the recipe model lives in TypeScript and widens with
//! every slice.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::Path;

/// Bumped when the columns change — which should be close to never.
///
/// Unlike the project index this table is not a cache: nothing can rebuild it,
/// so a version bump throws away jobs the user has already paid for. **Add
/// columns with `ALTER TABLE` and leave this alone.** The drop below is the
/// last resort for a file this build genuinely cannot query, and it says so
/// loudly in the log when it happens.
const SCHEMA_VERSION: i64 = 1;

/// Where a job has got to, as far as this app is concerned.
///
/// A job that failed or was cancelled is removed rather than tombstoned:
/// nothing downstream can do anything with it, and the event that reports it is
/// what the UI reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    /// Submitted, charged, and being watched right now.
    Running,
    /// On the books, but nobody is watching it this session — we waited longer
    /// than one run of the app is willing to, or could not file the result.
    ///
    /// Distinct from `Running` so the UI stops claiming to be waiting for
    /// something nothing is waiting for. The next launch resumes it, which is
    /// the whole reason it is not simply deleted.
    Stalled,
    /// Finished, with the file on disk, waiting for the manifest to record it.
    Completed,
}

impl JobStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stalled => "stalled",
            Self::Completed => "completed",
        }
    }

    fn parse(raw: &str) -> Self {
        match raw {
            "completed" => Self::Completed,
            "stalled" => Self::Stalled,
            _ => Self::Running,
        }
    }
}

/// A job as the frontend sees it: enough to show it, enough to record it in
/// the manifest once it finishes. The queue URLs stay in this module — they
/// are how *we* talk to fal, not something the webview has any use for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub request_id: String,
    pub project_id: String,
    /// Minted before submit, because the saved file is named after it.
    pub generation_id: String,
    pub stage: String,
    /// The recipe frozen at submit — opaque here, validated in TypeScript.
    ///
    /// Copied rather than re-read from the draft, because by the time a
    /// resumed job lands the draft may say something else entirely, and a
    /// generation has to carry the recipe that actually produced it (PRD §1).
    pub recipe: Value,
    pub status: JobStatus,
    pub model_id: String,
    /// The seed fal used, once it has told us. `f64` because that is what a JS
    /// number is — see `ProjectSummary`.
    pub seed: Option<f64>,
    /// The file, named relative to the project's assets folder.
    pub asset: Option<String>,
    pub submitted_at: f64,
}

/// A job on its way to the table.
pub struct NewJob<'a> {
    pub request_id: &'a str,
    pub project_id: &'a str,
    pub generation_id: &'a str,
    pub stage: &'a str,
    pub recipe: &'a Value,
    pub model_id: &'a str,
    pub status_url: &'a str,
    pub response_url: &'a str,
    pub cancel_url: Option<&'a str>,
    pub submitted_at: f64,
}

/// What the runner needs to keep watching a job — the half of a row the
/// frontend never sees.
#[derive(Debug, Clone, PartialEq)]
pub struct JobTarget {
    pub request_id: String,
    pub project_id: String,
    pub generation_id: String,
    /// Which stage submitted it. Carried here as well as on `Job` because the
    /// watcher decides how long to wait from it (#29): a 30-second clip takes
    /// far longer to render than any still, and one ceiling for both would
    /// either abandon every video or leave a stuck image job holding a
    /// concurrency slot for half an hour.
    pub stage: String,
    pub status_url: String,
    pub response_url: String,
    pub cancel_url: Option<String>,
}

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the jobs folder: {e}"))?;
    }

    let connection =
        Connection::open(path).map_err(|e| format!("Could not open the job store: {e}"))?;

    prepare(&connection)?;
    Ok(connection)
}

fn prepare(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Could not read the job store version: {e}"))?;

    if version != SCHEMA_VERSION {
        log::warn!(
            "Job store is version {version}, not {SCHEMA_VERSION} — discarding it. \
             Anything that was in flight is lost to us, though fal may still run it."
        );
        connection
            .execute("DROP TABLE IF EXISTS jobs", [])
            .map_err(|e| format!("Could not clear the stale job store: {e}"))?;
    }

    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS jobs (
                request_id    TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL,
                generation_id TEXT NOT NULL,
                stage         TEXT NOT NULL,
                recipe        TEXT NOT NULL,
                model_id      TEXT NOT NULL,
                status        TEXT NOT NULL,
                status_url    TEXT NOT NULL,
                response_url  TEXT NOT NULL,
                cancel_url    TEXT,
                seed          REAL,
                asset         TEXT,
                submitted_at  INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Could not create the job store: {e}"))?;

    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| format!("Could not stamp the job store version: {e}"))?;

    Ok(())
}

/// Writes a submitted job down. Called before the first poll — that ordering
/// is the whole point of the table.
pub fn record(connection: &Connection, job: &NewJob) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO jobs (
                request_id, project_id, generation_id, stage, recipe, model_id,
                status, status_url, response_url, cancel_url, seed, asset, submitted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)
             ON CONFLICT(request_id) DO NOTHING",
            params![
                job.request_id,
                job.project_id,
                job.generation_id,
                job.stage,
                job.recipe.to_string(),
                job.model_id,
                JobStatus::Running.as_str(),
                job.status_url,
                job.response_url,
                job.cancel_url,
                job.submitted_at as i64,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("Could not record the job: {e}"))
}

/// Marks a job finished, with the file it produced.
pub fn finish(
    connection: &Connection,
    request_id: &str,
    asset: &str,
    seed: Option<f64>,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE jobs SET status = ?2, asset = ?3, seed = ?4 WHERE request_id = ?1",
            // The column is REAL and the seed stays one, exact to 2^53. Writing
            // it as an integer would leave the column's own affinity to convert
            // it, and the read back would then depend on which build wrote it.
            params![request_id, JobStatus::Completed.as_str(), asset, seed],
        )
        .map(|_| ())
        .map_err(|e| format!("Could not record the finished job: {e}"))
}

/// Takes a job off the books — claimed by the manifest, cancelled, or failed.
pub fn forget(connection: &Connection, request_id: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM jobs WHERE request_id = ?1",
            params![request_id],
        )
        .map(|_| ())
        .map_err(|e| format!("Could not clear the job: {e}"))
}

/// A project's jobs in one state, oldest first — the order they were submitted
/// in, which is the order their candidates should be numbered in.
pub fn for_project(
    connection: &Connection,
    project_id: &str,
    status: JobStatus,
) -> Result<Vec<Job>, String> {
    let mut statement = connection
        .prepare(
            "SELECT request_id, project_id, generation_id, stage, recipe, model_id,
                    status, seed, asset, submitted_at
             FROM jobs WHERE project_id = ?1 AND status = ?2
             ORDER BY submitted_at ASC, request_id ASC",
        )
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    let rows = statement
        .query_map(params![project_id, status.as_str()], read_job)
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not read a job row: {e}"))
}

/// Every job in one state, whatever project it belongs to (ADR 0002).
///
/// The overview watches the whole library at once: a card that only knew what
/// was running in the project you happen to have open would be a status readout
/// for one project and a lie about the rest. Same order as [`for_project`], so
/// a batch numbers its candidates identically whichever query found it.
pub fn with_status(connection: &Connection, status: JobStatus) -> Result<Vec<Job>, String> {
    let mut statement = connection
        .prepare(
            "SELECT request_id, project_id, generation_id, stage, recipe, model_id,
                    status, seed, asset, submitted_at
             FROM jobs WHERE status = ?1
             ORDER BY submitted_at ASC, request_id ASC",
        )
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    let rows = statement
        .query_map(params![status.as_str()], read_job)
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not read a job row: {e}"))
}

/// Every job still owed a result, whatever project it belongs to — what a
/// relaunch picks up.
///
/// Stalled jobs are included: being stalled means nobody watched it *last*
/// time, which is precisely the reason to watch it now.
pub fn unfinished(connection: &Connection) -> Result<Vec<JobTarget>, String> {
    let mut statement = connection
        .prepare(
            "SELECT request_id, project_id, generation_id, stage, status_url, response_url, cancel_url
             FROM jobs WHERE status IN (?1, ?2) ORDER BY submitted_at ASC",
        )
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    let rows = statement
        .query_map(
            params![JobStatus::Running.as_str(), JobStatus::Stalled.as_str()],
            read_target,
        )
        .map_err(|e| format!("Could not read the job store: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not read a job row: {e}"))
}

/// Moves a job between the watched and unwatched states.
///
/// Both directions are used: a watcher marks its job `Running` when it picks it
/// up, and `Stalled` when it lets go. Only these two — finishing is `finish`,
/// which has a result to record.
pub fn set_watching(
    connection: &Connection,
    request_id: &str,
    watching: bool,
) -> Result<(), String> {
    let status = if watching {
        JobStatus::Running
    } else {
        JobStatus::Stalled
    };

    connection
        .execute(
            "UPDATE jobs SET status = ?2 WHERE request_id = ?1 AND status IN (?3, ?4)",
            params![
                request_id,
                status.as_str(),
                JobStatus::Running.as_str(),
                JobStatus::Stalled.as_str()
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("Could not update the job's watch state: {e}"))
}

/// One job's queue URLs, or `None` if it is no longer on the books.
///
/// The watcher asks this every poll, so "cancelled" needs no channel: a row
/// that has gone is a job nobody is waiting for any more.
pub fn target(connection: &Connection, request_id: &str) -> Result<Option<JobTarget>, String> {
    connection
        .query_row(
            "SELECT request_id, project_id, generation_id, stage, status_url, response_url, cancel_url
             FROM jobs WHERE request_id = ?1",
            params![request_id],
            read_target,
        )
        .optional()
        .map_err(|e| format!("Could not read the job: {e}"))
}

fn read_job(row: &Row) -> rusqlite::Result<Job> {
    let recipe: String = row.get(4)?;

    Ok(Job {
        request_id: row.get(0)?,
        project_id: row.get(1)?,
        generation_id: row.get(2)?,
        stage: row.get(3)?,
        // A recipe we cannot parse is not a reason to hide a paid result: the
        // frontend drops an unreadable one the same way it drops an unreadable
        // candidate in a manifest.
        recipe: serde_json::from_str(&recipe).unwrap_or(Value::Null),
        model_id: row.get(5)?,
        status: JobStatus::parse(&row.get::<_, String>(6)?),
        seed: row.get(7)?,
        asset: row.get(8)?,
        submitted_at: row.get::<_, i64>(9)? as f64,
    })
}

fn read_target(row: &Row) -> rusqlite::Result<JobTarget> {
    Ok(JobTarget {
        request_id: row.get(0)?,
        project_id: row.get(1)?,
        generation_id: row.get(2)?,
        stage: row.get(3)?,
        status_url: row.get(4)?,
        response_url: row.get(5)?,
        cancel_url: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        prepare(&connection).unwrap();
        connection
    }

    fn recipe() -> Value {
        json!({ "modelId": "fal-ai/flux-pro/v1.1", "prompt": "an atlas", "seed": { "mode": "roll" } })
    }

    fn submit(connection: &Connection, request_id: &str, project_id: &str, at: f64) {
        record(
            connection,
            &NewJob {
                request_id,
                project_id,
                generation_id: &format!("gen-{request_id}"),
                stage: "source",
                recipe: &recipe(),
                model_id: "fal-ai/flux-pro/v1.1",
                status_url: &format!("https://queue.fal.run/x/requests/{request_id}/status"),
                response_url: &format!("https://queue.fal.run/x/requests/{request_id}"),
                cancel_url: Some(&format!(
                    "https://queue.fal.run/x/requests/{request_id}/cancel"
                )),
                submitted_at: at,
            },
        )
        .unwrap();
    }

    #[test]
    fn a_submitted_job_is_on_the_books_before_anything_polls_it() {
        // #24's first acceptance criterion, as an assertion.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1_700_000_000_000.0);

        let running = for_project(&connection, "atlas", JobStatus::Running).unwrap();

        assert_eq!(running.len(), 1);
        assert_eq!(running[0].generation_id, "gen-req-1");
        assert_eq!(running[0].asset, None);
    }

    #[test]
    fn the_frozen_recipe_comes_back_exactly_as_it_went_in() {
        // The draft will have moved on by the time a resumed job lands, so the
        // recipe travels with the job rather than being re-read (PRD §1).
        let connection = store();
        let mut original = recipe();
        original["params"] = json!({ "guidance_scale": 3.5 });

        record(
            &connection,
            &NewJob {
                request_id: "req-1",
                project_id: "atlas",
                generation_id: "gen-1",
                stage: "source",
                recipe: &original,
                model_id: "fal-ai/flux-pro/v1.1",
                status_url: "https://queue.fal.run/x/requests/req-1/status",
                response_url: "https://queue.fal.run/x/requests/req-1",
                cancel_url: None,
                submitted_at: 1.0,
            },
        )
        .unwrap();

        let stored = for_project(&connection, "atlas", JobStatus::Running).unwrap();
        assert_eq!(stored[0].recipe, original);
    }

    #[test]
    fn a_relaunch_finds_every_unfinished_job_and_its_queue_urls() {
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        submit(&connection, "req-2", "ledger", 2.0);
        finish(&connection, "req-1", "gen-req-1.jpeg", Some(42.0)).unwrap();

        let unfinished = unfinished(&connection).unwrap();

        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].request_id, "req-2");
        assert!(unfinished[0].status_url.ends_with("/status"));
    }

    #[test]
    fn a_finished_job_waits_to_be_collected_rather_than_vanishing() {
        // The result is only safe once the manifest has it, so finishing moves
        // the row rather than removing it.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);

        finish(&connection, "req-1", "gen-req-1.jpeg", Some(42.0)).unwrap();

        let collected = for_project(&connection, "atlas", JobStatus::Completed).unwrap();
        assert_eq!(collected[0].asset.as_deref(), Some("gen-req-1.jpeg"));
        assert_eq!(collected[0].seed, Some(42.0));
        assert!(for_project(&connection, "atlas", JobStatus::Running)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_job_with_no_seed_records_that_rather_than_inventing_one() {
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);

        finish(&connection, "req-1", "gen-req-1.jpeg", None).unwrap();

        assert_eq!(
            for_project(&connection, "atlas", JobStatus::Completed).unwrap()[0].seed,
            None
        );
    }

    #[test]
    fn a_job_nobody_is_watching_stops_counting_as_running() {
        // Otherwise the stage it belongs to spends the rest of the session
        // claiming to wait for something no task is waiting for.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);

        set_watching(&connection, "req-1", false).unwrap();

        assert!(for_project(&connection, "atlas", JobStatus::Running)
            .unwrap()
            .is_empty());
        assert_eq!(
            for_project(&connection, "atlas", JobStatus::Stalled)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_stalled_job_is_exactly_what_the_next_launch_picks_up() {
        // Stalled means nobody watched it last time, which is the reason to
        // watch it now — not a reason to write off what it cost.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        set_watching(&connection, "req-1", false).unwrap();

        let unfinished = unfinished(&connection).unwrap();

        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].request_id, "req-1");
    }

    #[test]
    fn picking_a_stalled_job_back_up_makes_it_running_again() {
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        set_watching(&connection, "req-1", false).unwrap();

        set_watching(&connection, "req-1", true).unwrap();

        assert_eq!(
            for_project(&connection, "atlas", JobStatus::Running)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_collected_job_is_not_dragged_back_into_being_watched() {
        // The watcher marks its job running when it starts, and a completed
        // job that has not been claimed yet must not be reopened by that.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        finish(&connection, "req-1", "gen-req-1.jpeg", Some(42.0)).unwrap();

        set_watching(&connection, "req-1", true).unwrap();

        assert_eq!(
            for_project(&connection, "atlas", JobStatus::Completed)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_forgotten_job_leaves_the_watcher_nothing_to_find() {
        // How cancellation reaches a running poll loop: the row goes away.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);

        forget(&connection, "req-1").unwrap();

        assert_eq!(target(&connection, "req-1").unwrap(), None);
        assert!(unfinished(&connection).unwrap().is_empty());
    }

    #[test]
    fn resubmitting_the_same_request_id_does_not_duplicate_it() {
        // Two watchers on one job would collect it twice, and the second would
        // write a candidate the manifest already has.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        submit(&connection, "req-1", "atlas", 5.0);

        assert_eq!(
            for_project(&connection, "atlas", JobStatus::Running)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn only_the_asked_for_project_is_returned() {
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        submit(&connection, "req-2", "ledger", 2.0);

        let atlas = for_project(&connection, "atlas", JobStatus::Running).unwrap();

        assert_eq!(atlas.len(), 1);
        assert_eq!(atlas[0].project_id, "atlas");
    }

    #[test]
    fn the_whole_library_can_be_asked_what_is_running() {
        // ADR 0002: the overview's cards cover projects that are not open, so
        // "what is in flight" stopped being a question about one project.
        let connection = store();
        submit(&connection, "req-1", "atlas", 1.0);
        submit(&connection, "req-2", "ledger", 2.0);
        submit(&connection, "req-3", "atlas", 3.0);
        finish(&connection, "req-3", "gen-req-3.jpeg", None).unwrap();

        let running = with_status(&connection, JobStatus::Running).unwrap();

        let ids: Vec<&str> = running.iter().map(|job| job.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-1", "req-2"]);
        assert_eq!(
            with_status(&connection, JobStatus::Completed)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn jobs_come_back_in_the_order_they_were_submitted() {
        // Candidates are numbered in arrival order, and a batch that finishes
        // out of order would otherwise renumber itself on every relaunch.
        let connection = store();
        submit(&connection, "req-b", "atlas", 2.0);
        submit(&connection, "req-a", "atlas", 1.0);

        let ids: Vec<String> = for_project(&connection, "atlas", JobStatus::Running)
            .unwrap()
            .into_iter()
            .map(|job| job.request_id)
            .collect();

        assert_eq!(ids, vec!["req-a", "req-b"]);
    }

    #[test]
    fn a_store_written_by_a_different_schema_is_discarded_rather_than_queried() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute(
                "CREATE TABLE jobs (request_id TEXT, something_else TEXT)",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO jobs VALUES ('ghost', 'x')", [])
            .unwrap();

        prepare(&connection).unwrap();

        assert!(unfinished(&connection).unwrap().is_empty());
    }
}
