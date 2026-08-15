//! Card thumbnails — small pictures the overview can afford to draw (#55).
//!
//! ADR 0004 settled the question this module exists to answer: a project card
//! points at a purpose-built thumbnail, never at the original. The style stage
//! emits 4.7–5.0 MB PNGs, so a grid of twenty cards pointed at originals decodes
//! on the order of a hundred megabytes to draw pictures a few hundred pixels
//! wide.
//!
//! **Everything here is derived data.** Delete the whole lot and the next
//! listing writes them again, because [`ensure`] is called from
//! `store::summarize`, which runs on every save *and* on every reconcile. That
//! is the same guarantee the index itself has, and it is why nothing in a
//! thumbnail is allowed to be unrecoverable — no crop the user chose, no
//! annotation, nothing that is not a smaller copy of the asset beside it.
//!
//! The one thing this module cannot make is a video poster. Capturing a frame
//! needs a decoder, and the alternative to shipping an ffmpeg-class dependency
//! for one frame is asking the webview — which already has a video decoder — to
//! draw one and hand it back ([`write_poster`]).

use std::path::Path;

use crate::jobs::downscale;

/// The longest edge a thumbnail is written at.
///
/// A card is a few hundred CSS pixels wide, and this is roughly two of those so
/// a Retina panel has real pixels to draw with. Bigger buys nothing visible and
/// costs the disk it was meant to save.
pub const MAX_EDGE: u32 = 480;

/// What marks a file in `assets` as a thumbnail rather than a deliverable.
///
/// An infix rather than a prefix, so a thumbnail sorts next to its original in
/// Finder — the folder is meant to be inspectable (PRD §3.2), and a parallel
/// list of `thumb-*` files reads as a second set of images rather than as
/// smaller copies of the first.
const INFIX: &str = ".thumb";

/// Extensions [`ensure`] can produce. Two, because the decode/resize path keeps
/// an alpha channel in a format that has one — see `downscale::reencode`.
const EXTENSIONS: [&str; 2] = ["jpg", "png"];

/// Extensions this app files a clip under. Anything else is a still.
const VIDEO_EXTENSIONS: [&str; 3] = ["mp4", "webm", "mov"];

/// Whether this asset is a clip, and so needs the webview to draw its poster.
pub fn is_video(asset: &str) -> bool {
    extension_of(asset).is_some_and(|ext| VIDEO_EXTENSIONS.contains(&ext.as_str()))
}

/// The asset stem a thumbnail belongs to — `gen-1.thumb.jpg` → `gen-1`, and
/// `None` for a file that is not a thumbnail at all.
///
/// Cleanup's question, asked this way round on purpose: it needs to know which
/// generation a file belongs to, not merely that it is derived, or it would see
/// every thumbnail as a file nothing points at and offer to reclaim the lot
/// (ADR 0004).
pub fn thumbnailed_stem(name: &str) -> Option<String> {
    let stem = stem_of(name)?;
    stem.strip_suffix(INFIX).map(str::to_string)
}

/// The thumbnail beside this asset, if one has already been written.
///
/// Keyed on the stem rather than the whole file name, so `gen-1.png` and
/// `gen-1.jpeg` share one thumbnail. That is correct rather than a collision:
/// an asset is named after its generation (`store::asset_file_name`), ids are
/// minted per generation, and `store::asset_path` already treats the stem as
/// the generation's identity — two files with one stem are two encodings of one
/// candidate, and one picture of it is the right answer.
pub fn existing(assets_dir: &Path, asset: &str) -> Option<String> {
    let stem = stem_of(asset)?;

    EXTENSIONS
        .iter()
        .map(|extension| format!("{stem}{INFIX}.{extension}"))
        .find(|name| assets_dir.join(name).is_file())
}

