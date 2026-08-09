//! Bringing a file the user already has into a project (#27).
//!
//! The premise of the slice is convergence: a picked or dropped image has to
//! end up as *exactly* the same thing a generated one does — a file in the
//! project's `assets` folder, named after the generation that owns it. Every
//! later stage then reads assets one way regardless of where the pixels came
//! from, and nothing downstream has to carry an "is this an upload?" branch.
//!
//! Everything refusable is refused here, before the frontend records anything
//! and long before any paid call. The three checks are size, format and
//! readability, in that order — cheapest first, so a 900 MB video is turned
//! away on its metadata rather than after being read into memory.
//!
//! Format is sniffed from magic bytes rather than trusted from the extension:
//! the extension is a claim the filesystem makes on the user's behalf, and a
//! `.png` holding a TIFF would be filed as something no later stage can open.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::Path;

use crate::projects::store::{asset_file_name, assets_dir};

/// The ceiling on a file we will copy into a project.
///
/// 30 MB is comfortably above any photograph a hero frame would plausibly
/// start from and comfortably below the point where holding the bytes in
/// memory is a question. It is a refusal we can explain, which is the property
/// that matters: "too large" with a number beats a copy that quietly takes a
/// minute.
pub const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;

/// Why an image could not be brought in.
///
/// A reason rather than a sentence, matching `GenerationError` in
/// `jobs/fal.rs`: the words belong in the locale files, because the frontend
/// is the only side that knows what language to say them in (PRD §10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportErrorReason {
    /// Nothing at that path, or it is not a file.
    NotFound,
    /// The file is there but could not be read.
    Unreadable,
    /// Not a PNG, JPEG or WebP, whatever the extension claims.
    UnsupportedFormat,
    /// Over `MAX_IMAGE_BYTES`.
    TooLarge,
    /// The magic bytes matched but the header did not parse — a truncated or
    /// corrupt file, which we would rather name now than hand to a model.
    UnreadableImage,
    /// The bytes were fine; writing them into the project was not.
    CouldNotSave,
}

/// A refusal, as it crosses to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub reason: ImportErrorReason,
    /// Something specific about this file — the format we actually found, or
    /// the size it actually was. Appended to the sentence, never instead of it.
    pub detail: Option<String>,
    /// The ceiling, in bytes, so the message can name it without the frontend
    /// keeping its own copy of a number Rust enforces.
    pub max_bytes: f64,
}

impl ImportError {
    fn new(reason: ImportErrorReason) -> Self {
        Self {
            reason,
            detail: None,
            max_bytes: MAX_IMAGE_BYTES as f64,
        }
    }

    /// The failure a caller that never got as far as the file reports.
    pub fn could_not_save() -> Self {
        Self::new(ImportErrorReason::CouldNotSave)
    }

    fn with_detail(reason: ImportErrorReason, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(reason)
        }
    }
}

/// What landed in the project folder.
///
/// The dimensions come back because the aspect ratio has to be checked against
/// the project's locked one (PRD §4.4) *before* the upload is recorded, and the
/// frontend cannot read a local file's header itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    /// A bare file name inside the project's `assets` folder, exactly as a
    /// generated asset is — never a path.
    pub asset_name: String,
    pub width: u32,
    pub height: u32,
}

/// The three formats every model in the registry accepts as an image input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    WebP,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::WebP => "webp",
        }
    }

    /// The media type a data URI has to name (#28).
    ///
    /// From the sniffed bytes rather than from the file's extension, for the
    /// same reason the import checks them: a `.png` holding a JPEG would be
    /// handed to fal announced as something it is not.
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::WebP => "image/webp",
        }
    }
}

/// What the bytes actually are, or `None` for anything we do not accept.
///
/// Magic bytes rather than the extension — see the module comment. The list is
/// deliberately short: a format no model takes is a format that would fail at
/// the paid step instead of here.
pub fn sniff_format(bytes: &[u8]) -> Option<ImageFormat> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    if bytes.starts_with(PNG) {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    // RIFF containers hold more than images, so the sub-chunk tag is the part
    // that says WebP.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::WebP);
    }

    None
}

