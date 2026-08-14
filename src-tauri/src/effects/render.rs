//! One still, through a diffusion kernel and out as a PNG.
//!
//! The pipeline is #52's verdict, in the order it settled on: **dither the
//! luminance to an N-level mask, then map the mask to inks.** Not "quantise to
//! N colours, then dither what is left" — that arm reduces every pixel to an ink
//! before the dither has anything to distribute, and the A/B came back against
//! it broadly. The same order is what the shaders do, which is what lets a user
//! switch from Bayer to Atkinson and see the same picture in a different
//! texture rather than a different picture.
//!
//! Reduction and dither are **one fused pass** and not two. That is the maths
//! rather than a shortcut: a duotone alone leaves two inks and nothing for a
//! later dither to distribute, and a dither alone has no palette to dither
//! *toward*. Fusing them is why a look is one authored effect and not a chain
//! the user assembles.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::color::{linear_from_hex, luminance, srgb_to_linear, SrgbEncodeTable};
use super::diffusion::{diffuse, DiffusionKernel};

/// The most inks a reduction may target — the shaders' `uInks` ceiling, so the
/// two paths cannot disagree about what is expressible.
const MAX_INKS: usize = 8;

/// What one CPU render was asked for.
///
/// The **inks are resolved before they get here**, darkest first: a duotone
/// arrives as a ramp between its two colours and a palette reduction arrives as
/// the project's own entries. Which colours a look uses is a question about the
/// look and the project, and this module's business is where the levels sit and
/// how the error moves.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CpuEffect {
    /// `#RRGGBB`, darkest first, at least two.
    pub inks: Vec<String>,
    pub kernel: DiffusionKernel,
    /// Whether the levels sit where the inks' luminances actually are.
    ///
    /// `false` spaces them evenly across the range, which is the
    /// higher-contrast reading — and what #52 measured losing up to 0.22 of
    /// mean linear luminance on Studio's four inks, because both interior steps
    /// land in the one gap that palette has no ink for. Inert on a ramp, whose
    /// luminances are already evenly spaced, which is why a duotone never has
    /// to answer this question.
    pub palette_shaped: bool,
}

/// Why a CPU render produced nothing.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum EffectError {
    /// The candidate has no file, or the file is not on disk.
    NoAsset,
    /// The bytes are not a picture this build can decode.
    Undecodable { detail: String },
    /// The treatment names fewer than two inks, or a colour that is not one.
    UnusableInks,
    /// The PNG could not be written back.
    EncodeFailed { detail: String },
}

impl std::fmt::Display for EffectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EffectError::NoAsset => write!(f, "that generation has no file"),
            EffectError::Undecodable { detail } => {
                write!(f, "the image could not be read: {detail}")
            }
            EffectError::UnusableInks => write!(f, "the treatment names no usable inks"),
            EffectError::EncodeFailed { detail } => {
                write!(f, "the frame could not be encoded: {detail}")
            }
        }
    }
}

/// The treated frame, as PNG bytes.
pub fn render_png(source: &[u8], effect: &CpuEffect) -> Result<Vec<u8>, EffectError> {
    let image = image::load_from_memory(source)
        .map_err(|e| EffectError::Undecodable {
            detail: e.to_string(),
        })?
        .to_rgb8();

    let treated = render(&image, effect)?;

    let mut out = std::io::Cursor::new(Vec::new());
    treated
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| EffectError::EncodeFailed {
            detail: e.to_string(),
        })?;

    Ok(out.into_inner())
}

/// The treated frame, as pixels.
///
/// Split from [`render_png`] so the interesting half is testable without an
/// encoder anywhere near it.
pub fn render(image: &image::RgbImage, effect: &CpuEffect) -> Result<image::RgbImage, EffectError> {
    let inks = resolve_inks(&effect.inks)?;
    let levels = level_luminances(&inks, effect.palette_shaped);

    // A 256-entry decode table: the transfer function is per-byte, and calling
    // `powf` eleven million times to decode a 2560×1440 frame would cost more
    // than the kernel does.
    let decode: [f32; 256] = std::array::from_fn(|i| srgb_to_linear(i as u8));

    let plane: Vec<f32> = image
        .pixels()
        .map(|p| {
            luminance([
                decode[p[0] as usize],
                decode[p[1] as usize],
                decode[p[2] as usize],
            ])
        })
        .collect();

    let chosen = diffuse(
        &plane,
        image.width(),
        image.height(),
        effect.kernel,
        |value| nearest(&levels, value),
    );

    let encode = SrgbEncodeTable::new();
    let mut out = image::RgbImage::new(image.width(), image.height());

    for (dst, index) in out.pixels_mut().zip(chosen.iter()) {
        let ink = inks[*index];
        *dst = image::Rgb([
            encode.encode(ink[0]),
            encode.encode(ink[1]),
            encode.encode(ink[2]),
        ]);
    }

    Ok(out)
}

fn resolve_inks(hexes: &[String]) -> Result<Vec<[f32; 3]>, EffectError> {
    if hexes.len() < 2 || hexes.len() > MAX_INKS {
        return Err(EffectError::UnusableInks);
    }

    hexes
        .iter()
        .map(|hex| linear_from_hex(hex).ok_or(EffectError::UnusableInks))
        .collect()
}

