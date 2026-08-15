//! How big an input image should be before it is sent (#51).
//!
//! Split the way `export::plan` is split, and for the same reason: the
//! judgement is a pure function of three numbers, so it is unit-tested without
//! decoding a single pixel, while the half that actually touches pixels stays
//! underneath it and holds no opinions.
//!
//! The thing being fixed is a mismatch nobody chose. The style stage emits
//! 4.7–5.0 MB PNGs, and the animate models they feed cap at 720p and take no
//! resolution parameter at all — so most of those bytes are decoded by the
//! provider and thrown away. They were also enough to time out the submit
//! outright (#50), because a seamless loop sends the same still twice.
//!
//! ## This is not surfaced to the user, on purpose
//!
//! #51 asked whether it should be. It is not, and the reasoning is that a notice
//! here would be about something the user cannot act on: there is no control to
//! change it, no version of the run that skips it, and the alternative to
//! shrinking is a request that fails. A line saying "your image was resized"
//! would be a permanent fixture reporting that the app worked normally.
//!
//! What that trades away is real and worth naming: if output ever looks softer
//! than expected, nothing on screen points here, and the answer is only in the
//! log (`Input image 3840×2160 5022164 B sent as 1920×1080 416234 B`). The
//! moment a user *can* act on it — a per-project quality setting, or a model
//! whose cap makes the difference visible — this becomes the wrong answer.

/// The longest edge an input image is sent at.
///
/// The same number as `export::MAX_WEB_EDGE` and deliberately *not* the same
/// constant. They coincide today because both follow from what a hero is
/// delivered at, but they answer to different things — that one is the width of
/// the file a landing page serves, this one is how much detail a model is given
/// to work from — and tying them together would mean a future change to either
/// silently moved the other.
///
/// **One number for every stage, not one per model, and that is a real
/// tradeoff.** #51 asked whether this should come from the registry, since the
/// animate models cap lower than the style models: Kling and Luma output 720p,
/// so they are handed roughly 2.7× the pixels they will emit. Left global
/// anyway, because the cost of being wrong is asymmetric — too many pixels
/// wastes upload bandwidth the app already has, too few permanently limits what
/// a model can see, and the style models genuinely use the detail. Tightening it
/// per model needs the registry to carry an input cap, which is a new capability
/// column and PRD §5's business rather than this module's guess.
pub const MAX_EDGE: u32 = 1920;

/// Below this, a file is sent exactly as it sits on disk.
///
/// A re-encode is lossy, so it has to earn itself. The source stage's own
/// output is 484–774 KB (measured 2026-08-09), which is already proportionate —
/// re-encoding that would spend quality to save nothing. The style stage's
/// 4.7–5.0 MB PNGs are the case this exists for.
pub const REENCODE_ABOVE_BYTES: u64 = 1024 * 1024;

/// What the file on disk is, as far as this decision cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// What to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Send the bytes already on disk, untouched.
    AsIs,
    /// Re-encode at these dimensions, which may equal the source's.
    Reencode { width: u32, height: u32 },
}

/// Whether this image is worth re-encoding, and at what size.
///
/// Two independent reasons to re-encode, because they catch different files. An
/// image over the edge cap is carrying detail the model will discard. An image
/// under the cap but over the byte threshold is a PNG of a photograph — same
/// pixels, several times the weight — and shrinking it needs no resize at all.
pub fn plan(source: Source) -> Plan {
    let oversized = source.width.max(source.height) > MAX_EDGE;
    let heavy = source.bytes > REENCODE_ABOVE_BYTES;

    if !oversized && !heavy {
        return Plan::AsIs;
    }

    let (width, height) = fit_within(source.width, source.height, MAX_EDGE);
    Plan::Reencode { width, height }
}

/// The largest size inside a cap with the source's own proportions.
///
/// Only ever shrinks. A source already inside the cap comes back unchanged
/// rather than stretched: upscaling invents detail and costs bytes to carry it.
///
/// The cap is a parameter rather than [`MAX_EDGE`] because card thumbnails
/// (#55) shrink the same pixels to a different number, and two copies of this
/// arithmetic is how one of them ends up stretching an image.
pub fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }

    let scale = f64::from(max_edge) / f64::from(longest);
    (
        edge(f64::from(width) * scale),
        edge(f64::from(height) * scale),
    )
}

