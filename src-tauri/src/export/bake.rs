//! Baking a treatment into an export (#36).
//!
//! The shader lives in the webview and the encoder lives here, so a bake is a
//! conversation rather than a function:
//!
//! 1. [`begin`] makes a temp folder, works out the **export resolution**, and —
//!    for a clip — has ffmpeg decode every frame into it at that size.
//! 2. The webview renders each frame through the same program that drew the
//!    preview and posts the result back through [`write_frame`].
//! 3. [`finish`] encodes the deliverables from the treated frames and clears
//!    the folder.
//!
//! **Frames cross by disk, not by IPC.** A 2560×1440 frame is ~11 MB raw, which
//! is gigabytes for a five-second clip; the treated ones come back as PNG, which
//! dithered output compresses hard. The source frames are loaded by the webview
//! through Tauri's asset protocol.
//!
//! **Progress and cancel belong to the webview**, and there are no events here
//! for either. The frame count is known before the first frame, and the webview
//! is the thing doing the per-frame work — so a determinate bar and a cancel
//! that actually stops are both just the loop it is already running. What this
//! module owes that loop is [`cancel`], which removes the folder.
//!
//! **Temp survives a crash** because it does not rely on anything running at
//! exit: every bake lives under one directory, and [`sweep`] empties the whole
//! thing at startup. A folder left by a crash is by definition from a previous
//! launch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::plan::{ExportSize, Input, Medium};
use super::ExportError;

/// Where every bake's scratch folder goes, under app data.
const BAKES_DIR: &str = "bakes";

/// What the treated frames are called. Six digits is 27 hours at 24fps.
const TREATED_PATTERN: &str = "treated-%06d.png";

/// The sessions this process has open, so a session id is the only thing the
/// webview ever hands back — never a path.
///
/// A path crossing the boundary would mean the webview choosing which directory
/// gets written to, which is the argument `presets::store::Library` already
/// makes about folder names.
static SESSIONS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// A bake in progress, as the webview sees it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BakeSession {
    pub id: String,
    /// Absolute paths to the frames to treat, in order, ready for the asset
    /// protocol. One entry for a still.
    pub frames: Vec<String>,
    /// The size the shader must render at — the size these will ship at.
    pub width: u32,
    pub height: u32,
    /// Output pixels per look pixel, so the pattern comes out the size it was
    /// dialled in at rather than the size the grid happens to be (#58).
    ///
    /// 1 at [`ExportSize::Web`], 2 at `Double`, and whatever the source's own
    /// width is worth at `Native`. The shader divides its pattern coordinates by
    /// this, which is what makes a bigger export the same look with harder edges
    /// instead of a finer screen nobody asked for.
    pub scale: f64,
    /// The clip's own rate, so the re-encode does not re-time it. `null` for a
    /// still, which has no time axis.
    pub fps: Option<f64>,
}

/// Opens a bake: a folder, a resolution, and the frames to treat.
pub fn begin(
    app_data: &Path,
    ffmpeg: &str,
    id: &str,
    source: &Path,
    medium: Medium,
    size: ExportSize,
) -> Result<BakeSession, ExportError> {
    let directory = root(app_data).join(id);
    std::fs::create_dir_all(&directory).map_err(|e| ExportError::DestinationUnusable {
        message: e.to_string(),
    })?;

    let session = match medium {
        Medium::Still => still_session(id, &directory, source, size)?,
        Medium::Clip => clip_session(id, &directory, ffmpeg, source, size)?,
    };

    remember(id, &directory);
    Ok(session)
}

/// A still needs no decode — it *is* the frame.
///
/// What it does need is the export resolution, because the shader renders at
/// the size the file will ship at and the poster is capped like everything
/// else. Read from the header rather than by decoding: `imagesize` is already a
/// dependency for exactly this.
fn still_session(
    id: &str,
    directory: &Path,
    source: &Path,
    size: ExportSize,
) -> Result<BakeSession, ExportError> {
    let natural = imagesize::size(source).map_err(|e| ExportError::EncodeFailed {
        deliverable: "bake".to_string(),
        detail: e.to_string(),
    })?;

    let (width, height) = shipped_size(natural.width as u32, natural.height as u32, size);
    // Nothing is written here yet; the folder exists so the treated frame has
    // somewhere to land.
    let _ = directory;

    Ok(BakeSession {
        id: id.to_string(),
        frames: vec![source.to_string_lossy().to_string()],
        width,
        height,
        scale: size.pattern_scale(width, height),
        fps: None,
    })
}