/// Where each level sits on the luminance axis.
///
/// Palette-shaped is the inks' own luminances; even spreads the same count
/// across the same range. Sorted either way, because the quantiser walks them
/// and the whole shape of the reduction is *index → colour*.
fn level_luminances(inks: &[[f32; 3]], palette_shaped: bool) -> Vec<f32> {
    let own: Vec<f32> = inks.iter().map(|ink| luminance(*ink)).collect();
    if palette_shaped {
        return own;
    }

    let lo = own.first().copied().unwrap_or(0.0);
    let hi = own.last().copied().unwrap_or(1.0);
    let steps = (own.len() - 1) as f32;

    (0..own.len())
        .map(|i| lo + (hi - lo) * (i as f32 / steps))
        .collect()
}

/// The level closest to `value`, and the luminance the error is measured
/// against.
fn nearest(levels: &[f32], value: f32) -> (usize, f32) {
    let mut best = 0usize;
    let mut best_distance = f32::INFINITY;
    for (i, level) in levels.iter().enumerate() {
        let d = (level - value).abs();
        if d < best_distance {
            best_distance = d;
            best = i;
        }
    }
    (best, levels[best])
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: &str = "#14110F";
    const PAPER: &str = "#F4EFE6";

    fn duotone(kernel: DiffusionKernel) -> CpuEffect {
        CpuEffect {
            inks: vec![INK.to_string(), PAPER.to_string()],
            kernel,
            palette_shaped: true,
        }
    }

    fn flat(level: u8, w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_pixel(w, h, image::Rgb([level, level, level]))
    }

    #[test]
    fn every_pixel_comes_back_as_one_of_the_inks() {
        // The defining property of a reduction: nothing between the inks
        // survives, however the error moved to get there.
        let out = render(&flat(128, 64, 64), &duotone(DiffusionKernel::Atkinson)).unwrap();
        let ink = image::Rgb([0x14, 0x11, 0x0F]);
        let paper = image::Rgb([0xF4, 0xEF, 0xE6]);

        for pixel in out.pixels() {
            assert!(*pixel == ink || *pixel == paper, "{pixel:?}");
        }
    }

    #[test]
    fn a_mid_grey_field_lands_between_the_two_inks() {
        // sRGB 128 is about 0.216 of the light, and the paper is far lighter
        // than the ink — so most of the frame should be ink, not half of it.
        // Checking that it is neither all one nor all the other is the honest
        // assertion; the exact ratio is the transfer function's business.
        let out = render(
            &flat(128, 128, 128),
            &duotone(DiffusionKernel::FloydSteinberg),
        )
        .unwrap();
        let lit = out.pixels().filter(|p| p.0[0] > 0x80).count() as f32 / (128.0 * 128.0);

        assert!(lit > 0.05 && lit < 0.5, "{lit} of the field was paper");
    }

    #[test]
    fn a_solid_black_frame_does_not_speckle() {
        let out = render(&flat(0, 32, 32), &duotone(DiffusionKernel::Atkinson)).unwrap();
        assert!(out.pixels().all(|p| *p == image::Rgb([0x14, 0x11, 0x0F])));
    }

    #[test]
    fn the_output_keeps_the_frame_it_was_given() {
        // Output dimensions must not depend on whether a treatment exists.
        let out = render(&flat(200, 37, 19), &duotone(DiffusionKernel::Atkinson)).unwrap();
        assert_eq!((out.width(), out.height()), (37, 19));
    }

    #[test]
    fn even_placement_moves_the_interior_levels_and_palette_shaped_does_not() {
        // #52's measurement, as a property: on a palette whose middle entries
        // sit away from the line between its ends, the two placements put the
        // levels in different places. On a ramp they coincide, which is why the
        // knob is inert there.
        let brand = ["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"]
            .map(|hex| linear_from_hex(hex).unwrap())
            .to_vec();

        let shaped = level_luminances(&brand, true);
        let even = level_luminances(&brand, false);

        assert_eq!(shaped.first(), even.first());
        assert_eq!(shaped.last(), even.last());
        assert!(
            (shaped[1] - even[1]).abs() > 0.1,
            "shaped {shaped:?} against even {even:?}"
        );
    }

    #[test]
    fn a_treatment_naming_a_colour_that_is_not_one_is_refused() {
        let broken = CpuEffect {
            inks: vec!["#14110F".into(), "cerulean".into()],
            kernel: DiffusionKernel::Atkinson,
            palette_shaped: true,
        };
        assert!(matches!(
            render(&flat(128, 8, 8), &broken),
            Err(EffectError::UnusableInks)
        ));
    }

    #[test]
    fn fewer_than_two_inks_is_not_a_reduction() {
        let one = CpuEffect {
            inks: vec!["#14110F".into()],
            kernel: DiffusionKernel::Atkinson,
            palette_shaped: true,
        };
        assert!(matches!(
            render(&flat(128, 8, 8), &one),
            Err(EffectError::UnusableInks)
        ));
    }

    #[test]
    fn the_png_it_writes_is_one_that_reads_back() {
        let png = render_png(
            &encode_png(&flat(128, 24, 24)),
            &duotone(DiffusionKernel::Atkinson),
        )
        .unwrap();

        let back = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((back.width(), back.height()), (24, 24));
    }

    #[test]
    fn bytes_that_are_not_a_picture_are_named_rather_than_panicking() {
        assert!(matches!(
            render_png(b"not a picture", &duotone(DiffusionKernel::Atkinson)),
            Err(EffectError::Undecodable { .. })
        ));
    }

    fn encode_png(image: &image::RgbImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }
}
