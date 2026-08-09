//! Finding the system ffmpeg, and running it.
//!
//! v1 uses whatever ffmpeg the machine already has (PRD §8). Bundling a static
//! binary means vendoring, GPL licensing, signing and notarisation — days of
//! work for an internal tool whose users are all developers on Macs. This is
//! the only file that knows where the binary came from, so bundling later
//! replaces `discover` and touches nothing else.
//!
//! The detection is cached in a process-global rather than re-probed per
//! export, because probing spawns a process and the answer changes about once
//! per `brew install`. `refresh` is what the panel's re-check button calls, so
//! installing ffmpeg while the app is open does not need a relaunch.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::plan::Plan;
use super::ExportError;

/// The last answer `discover` gave, or `None` if nobody has asked yet.
///
/// The same shape `commands::quick_pane` uses for the registered shortcut: a
/// `Mutex<Option<_>>` in a `static`, initialised at startup and readable from
/// any command thread without a managed-state round trip.
static DETECTED: Mutex<Option<Ffmpeg>> = Mutex::new(None);

/// An ffmpeg this machine actually has.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Ffmpeg {
    /// Absolute, so a later `Command` never re-resolves through a `PATH` that
    /// may not be the one this was found on.
    pub path: String,
    /// What it called itself — shown in the panel so "which ffmpeg is this"
    /// has an answer without opening a terminal.
    pub version: String,
}

/// What the frontend needs to decide whether export is offerable.
///
/// A struct rather than `Option<Ffmpeg>` because "not installed" is a state the
/// panel renders rather than an absence it ignores — it carries an install
/// prompt and a re-check button (PRD §8).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

impl FfmpegStatus {
    fn from(found: Option<&Ffmpeg>) -> Self {
        match found {
            Some(ffmpeg) => Self {
                available: true,
                path: Some(ffmpeg.path.clone()),
                version: Some(ffmpeg.version.clone()),
            },
            None => Self {
                available: false,
                path: None,
                version: None,
            },
        }
    }
}

/// Probes once and remembers, at startup (PRD §8: "detected at startup").
///
/// Never fatal. An app that refused to launch without ffmpeg would be an app
/// you cannot use to generate anything either, and generation is most of it.
pub fn detect_at_startup() {
    let found = refresh();
    match found.available {
        true => log::info!(
            "ffmpeg {} at {}",
            found.version.unwrap_or_default(),
            found.path.unwrap_or_default()
        ),
        false => log::info!("No ffmpeg found — export will offer the install prompt"),
    }
}

/// The cached answer, probing once if nobody has yet.
pub fn status() -> FfmpegStatus {
    FfmpegStatus::from(found().as_ref())
}

/// Probes again, whatever the cache says — the re-check button.
pub fn refresh() -> FfmpegStatus {
    FfmpegStatus::from(probe_and_cache().as_ref())
}

/// The ffmpeg to use, or the reason there is none.
fn require() -> Result<Ffmpeg, ExportError> {
    found().ok_or(ExportError::FfmpegMissing)
}

/// The ffmpeg this machine has, cached.
///
/// One reader for all three callers above, so a cold cache is filled the same
/// way whoever asked first — an export that probed its way to an ffmpeg used to
/// leave the cache empty, and the panel beside it would go on saying there was
/// none.
fn found() -> Option<Ffmpeg> {
    let cached = DETECTED.lock().ok().and_then(|found| found.clone());
    match cached {
        Some(ffmpeg) => Some(ffmpeg),
        None => probe_and_cache(),
    }
}

fn probe_and_cache() -> Option<Ffmpeg> {
    let found = discover();

    if let Ok(mut cache) = DETECTED.lock() {
        cache.clone_from(&found);
    }

    found
}

/// The first candidate that answers `-version`.
fn discover() -> Option<Ffmpeg> {
    candidates().into_iter().find_map(|candidate| {
        let version = probe(&candidate)?;
        Some(Ffmpeg {
            path: candidate.to_string_lossy().to_string(),
            version,
        })
    })
}

/// Where to look, in order.
///
/// `PATH` first, because a developer who has put a particular ffmpeg on it means
/// that one. The hardcoded list after it is not belt-and-braces: a macOS app
/// launched from Finder inherits `launchd`'s `PATH`, not the shell's, so
/// `/opt/homebrew/bin` is missing from exactly the machines where `brew install
/// ffmpeg` just succeeded — the "I installed it and the app still says no" bug
/// this list exists to prevent.
fn candidates() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .map(|dir| dir.join(BINARY))
                .collect()
        })
        .unwrap_or_default();

    for fallback in FALLBACK_DIRS {
        paths.push(Path::new(fallback).join(BINARY));
    }

    // `PATH` routinely repeats an entry, and a fallback is usually already on
    // it. Deduped in place rather than sorted, because the order *is* the
    // policy: the first ffmpeg found wins, and the user's `PATH` outranks our
    // guesses.
    let mut seen = std::collections::HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));

    paths
}

#[cfg(windows)]
const BINARY: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const BINARY: &str = "ffmpeg";

/// Homebrew on Apple silicon, Homebrew on Intel, MacPorts, and the usual Unix
/// prefixes. v1's users are on Macs (PRD §8); the rest cost one `stat` each.
const FALLBACK_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
];