/// A clip is decoded to PNGs **at the export resolution**.
///
/// Scaled here rather than after treatment, which is the whole point: a pattern
/// rendered at model resolution and then scaled down is destroyed by the scale,
/// so the cell size dialled in would not be the cell size shipped.
fn clip_session(
    id: &str,
    directory: &Path,
    ffmpeg: &str,
    source: &Path,
    size: ExportSize,
) -> Result<BakeSession, ExportError> {
    let pattern = directory.join("source-%06d.png");

    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            &source.to_string_lossy(),
            "-vf",
            &format!("scale=w='{}':h=-2,setsar=1", size.width_expression()),
            // Every frame the container holds, at its own timing.
            "-vsync",
            "0",
            &pattern.to_string_lossy(),
        ])
        .output()
        .map_err(|e| ExportError::EncodeFailed {
            deliverable: "bake".to_string(),
            detail: e.to_string(),
        })?;

    let chatter = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(ExportError::EncodeFailed {
            deliverable: "bake".to_string(),
            detail: chatter.lines().last().unwrap_or_default().to_string(),
        });
    }

    let frames = decoded_frames(directory, "source-")?;
    if frames.is_empty() {
        return Err(ExportError::EncodeFailed {
            deliverable: "bake".to_string(),
            detail: "no frames were decoded".to_string(),
        });
    }

    let first = imagesize::size(&frames[0]).map_err(|e| ExportError::EncodeFailed {
        deliverable: "bake".to_string(),
        detail: e.to_string(),
    })?;

    Ok(BakeSession {
        id: id.to_string(),
        frames: frames
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        width: first.width as u32,
        height: first.height as u32,
        scale: size.pattern_scale(first.width as u32, first.height as u32),
        // A clip whose rate ffmpeg did not name is re-encoded at 24, which is
        // wrong by less than refusing the export would be.
        fps: Some(parse_fps(&chatter).unwrap_or(24.0)),
    })
}

/// One treated frame, as the webview rendered it.
///
/// Numbered by the caller rather than by arrival, because the loop is
/// concurrent-capable and a sequence numbered by whoever finished first is a
/// clip in the wrong order.
pub fn write_frame(id: &str, index: usize, png: &[u8]) -> Result<(), ExportError> {
    let directory = directory_of(id)?;
    let name = format!("treated-{index:06}.png");

    std::fs::write(directory.join(name), png).map_err(|e| ExportError::DestinationUnusable {
        message: e.to_string(),
    })
}

/// What the encoder should read, now that the frames are treated.
pub fn treated_input(id: &str, fps: Option<f64>) -> Result<Input, ExportError> {
    let directory = directory_of(id)?;
    let pattern = directory
        .join(TREATED_PATTERN)
        .to_string_lossy()
        .to_string();

    Ok(match fps {
        // ffmpeg's sequence reader starts at the first number it finds, and the
        // webview numbers from zero.
        Some(fps) => Input::TreatedFrames { pattern, fps },
        None => Input::TreatedStill(directory.join("treated-000000.png")),
    })
}

/// Closes a bake and removes its folder. Never fails the export over cleanup.
pub fn finish(id: &str) {
    discard(id)
}

/// The user changed their mind. Same cleanup, named for what it is.
pub fn cancel(id: &str) {
    discard(id)
}

fn discard(id: &str) {
    if let Ok(directory) = directory_of(id) {
        if let Err(e) = std::fs::remove_dir_all(&directory) {
            log::warn!("Could not clear the bake folder: {e}");
        }
    }

    if let Ok(mut sessions) = SESSIONS.lock() {
        if let Some(open) = sessions.as_mut() {
            open.remove(id);
        }
    }
}