/// The thumbnail for this asset, writing one if it is missing.
///
/// `None` is a normal answer, not a failure: a clip has no poster until the
/// webview draws one, and an asset that has not landed yet has no pixels to
/// shrink. The overview shows a card without a picture rather than nothing at
/// all, which is the right trade — a project is worth listing before its first
/// generation finishes.
///
/// Infallible by construction, for the reason `downscale::apply` is: a listing
/// is worth more than a thumbnail, and nothing here may turn a readable library
/// into an error.
pub fn ensure(assets_dir: &Path, asset: &str) -> Option<String> {
    if let Some(found) = existing(assets_dir, asset) {
        return Some(found);
    }

    // A clip's poster comes from the webview, so there is nothing to generate
    // here — and nothing wrong either. See the module comment.
    if is_video(asset) {
        return None;
    }

    let bytes = std::fs::read(assets_dir.join(asset)).ok()?;

    match shrink_and_file(assets_dir, asset, &bytes) {
        Ok(name) => Some(name),
        Err(e) => {
            log::warn!("Could not make a thumbnail of {asset}: {e}");
            None
        }
    }
}

/// Files a poster the webview drew for a clip.
///
/// The bytes are decoded before they are trusted: they arrive from the webview,
/// and a thumbnail that is not an image would be a permanently broken card that
/// no rebuild could fix — `ensure` would find the file and stop.
pub fn write_poster(assets_dir: &Path, asset: &str, bytes: &[u8]) -> Result<String, String> {
    shrink_and_file(assets_dir, asset, bytes)
}

/// Shrinks an image and files it as the thumbnail of `asset`.
///
/// The one place a thumbnail is made, whether its pixels came off disk or out
/// of the webview's decoder. Both callers need the same three answers — what
/// size, which encoder, what the file is called — and two copies of that is how
/// a captured poster ends up named `.jpg` while holding a PNG.
fn shrink_and_file(assets_dir: &Path, asset: &str, bytes: &[u8]) -> Result<String, String> {
    let stem = stem_of(asset).ok_or_else(|| format!("{asset:?} is not a file name"))?;

    let size =
        imagesize::blob_size(bytes).map_err(|e| format!("{asset} is not a readable image: {e}"))?;

    let (width, height) = downscale::fit_within(size.width as u32, size.height as u32, MAX_EDGE);
    let shrunk = downscale::reencode(bytes, width, height)
        .map_err(|e| format!("Could not shrink {asset}: {e}"))?;

    // Named after what came out rather than what we asked for: an image with
    // alpha comes back a PNG, because JPEG has nowhere to put the channel.
    let extension = if shrunk.starts_with(b"\x89PNG") {
        "png"
    } else {
        "jpg"
    };
    let name = format!("{stem}{INFIX}.{extension}");

    std::fs::create_dir_all(assets_dir)
        .map_err(|e| format!("Could not create the assets folder: {e}"))?;
    std::fs::write(assets_dir.join(&name), &shrunk)
        .map_err(|e| format!("Could not write the thumbnail for {asset}: {e}"))?;

    Ok(name)
}

fn stem_of(name: &str) -> Option<String> {
    Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
}