/// What `ffmpeg -version` says it is, or `None` if this is not an ffmpeg.
fn probe(candidate: &Path) -> Option<String> {
    if !candidate.is_file() {
        return None;
    }

    let output = Command::new(candidate).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }

    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The version out of the banner, and a check that it *is* the banner.
///
/// Something else called `ffmpeg` on the `PATH` that happens to exit zero would
/// otherwise be adopted as the encoder, and the failure would arrive later,
/// mid-export, as an unreadable error.
fn parse_version(banner: &str) -> Option<String> {
    let first = banner.lines().next()?.trim();
    let rest = first.strip_prefix("ffmpeg version ")?;

    let version = rest.split_whitespace().next()?;
    (!version.is_empty()).then(|| version.to_string())
}

/// Runs a plan, writing every file into `destination`.
///
/// The steps carry bare file names and the process runs *in* the destination, so
/// no argument this builds can name a path outside it — and the caller decides
/// where an export lands by handing over a directory rather than by string
/// concatenation.
///
/// Blocking, and called from a blocking context: encoding a hero clip takes
/// seconds, and seconds on an async runtime thread is the whole UI.
pub fn run(plan: &Plan, destination: &Path) -> Result<Vec<String>, ExportError> {
    let ffmpeg = require()?;

    std::fs::create_dir_all(destination).map_err(|e| ExportError::DestinationUnusable {
        message: e.to_string(),
    })?;

    let mut written = Vec::new();

    for step in &plan.steps {
        log::debug!("ffmpeg {}", step.args.join(" "));

        let output = Command::new(&ffmpeg.path)
            .args(&step.args)
            .current_dir(destination)
            .output()
            .map_err(|e| ExportError::EncodeFailed {
                deliverable: step.deliverable.as_str().to_string(),
                detail: e.to_string(),
            })?;

        if !output.status.success() {
            return Err(ExportError::EncodeFailed {
                deliverable: step.deliverable.as_str().to_string(),
                detail: last_words(&String::from_utf8_lossy(&output.stderr)),
            });
        }

        written.push(step.file_name.clone());
    }

    Ok(written)
}

/// The tail of ffmpeg's chatter, which is where it says what went wrong.
///
/// ffmpeg writes its whole banner and every stream's parameters to stderr on a
/// successful run too, so the first line of a failure is almost never about the
/// failure. Trimmed rather than passed whole: this ends up in a log and, in
/// outline, in front of a user.
fn last_words(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(3)
        .collect::<Vec<&str>>()
        .into_iter()
        .rev()
        .collect::<Vec<&str>>()
        .join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_out_of_the_banner() {
        let banner = "ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers\n\
                      built with Apple clang version 17.0.0\n";

        assert_eq!(parse_version(banner).as_deref(), Some("8.0.1"));
    }

    #[test]
    fn reads_a_distribution_version_string_whole() {
        let banner = "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023\n";

        assert_eq!(parse_version(banner).as_deref(), Some("6.1.1-3ubuntu5"));
    }

    /// Something else on the `PATH` called `ffmpeg` that exits zero is not an
    /// ffmpeg. Adopting it would move the failure to mid-export, where it
    /// arrives as an unreadable encoder error instead of "not installed".
    #[test]
    fn refuses_a_binary_that_is_not_ffmpeg() {
        assert_eq!(parse_version("GNU coreutils 9.4\n"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("ffmpeg version \n"), None);
    }

    #[test]
    fn looks_where_homebrew_puts_it_even_when_path_does_not_say_so() {
        let candidates = candidates();

        // The bug this prevents: an app launched from Finder inherits
        // `launchd`'s PATH, so a freshly brewed ffmpeg is invisible without it.
        assert!(candidates
            .iter()
            .any(|path| path.starts_with("/opt/homebrew/bin")));
        assert!(candidates
            .iter()
            .any(|path| path.starts_with("/usr/local/bin")));
    }

    #[test]
    fn never_lists_the_same_candidate_twice() {
        let candidates = candidates();
        let mut unique = candidates.clone();
        unique.sort();
        unique.dedup();

        assert_eq!(candidates.len(), unique.len());
    }

    #[test]
    fn a_failure_reports_the_end_of_the_chatter_rather_than_the_banner() {
        // Trimmed down from a real failing run: ffmpeg says all of this before
        // it gets to the part about what went wrong.
        let stderr = "ffmpeg version 8.0.1 Copyright (c) 2000-2025\n\
                      \x20 built with Apple clang version 17.0.0\n\
                      \x20 configuration: --prefix=/opt/homebrew\n\
                      Input #0, mov,mp4,m4a, from 'gen-1.mp4':\n\
                      \x20 Duration: 00:00:05.00, bitrate: 12000 kb/s\n\
                      \x20 Stream #0:0: Video: h264, yuv420p, 3840x1646\n\
                      \n\
                      [AVFilterGraph] No such filter: 'revrese'\n\
                      Error initializing complex filters.\n";

        let said = last_words(stderr);
        assert!(said.contains("No such filter"));
        assert!(said.contains("Error initializing complex filters"));
        assert!(!said.contains("built with Apple clang"));
        assert!(!said.contains("configuration:"));
    }
}