/// Empties the whole bake area — called once, at startup.
///
/// Anything here is from a previous launch by definition, so there is nothing
/// to be careful about. This is what makes temp cleanup survive a crash without
/// an exit handler that a crash would skip.
pub fn sweep(app_data: &Path) {
    let root = root(app_data);
    if !root.exists() {
        return;
    }

    match std::fs::remove_dir_all(&root) {
        Ok(()) => log::info!("Cleared bake scratch left by a previous run"),
        Err(e) => log::warn!("Could not clear the bake scratch: {e}"),
    }
}

fn root(app_data: &Path) -> PathBuf {
    app_data.join(BAKES_DIR)
}

fn remember(id: &str, directory: &Path) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions
            .get_or_insert_with(HashMap::new)
            .insert(id.to_string(), directory.to_path_buf());
    }
}

fn directory_of(id: &str) -> Result<PathBuf, ExportError> {
    SESSIONS
        .lock()
        .ok()
        .and_then(|sessions| sessions.as_ref().and_then(|open| open.get(id).cloned()))
        .ok_or(ExportError::NoAsset)
}

/// The frames ffmpeg wrote, in name order.
fn decoded_frames(directory: &Path, prefix: &str) -> Result<Vec<PathBuf>, ExportError> {
    let entries = std::fs::read_dir(directory).map_err(|e| ExportError::DestinationUnusable {
        message: e.to_string(),
    })?;

    let mut frames: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".png"))
        })
        .collect();

    // Zero-padded, so lexicographic order is frame order.
    frames.sort();
    Ok(frames)
}

/// The size a deliverable ships at, on the chosen scale and even.
///
/// The same expression the untreated path puts in its filter graph, computed
/// here because the shader has to know it before it draws. The height is forced
/// even for the reason `-2` exists in that filter: 4:2:0 chroma cannot express
/// an odd number of rows.
pub fn shipped_size(width: u32, height: u32, size: ExportSize) -> (u32, u32) {
    let target = size.target_width(width, height).max(2);
    let scaled = if width == 0 {
        height
    } else {
        ((height as f64) * (target as f64) / (width as f64)).round() as u32
    };

    (target & !1, scaled.max(2) & !1)
}