/// One scaled edge. Never zero — a rounded-away edge is not an image, and the
/// extreme aspect ratios that get close to it are exactly the ones a hero uses.
fn edge(value: f64) -> u32 {
    (value.round() as u32).max(1)
}

/// The bytes to actually send.
///
/// Infallible on purpose. Every way this can fail — an unreadable header, a
/// codec that will not decode, an encoder that will not encode — leaves the
/// original bytes, which are by definition sendable: they are what shipped
/// before this function existed. A run is worth more than a saving, so nothing
/// here is allowed to turn a working generation into a refusal.
///
/// The project's own asset is never touched. This is a copy made for one
/// request, because the file on disk is the deliverable that export reads
/// (PRD §8) and silently degrading it would cost the user the thing they came
/// for.
pub fn apply(bytes: Vec<u8>) -> Vec<u8> {
    let Ok(size) = imagesize::blob_size(&bytes) else {
        log::warn!("Could not read the input image's dimensions; sending it unchanged");
        return bytes;
    };

    let source = Source {
        width: size.width as u32,
        height: size.height as u32,
        bytes: bytes.len() as u64,
    };

    let Plan::Reencode { width, height } = plan(source) else {
        return bytes;
    };

    let before = bytes.len();
    match reencode(&bytes, width, height) {
        // A re-encode that grew the file has cost quality and saved nothing,
        // which is the worst of both. Rare, but a small flat PNG can do it.
        Ok(smaller) if smaller.len() < before => {
            log::info!(
                "Input image {}×{} {before} B sent as {width}×{height} {} B",
                source.width,
                source.height,
                smaller.len()
            );
            smaller
        }
        Ok(bigger) => {
            log::info!(
                "Re-encoding would have grown the input image from {before} to {} B; sending it unchanged",
                bigger.len()
            );
            bytes
        }
        Err(e) => {
            log::warn!("Could not re-encode the input image ({e}); sending it unchanged");
            bytes
        }
    }
}

/// JPEG quality for a re-encoded input.
///
/// Higher than the poster's equivalent, because this image is not the
/// deliverable — it is what a model reads before generating one, and an
/// artefact here can be reproduced and amplified in everything downstream.
const JPEG_QUALITY: u8 = 88;