fn extension_of(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage};
    use tempfile::TempDir;

    fn png_of(dir: &Path, name: &str, width: u32, height: u32) {
        let image = RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, ImageFormat::Png)
            .expect("a synthetic PNG encodes");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), out.into_inner()).unwrap();
    }

    #[test]
    fn a_card_gets_a_small_picture_rather_than_the_original() {
        // ADR 0004's whole reason: the original is a hero, the card is a card.
        let dir = TempDir::new().unwrap();
        png_of(dir.path(), "gen-1.png", 2400, 1350);

        let name = ensure(dir.path(), "gen-1.png").expect("a still gets a thumbnail");

        let bytes = std::fs::read(dir.path().join(&name)).unwrap();
        let size = imagesize::blob_size(&bytes).unwrap();
        assert_eq!((size.width as u32, size.height as u32), (480, 270));
        assert!(
            bytes.len()
                < std::fs::metadata(dir.path().join("gen-1.png"))
                    .unwrap()
                    .len() as usize
        );
    }

    #[test]
    fn a_thumbnail_is_written_once_and_then_found() {
        let dir = TempDir::new().unwrap();
        png_of(dir.path(), "gen-1.png", 800, 800);

        let first = ensure(dir.path(), "gen-1.png").unwrap();
        let written = std::fs::metadata(dir.path().join(&first)).unwrap().len();
        // Overwrite it with something recognisably different, then ask again:
        // a second `ensure` must not regenerate what is already there.
        std::fs::write(dir.path().join(&first), vec![0u8; 7]).unwrap();

        assert_eq!(
            ensure(dir.path(), "gen-1.png").as_deref(),
            Some(first.as_str())
        );
        assert_ne!(
            std::fs::metadata(dir.path().join(&first)).unwrap().len(),
            written
        );
    }

    #[test]
    fn deleting_a_thumbnail_costs_nothing_but_a_rebuild() {
        // The rebuild guarantee ADR 0004 extends to thumbnails, as an assertion.
        let dir = TempDir::new().unwrap();
        png_of(dir.path(), "gen-1.png", 900, 600);
        let name = ensure(dir.path(), "gen-1.png").unwrap();

        std::fs::remove_file(dir.path().join(&name)).unwrap();

        assert_eq!(
            ensure(dir.path(), "gen-1.png").as_deref(),
            Some(name.as_str())
        );
        assert!(dir.path().join(&name).is_file());
    }

    #[test]
    fn a_clip_has_no_thumbnail_until_the_webview_draws_one() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("gen-ani-1.mp4"), vec![0u8; 32]).unwrap();

        assert_eq!(ensure(dir.path(), "gen-ani-1.mp4"), None);

        let mut poster = std::io::Cursor::new(Vec::new());
        RgbImage::from_fn(1920, 1080, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 40])
        })
        .write_to(&mut poster, ImageFormat::Png)
        .unwrap();
        let name = write_poster(dir.path(), "gen-ani-1.mp4", &poster.into_inner()).unwrap();

        assert_eq!(
            ensure(dir.path(), "gen-ani-1.mp4").as_deref(),
            Some(name.as_str())
        );
    }

    #[test]
    fn a_poster_that_is_not_an_image_is_refused_rather_than_filed() {
        // It comes from the webview, and a bad file here is a card no rebuild
        // could fix: `ensure` would find it and stop.
        let dir = TempDir::new().unwrap();

        assert!(write_poster(dir.path(), "gen-ani-1.mp4", b"not an image").is_err());
        assert_eq!(ensure(dir.path(), "gen-ani-1.mp4"), None);
    }

    #[test]
    fn an_unreadable_asset_leaves_the_project_listable() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("gen-1.png"), b"{ not an image").unwrap();

        assert_eq!(ensure(dir.path(), "gen-1.png"), None);
    }

    #[test]
    fn a_thumbnail_names_the_asset_it_was_made_from() {
        assert_eq!(
            thumbnailed_stem("gen-1.thumb.jpg").as_deref(),
            Some("gen-1")
        );
        assert_eq!(thumbnailed_stem("gen-1.png"), None);
    }

    #[test]
    fn transparency_survives_into_the_thumbnail() {
        // Same rule as the input path: JPEG has nowhere to put alpha, so an
        // image that has it stays a PNG — and the file is named after what was
        // actually written rather than what we hoped for.
        let dir = TempDir::new().unwrap();
        let transparent = image::RgbaImage::from_fn(1200, 800, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, (x % 256) as u8])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        transparent.write_to(&mut out, ImageFormat::Png).unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("gen-1.png"), out.into_inner()).unwrap();

        let name = ensure(dir.path(), "gen-1.png").unwrap();

        assert!(name.ends_with(".png"), "got {name}");
    }
}