/// The frame rate out of ffmpeg's own stream line.
///
/// ffprobe would be the tidier answer and is a second binary to find — the
/// discovery in `ffmpeg.rs` knows about one. ffmpeg prints the rate on the video
/// stream line of every run, so it is already in the chatter that came back.
fn parse_fps(chatter: &str) -> Option<f64> {
    chatter
        .lines()
        .filter(|line| line.contains("Video:"))
        .find_map(|line| {
            line.split(',').find_map(|part| {
                let part = part.trim();
                let value = part.strip_suffix(" fps")?;
                value.parse::<f64>().ok().filter(|rate| *rate > 0.0)
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_export_size_is_the_one_the_untreated_path_would_produce() {
        // The property that matters most here: turning a treatment on must not
        // silently resize the deliverable.
        assert_eq!(shipped_size(3840, 2160, ExportSize::Web), (1920, 1080));
        assert_eq!(shipped_size(2560, 1440, ExportSize::Web), (1920, 1080));
        // Below the cap is left alone rather than upscaled into a bigger file
        // with no more detail in it.
        assert_eq!(shipped_size(1280, 720, ExportSize::Web), (1280, 720));
    }

    #[test]
    fn a_bigger_size_keeps_the_aspect_it_was_given() {
        // Native is the pixels the model actually returned, uncapped.
        assert_eq!(shipped_size(2560, 1440, ExportSize::Native), (2560, 1440));
        // ...which for anything already under the cap is the same file Web
        // would have produced. A size control that quietly upscaled here would
        // be selling detail that was never generated.
        assert_eq!(shipped_size(1280, 720, ExportSize::Native), (1280, 720));

        // Double is twice the *web* width rather than twice the source's, so
        // the ceiling stays somewhere a landing page can afford.
        assert_eq!(shipped_size(3840, 2160, ExportSize::Double), (3840, 2160));
        assert_eq!(shipped_size(1280, 720, ExportSize::Double), (2560, 1440));
    }

    #[test]
    fn the_height_is_always_even() {
        // An odd height is a hard 4:2:0 failure rather than a slightly wrong
        // picture, which is why the filter graph says `-2` and not `-1`.
        for (w, h) in [(1000u32, 563u32), (1920, 1081), (999, 999)] {
            for size in [ExportSize::Web, ExportSize::Native, ExportSize::Double] {
                let (_, height) = shipped_size(w, h, size);
                assert_eq!(height % 2, 0, "{w}x{h} gave an odd height");
            }
        }
    }

    #[test]
    fn a_degenerate_size_still_produces_something_encodable() {
        assert_eq!(shipped_size(0, 0, ExportSize::Web), (2, 2));
        assert_eq!(shipped_size(1, 1, ExportSize::Web), (2, 2));
        assert_eq!(shipped_size(0, 0, ExportSize::Double), (2, 2));
    }

    #[test]
    fn the_frame_rate_comes_off_the_stream_line() {
        let chatter = "ffmpeg version 8.0.1 Copyright (c) 2000-2025\n\
            Input #0, mov,mp4,m4a, from 'gen-1.mp4':\n\
            \x20 Duration: 00:00:05.00, start: 0.000000, bitrate: 12000 kb/s\n\
            \x20 Stream #0:0(und): Video: h264 (High), yuv420p, 2560x1440, 11997 kb/s, 24 fps, 24 tbr, 12288 tbn\n";

        assert_eq!(parse_fps(chatter), Some(24.0));
    }

    #[test]
    fn a_fractional_rate_survives() {
        let line = " Stream #0:0: Video: h264, yuv420p, 1920x1080, 29.97 fps, 30 tbr\n";
        assert_eq!(parse_fps(line), Some(29.97));
    }

    #[test]
    fn chatter_with_no_rate_in_it_is_none_rather_than_a_guess() {
        // The caller substitutes 24 out loud; parsing must not invent one.
        assert_eq!(parse_fps("ffmpeg version 8.0.1\n"), None);
        assert_eq!(parse_fps(""), None);
        assert_eq!(parse_fps(" Stream #0:0: Video: h264, 0 fps\n"), None);
    }

    #[test]
    fn a_session_the_process_never_opened_has_no_directory() {
        // The webview only ever holds an id, so an id nobody minted must not
        // resolve to somewhere on disk.
        assert!(matches!(
            directory_of("not-a-session"),
            Err(ExportError::NoAsset)
        ));
        assert!(matches!(
            write_frame("not-a-session", 0, b"x"),
            Err(ExportError::NoAsset)
        ));
    }

    #[test]
    fn frames_come_back_in_frame_order_rather_than_directory_order() {
        let root = tempfile::TempDir::new().unwrap();
        for name in ["source-000010.png", "source-000002.png", "notes.txt"] {
            std::fs::write(root.path().join(name), b"x").unwrap();
        }

        let frames = decoded_frames(root.path(), "source-").unwrap();
        let names: Vec<String> = frames
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["source-000002.png", "source-000010.png"]);
    }

    #[test]
    fn a_swept_root_takes_everything_a_crash_left_behind() {
        let app_data = tempfile::TempDir::new().unwrap();
        let stale = root(app_data.path()).join("from-a-previous-run");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("treated-000000.png"), b"x").unwrap();

        sweep(app_data.path());

        assert!(!root(app_data.path()).exists());
        // Sweeping a root that is not there is not a failure.
        sweep(app_data.path());
    }

    #[test]
    fn the_scratch_folder_is_readable_by_the_webview() {
        // The frames this module decodes are loaded back through the asset
        // protocol, which serves nothing outside its configured scope. That
        // scope lives in a JSON file no compiler checks against this constant,
        // and when the two disagree every clip bake dies on the first frame
        // with a message about ffmpeg — so the disagreement is caught here.
        let config = include_str!("../../tauri.conf.json");
        let scope = config
            .lines()
            .find(|line| line.contains("$APPDATA/"))
            .expect("the asset protocol scope");

        assert!(
            scope.contains(&format!("$APPDATA/{BAKES_DIR}/**")),
            "the bake scratch folder is not in the asset protocol scope: {scope}"
        );
    }
}