/// A best-effort name for whatever the file turned out to be, for the message.
///
/// Only ever shown alongside a refusal, so a guess is fine and "unknown" is an
/// honest answer — the point is to tell the user *why* their file was declined,
/// not to be a format database.
fn describe_format(bytes: &[u8]) -> String {
    let known: &[(&[u8], &str)] = &[
        (b"GIF87a", "GIF"),
        (b"GIF89a", "GIF"),
        (b"BM", "BMP"),
        (b"II*\0", "TIFF"),
        (b"MM\0*", "TIFF"),
        (b"%PDF", "PDF"),
        (b"\0\0\0", "MP4/MOV"),
    ];

    known
        .iter()
        .find(|(magic, _)| bytes.starts_with(magic))
        .map(|(_, name)| (*name).to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Copies an image the user already has into a project's assets folder.
///
/// Named after the generation that will own it, exactly as a downloaded one is
/// (`jobs/runner.rs`), so the manifest entry and the file agree by construction
/// and the cleanup pass has nothing new to learn.
pub fn import(
    root: &Path,
    project_id: &str,
    generation_id: &str,
    source: &Path,
) -> Result<ImportedImage, ImportError> {
    // The store owns the layout inside a project folder and validates the id on
    // the way — one module decides where a project's files are.
    let dir = assets_dir(root, project_id).map_err(|e| {
        log::error!("Refusing to import an image: {e}");
        ImportError::new(ImportErrorReason::CouldNotSave)
    })?;

    let metadata = fs::metadata(source).map_err(|e| {
        log::warn!("Cannot import {}: {e}", source.display());
        ImportError::new(ImportErrorReason::NotFound)
    })?;

    if !metadata.is_file() {
        return Err(ImportError::new(ImportErrorReason::NotFound));
    }

    // Before the read, not after: the whole point of a ceiling is that the
    // oversized file is never held.
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ImportError::with_detail(
            ImportErrorReason::TooLarge,
            metadata.len().to_string(),
        ));
    }

    let bytes = fs::read(source).map_err(|e| {
        log::warn!("Could not read {}: {e}", source.display());
        ImportError::new(ImportErrorReason::Unreadable)
    })?;

    let format = sniff_format(&bytes).ok_or_else(|| {
        ImportError::with_detail(
            ImportErrorReason::UnsupportedFormat,
            describe_format(&bytes),
        )
    })?;

    let size = imagesize::blob_size(&bytes).map_err(|e| {
        log::warn!("Could not read the dimensions of {}: {e}", source.display());
        ImportError::new(ImportErrorReason::UnreadableImage)
    })?;

    // A zero edge would divide by nothing in the aspect check the frontend runs
    // next, and is not an image anybody meant to upload.
    if size.width == 0 || size.height == 0 {
        return Err(ImportError::new(ImportErrorReason::UnreadableImage));
    }

    fs::create_dir_all(&dir).map_err(|e| {
        log::error!("Could not create the project's assets directory: {e}");
        ImportError::new(ImportErrorReason::CouldNotSave)
    })?;

    let asset_name = asset_file_name(generation_id, format.extension());

    fs::write(dir.join(&asset_name), &bytes).map_err(|e| {
        log::error!("Could not write the imported image: {e}");
        ImportError::new(ImportErrorReason::CouldNotSave)
    })?;

    Ok(ImportedImage {
        asset_name,
        width: size.width as u32,
        height: size.height as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A real 1×1 PNG, byte for byte. Small enough to write out, valid enough
    /// that a header parser has to agree it is one — a hand-waved fixture would
    /// only prove the fixture.
    fn png_1x1() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        // IHDR: length 13, type, width 1, height 1, bit depth 8, colour type 6.
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]); // CRC, unchecked by a header read
        bytes
    }

    /// A PNG of a stated size, for the aspect checks the frontend runs on what
    /// this returns.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = png_1x1();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes
    }

    /// A minimal baseline JPEG: SOI, an SOF0 frame naming the size, EOI.
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8]; // SOI
        bytes.extend_from_slice(&[0xFF, 0xC0]); // SOF0
        bytes.extend_from_slice(&11u16.to_be_bytes()); // segment length
        bytes.push(8); // precision
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[1, 1, 0x11, 0]); // one component
        bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        bytes
    }

    fn source(dir: &TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn an_uploaded_png_lands_in_the_project_as_a_generated_one_would() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "hero.png", &png(1920, 1080));

        let imported = import(root.path(), "atlas", "gen-1", &file).unwrap();

        assert_eq!(imported.asset_name, "gen-1.png");
        assert_eq!((imported.width, imported.height), (1920, 1080));
        assert!(root.path().join("atlas/assets/gen-1.png").exists());
    }

    #[test]
    fn the_original_is_copied_rather_than_moved() {
        // The user's own file is not ours to relocate — a project folder is a
        // copy of what went into it, not a hole where the source used to be.
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "hero.png", &png(64, 64));

        import(root.path(), "atlas", "gen-1", &file).unwrap();

        assert!(file.exists());
    }

    #[test]
    fn a_jpeg_keeps_its_own_extension_and_dimensions() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "shot.jpg", &jpeg(800, 600));

        let imported = import(root.path(), "atlas", "gen-2", &file).unwrap();

        assert_eq!(imported.asset_name, "gen-2.jpeg");
        assert_eq!((imported.width, imported.height), (800, 600));
    }

    #[test]
    fn the_extension_on_disk_does_not_get_a_vote() {
        // A JPEG named `.png` would otherwise be filed as a PNG, and every
        // later reader would be working from a claim rather than the bytes.
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "liar.png", &jpeg(320, 240));

        let imported = import(root.path(), "atlas", "gen-3", &file).unwrap();

        assert_eq!(imported.asset_name, "gen-3.jpeg");
    }

    #[test]
    fn a_format_no_model_accepts_is_refused_by_name() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "old.gif", b"GIF89a\x01\x00\x01\x00\x00\x00\x00");

        let error = import(root.path(), "atlas", "gen-1", &file).unwrap_err();

        assert_eq!(error.reason, ImportErrorReason::UnsupportedFormat);
        assert_eq!(error.detail.as_deref(), Some("GIF"));
        // Nothing refused reaches the project folder.
        assert!(!root.path().join("atlas/assets").exists());
    }

    #[test]
    fn an_oversized_file_is_refused_on_its_size_alone() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        // Valid PNG magic, so the refusal cannot be coming from the sniff.
        let mut bytes = png(16, 16);
        bytes.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        let file = source(&elsewhere, "huge.png", &bytes);

        let error = import(root.path(), "atlas", "gen-1", &file).unwrap_err();

        assert_eq!(error.reason, ImportErrorReason::TooLarge);
        assert_eq!(error.max_bytes, MAX_IMAGE_BYTES as f64);
    }

    #[test]
    fn a_file_that_is_not_there_says_so() {
        let root = TempDir::new().unwrap();
        let missing = root.path().join("never-existed.png");

        assert_eq!(
            import(root.path(), "atlas", "gen-1", &missing)
                .unwrap_err()
                .reason,
            ImportErrorReason::NotFound
        );
    }

    #[test]
    fn a_directory_is_not_an_image() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();

        assert_eq!(
            import(root.path(), "atlas", "gen-1", elsewhere.path())
                .unwrap_err()
                .reason,
            ImportErrorReason::NotFound
        );
    }

    #[test]
    fn a_truncated_png_is_named_rather_than_filed() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        // The magic bytes are right; there is no header behind them.
        let file = source(&elsewhere, "cut.png", &png_1x1()[..10]);

        assert_eq!(
            import(root.path(), "atlas", "gen-1", &file)
                .unwrap_err()
                .reason,
            ImportErrorReason::UnreadableImage
        );
    }

    #[test]
    fn a_project_id_cannot_walk_out_of_the_projects_folder() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "hero.png", &png(64, 64));

        assert_eq!(
            import(root.path(), "../../etc", "gen-1", &file)
                .unwrap_err()
                .reason,
            ImportErrorReason::CouldNotSave
        );
    }

    #[test]
    fn a_generation_id_cannot_escape_the_assets_directory() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        let file = source(&elsewhere, "hero.png", &png(64, 64));

        let imported = import(root.path(), "atlas", "../../escape", &file).unwrap();

        assert_eq!(imported.asset_name, "escape.png");
    }

    #[test]
    fn the_three_formats_are_told_apart_by_their_bytes() {
        assert_eq!(sniff_format(&png_1x1()), Some(ImageFormat::Png));
        assert_eq!(sniff_format(&jpeg(2, 2)), Some(ImageFormat::Jpeg));
        assert_eq!(
            sniff_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(ImageFormat::WebP)
        );
        // A RIFF container that is not a WebP — a WAV, say — is not an image.
        assert_eq!(sniff_format(b"RIFF\x00\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_format(b""), None);
    }
}