/// Decode, resize, re-encode — the one place pixels are actually touched.
///
/// Public because card thumbnails (#55) are the same operation at a smaller
/// number, and ADR 0004 says so explicitly: a second decode/resize path would
/// be a second set of answers about alpha, filtering and quality.
pub fn reencode(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, image::ImageError> {
    let decoded = image::load_from_memory(bytes)?;

    let resized = if decoded.width() == width && decoded.height() == height {
        decoded
    } else {
        // Lanczos3 over anything cheaper: this is a downscale of a photograph
        // that a model is about to read for detail, and nearest or triangle
        // would hand it aliasing to interpret.
        decoded.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
    };

    let mut out = std::io::Cursor::new(Vec::new());

    // JPEG cannot carry alpha, and `to_rgb8` does not composite — it drops the
    // channel, turning transparent pixels into whatever was underneath, which
    // is usually black. A user-uploaded PNG with transparency (#27) would come
    // back with a black background, so it stays a PNG and keeps its channel.
    if resized.color().has_alpha() {
        resized.write_to(&mut out, image::ImageFormat::Png)?;
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .encode_image(&resized.to_rgb8())?;
    }

    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::import::sniff_format;
    use image::{ImageFormat, RgbImage};

    /// A gradient rather than a flat fill: a solid colour compresses to almost
    /// nothing in both formats, which would prove nothing about either.
    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });

        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, ImageFormat::Png)
            .expect("a synthetic PNG encodes");
        out.into_inner()
    }

    #[test]
    fn an_oversized_png_comes_back_smaller_and_capped() {
        let original = png_of(2400, 1350);

        let prepared = apply(original.clone());

        let size = imagesize::blob_size(&prepared).expect("the result is an image");
        assert_eq!((size.width, size.height), (1920, 1080));
        assert!(
            prepared.len() < original.len(),
            "prepared {} bytes is not smaller than the original {}",
            prepared.len(),
            original.len()
        );
        assert_eq!(
            sniff_format(&prepared).map(|f| f.mime()),
            Some("image/jpeg"),
            "the whole saving is PNG-to-JPEG on a photographic still"
        );
    }

    #[test]
    fn a_hero_sized_png_is_brought_down_to_the_cap() {
        // The measured case: a styled 4K PNG, ~5 MB, feeding a 720p model.
        let plan = plan(Source {
            width: 3840,
            height: 2160,
            bytes: 5_022_164,
        });

        assert_eq!(
            plan,
            Plan::Reencode {
                width: 1920,
                height: 1080
            }
        );
    }

    #[test]
    fn transparency_survives_rather_than_turning_black() {
        // A user-uploaded PNG with an alpha channel (#27). JPEG has nowhere to
        // put it, and dropping it silently paints the transparent regions
        // black — a corruption that would only be noticed in the output.
        let transparent = image::RgbaImage::from_fn(2400, 1350, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, (x % 256) as u8])
        });
        let mut original = std::io::Cursor::new(Vec::new());
        transparent
            .write_to(&mut original, ImageFormat::Png)
            .expect("a synthetic RGBA PNG encodes");

        let prepared = apply(original.into_inner());

        let size = imagesize::blob_size(&prepared).expect("the result is an image");
        assert_eq!((size.width, size.height), (1920, 1080));
        assert_eq!(
            sniff_format(&prepared).map(|f| f.mime()),
            Some("image/png"),
            "an image with alpha stays in a format that has alpha"
        );
    }

    #[test]
    fn a_flat_graphic_survives_the_re_encode_without_visible_banding() {
        // #51 named this risk: "a styled still with hard flat colour or text may
        // band". Measured rather than assumed — a large flat field with hard
        // edges is the worst case for JPEG, and the assertion is on the error
        // against the source rather than on the file size, because banding is a
        // pixel problem and a small file is not evidence of one.
        let flat = image::RgbImage::from_fn(2400, 1350, |x, y| {
            // Four solid quadrants plus a hard 2px cross — no gradient anywhere
            // for the quantiser to hide error in.
            let near_edge = (x as i64 - 1200).abs() < 2 || (y as i64 - 675).abs() < 2;
            if near_edge {
                image::Rgb([255, 255, 255])
            } else {
                match (x < 1200, y < 675) {
                    (true, true) => image::Rgb([18, 22, 30]),
                    (false, true) => image::Rgb([220, 40, 60]),
                    (true, false) => image::Rgb([30, 90, 200]),
                    (false, false) => image::Rgb([240, 236, 228]),
                }
            }
        });
        let mut source = std::io::Cursor::new(Vec::new());
        flat.write_to(&mut source, ImageFormat::Png)
            .expect("a synthetic PNG encodes");

        // `reencode` directly rather than through `apply`, because banding is a
        // property of the encoder and this image never reaches it: flat colour
        // compresses better in PNG than in JPEG, so `apply` finds the re-encode
        // came out *larger* and keeps the original. That is the right call and
        // it is pinned by its own test below — but it would make this one
        // vacuous, comparing a PNG against itself.
        let prepared = reencode(&source.into_inner(), 1920, 1080).expect("a flat PNG re-encodes");
        let decoded = image::load_from_memory(&prepared)
            .expect("the re-encode decodes")
            .to_rgb8();

        // Compare against the source scaled the same way, so the resize itself
        // is not counted as JPEG error.
        let reference = image::DynamicImage::ImageRgb8(flat)
            .resize_exact(1920, 1080, image::imageops::FilterType::Lanczos3)
            .to_rgb8();

        let worst = decoded
            .pixels()
            .zip(reference.pixels())
            .flat_map(|(a, b)| {
                (0..3).map(move |c| (i32::from(a[c]) - i32::from(b[c])).unsigned_abs())
            })
            .max()
            .expect("the image has pixels");

        let total: u64 = decoded
            .pixels()
            .zip(reference.pixels())
            .flat_map(|(a, b)| {
                (0..3).map(move |c| u64::from((i32::from(a[c]) - i32::from(b[c])).unsigned_abs()))
            })
            .sum();
        let mean = total as f64 / (decoded.pixels().len() * 3) as f64;

        // Ringing at a hard edge is unavoidable in a DCT codec; what matters is
        // that it stays local. A mean error under one level means the flat
        // fields themselves are clean, which is what banding would spoil.
        assert!(
            mean < 1.0,
            "mean channel error {mean:.3} — the flat fields are banding, not just the edges"
        );
        assert!(
            worst < 96,
            "worst channel error {worst} — ringing at the edges is out of hand"
        );
    }

    #[test]
    fn a_flat_graphic_that_jpeg_would_inflate_is_sent_unchanged() {
        // PNG beats JPEG on flat colour, sometimes by a lot. When it does, a
        // re-encode would spend quality *and* bytes — the worst of both — so the
        // original goes as it is, even though it is over the edge cap.
        //
        // The cap is about not paying for detail the model discards, and there
        // is nothing to save here: this file is already tiny. Deliberately a
        // smaller image than the banding test above so it stays quick.
        let flat = image::RgbImage::from_fn(2400, 1350, |x, y| match (x < 1200, y < 675) {
            (true, true) => image::Rgb([18, 22, 30]),
            (false, true) => image::Rgb([220, 40, 60]),
            (true, false) => image::Rgb([30, 90, 200]),
            (false, false) => image::Rgb([240, 236, 228]),
        });
        let mut source = std::io::Cursor::new(Vec::new());
        flat.write_to(&mut source, ImageFormat::Png)
            .expect("a synthetic PNG encodes");
        let original = source.into_inner();

        let prepared = apply(original.clone());

        assert_eq!(
            prepared, original,
            "a re-encode that grows the file is declined outright"
        );
    }

    #[test]
    fn something_that_will_not_decode_is_sent_exactly_as_it_was() {
        // The whole fallback contract: a saving is optional, the run is not.
        let bytes = b"this is not an image at all".to_vec();

        assert_eq!(apply(bytes.clone()), bytes);
    }

    #[test]
    fn a_small_image_is_never_stretched_to_the_cap() {
        // Upscaling invents detail and then charges to carry it. A 600px still
        // that is somehow heavy is re-encoded at 600px, not at 1920.
        assert_eq!(
            plan(Source {
                width: 600,
                height: 400,
                bytes: 4_000_000,
            }),
            Plan::Reencode {
                width: 600,
                height: 400
            }
        );
    }

    #[test]
    fn a_tall_image_caps_its_height_rather_than_its_width() {
        // The cap is on the longest edge, not on the width — a 9:16 still is as
        // heavy as a 16:9 one and would otherwise sail through untouched.
        assert_eq!(
            plan(Source {
                width: 2160,
                height: 3840,
                bytes: 5_000_000,
            }),
            Plan::Reencode {
                width: 1080,
                height: 1920
            }
        );
    }

    #[test]
    fn a_heavy_file_inside_the_cap_is_re_encoded_at_its_own_size() {
        // A PNG of a photograph: right dimensions, several times the weight it
        // needs. There is nothing to resize and plenty to save.
        assert_eq!(
            plan(Source {
                width: 1600,
                height: 900,
                bytes: 4_700_000,
            }),
            Plan::Reencode {
                width: 1600,
                height: 900
            }
        );
    }

    #[test]
    fn an_extreme_ratio_keeps_a_real_edge_rather_than_rounding_one_away() {
        // 21:9 is a hero ratio and the short edge survives; the guard matters
        // for anything more extreme still.
        let Plan::Reencode { width, height } = plan(Source {
            width: 5040,
            height: 2160,
            bytes: 6_000_000,
        }) else {
            panic!("an oversized still is re-encoded");
        };

        assert_eq!(width, MAX_EDGE);
        assert!(height >= 1, "an edge never rounds away to nothing");
        assert_eq!(height, 823);
    }

    #[test]
    fn something_already_proportionate_is_sent_untouched() {
        // A source-stage JPEG. Re-encoding this spends quality and saves
        // nothing, so the cheapest correct answer is to leave it alone.
        assert_eq!(
            plan(Source {
                width: 1344,
                height: 768,
                bytes: 484_287,
            }),
            Plan::AsIs
        );
    }
}
