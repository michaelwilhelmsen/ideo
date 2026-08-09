//! Writing a file without ever leaving half of one behind.
//!
//! Here rather than beside either caller because both the project manifest
//! (PRD §3.2) and the user's own preset library (#28) need it, and a second copy
//! of these twenty lines is a second place to forget the flush. The flush is the
//! part that matters: a rename that beats its own contents to the disk leaves an
//! intact-looking file full of nothing.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Temp file, flushed, then renamed over the target.
///
/// A crash leaves either the previous contents or the new ones — never a
/// mixture, and never a stray temp file that would make the folder look
/// half-written to anyone inspecting it in Finder.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = temp_path(path);

    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    };

    if let Err(e) = write() {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not write {}: {e}", path.display()));
    }

    if let Err(e) = fs::rename(&temp, path) {
        if let Err(remove) = fs::remove_file(&temp) {
            log::warn!("Could not remove the temp file: {remove}");
        }
        return Err(format!("Could not finalise {}: {e}", path.display()));
    }

    Ok(())
}

/// The temp name for a target: its own extension plus `.tmp`, so a directory
/// listing says which file the leftover belongs to.
fn temp_path(path: &Path) -> PathBuf {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) => path.with_extension(format!("{extension}.tmp")),
        None => path.with_extension("tmp"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_written_file_holds_exactly_what_it_was_given() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("thing.json");

        write_atomically(&path, b"{\"a\":1}").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn a_write_leaves_no_temp_file_behind() {
        let dir = TempDir::new().unwrap();
        write_atomically(&dir.path().join("thing.json"), b"{}").unwrap();

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["thing.json"]);
    }

    #[test]
    fn the_temp_name_says_which_file_it_belongs_to() {
        assert_eq!(
            temp_path(Path::new("/tmp/a/project.json")),
            PathBuf::from("/tmp/a/project.json.tmp")
        );
        assert_eq!(
            temp_path(Path::new("/tmp/a/nameless")),
            PathBuf::from("/tmp/a/nameless.tmp")
        );
    }

    #[test]
    fn a_directory_that_does_not_exist_is_a_named_failure_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("missing").join("thing.json");

        assert!(write_atomically(&path, b"{}").is_err());
    }
}
