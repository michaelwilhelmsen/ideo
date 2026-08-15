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
//!
//! **The caller says how big, on both grids.** A render is asked for a [`Grid`]
//! — where the pattern is decided and what the frame ships at — because those
//! are two different questions once #58 lets an export ask for more pixels than
//! the look was dialled in at. The dither runs on the first and is magnified
//! nearest-neighbour onto the second, which is this path's answer to the
//! `pattern_scale` the shaders divide their coordinates by: the same look, with
//! more pixels resolving its edges, rather than a finer screen nobody asked for.
//! Diffusing straight onto the shipped grid would be the finer screen, and
//! resampling *after* the dither would blur the dots it just decided.

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

/// The two grids one render answers to (#58).
///
/// They are equal at `ExportSize::Web`, which is every export there was before
/// the size control, and the magnification below is then an identity.
#[derive(Debug, Clone, Copy)]
pub struct Grid {
    /// Where the pattern is decided: the look's own resolution, which is the
    /// web width and the size the effects tab previews at.
    pub look: (u32, u32),
    /// What the frame ships at — `look` magnified by the chosen size's pattern
    /// scale, whole or fractional.
    pub shipped: (u32, u32),
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

/// The treated frame, as PNG bytes, on `grid`.
pub fn render_png(source: &[u8], effect: &CpuEffect, grid: Grid) -> Result<Vec<u8>, EffectError> {
    let image = image::load_from_memory(source)
        .map_err(|e| EffectError::Undecodable {
            detail: e.to_string(),
        })?
        .to_rgb8();

    let treated = render(&image, effect, grid)?;

    let mut out = std::io::Cursor::new(Vec::new());
    treated
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| EffectError::EncodeFailed {
            detail: e.to_string(),
        })?;

    Ok(out.into_inner())
}

/// The treated frame, as pixels, on `grid`.
///
/// Split from [`render_png`] so the interesting half is testable without an
/// encoder anywhere near it.
pub fn render(
    image: &image::RgbImage,
    effect: &CpuEffect,
    grid: Grid,
) -> Result<image::RgbImage, EffectError> {
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

    // A size of zero is not a frame; the export path never asks for one, and
    // clamping is cheaper than a fourth `EffectError` nothing would produce.
    let (width, height) = (grid.look.0.max(1), grid.look.1.max(1));
    let plane = resample(&plane, (image.width(), image.height()), (width, height));

    let chosen = diffuse(&plane, width, height, effect.kernel, |value| {
        nearest(&levels, value)
    });

    let encode = SrgbEncodeTable::new();
    let mut out = image::RgbImage::new(width, height);

    for (dst, index) in out.pixels_mut().zip(chosen.iter()) {
        let ink = inks[*index];
        *dst = image::Rgb([
            encode.encode(ink[0]),
            encode.encode(ink[1]),
            encode.encode(ink[2]),
        ]);
    }

    Ok(magnify(
        &out,
        (grid.shipped.0.max(1), grid.shipped.1.max(1)),
    ))
}

/// The decided frame on the grid it ships at, nearest-neighbour.
///
/// **Nearest and nothing else.** Every pixel here is already one of the inks,
/// and any filter with a second tap in it would average two of them into a
/// colour the reduction exists to have removed — a soft edge on a dot that was
/// decided hard. Which is also why this runs after the dither rather than
/// instead of it: what a bigger export buys is more pixels resolving the
/// pattern's edges, not more pattern.
///
/// A fractional scale is not rounded away. At `ExportSize::Native` from a
/// 2560-wide candidate it is 1.333, so look pixels come out one and two output
/// pixels wide in turn — which is what a nearest-neighbour magnification by
/// 1.333 *is*, and is the reading `ExportSize::pattern_scale` already argues for
/// on the shader side.
fn magnify(frame: &image::RgbImage, to: (u32, u32)) -> image::RgbImage {
    if (frame.width(), frame.height()) == to {
        return frame.clone();
    }

    image::RgbImage::from_fn(to.0, to.1, |x, y| {
        // In whole numbers, so a wide frame cannot drift off the last column
        // the way repeated float addition would.
        let sx = (u64::from(x) * u64::from(frame.width()) / u64::from(to.0)) as u32;
        let sy = (u64::from(y) * u64::from(frame.height()) / u64::from(to.1)) as u32;
        *frame.get_pixel(sx.min(frame.width() - 1), sy.min(frame.height() - 1))
    })
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

/// The luminance plane, on the grid the frame will ship at.
///
/// **Resampled here rather than on the RGB**, which is not a shortcut: luminance
/// is a fixed linear combination of linear-light channels and this is a weighted
/// average of them, so averaging the luminances and taking the luminance of the
/// averages are the same number. It is the cheaper of the two identical answers,
/// and it is the one that stays in linear light — resampling sRGB bytes would
/// darken every edge it touched, which on a two-ink reduction is a visible shift
/// in how much ink the frame carries.
///
/// **Area-averaged rather than bilinear.** A bilinear downscale reads two taps
/// per axis and steps over whatever lies between them, so a 2560-wide frame
/// coming down to 1920 would decide each output pixel from about half its input.
/// The dither's whole job is to distribute the tone it was given, so the tone it
/// is given has to be the tone of the area, not of a sample near the middle of
/// it.
fn resample(plane: &[f32], from: (u32, u32), to: (u32, u32)) -> Vec<f32> {
    let (sw, sh) = (from.0 as usize, from.1 as usize);
    let (dw, dh) = (to.0 as usize, to.1 as usize);

    // The common case by a wide margin: a candidate at or under the cap ships at
    // its own size, and copying beats resampling by an identity kernel.
    if (sw, sh) == (dw, dh) {
        return plane.to_vec();
    }

    // Nothing to average. Not reachable through a decoded image, and the
    // alternative to saying so is an out-of-range span in `taps`.
    if sw == 0 || sh == 0 {
        return vec![0.0; dw * dh];
    }

    let across = taps(sw, dw);
    let down = taps(sh, dh);

    // Separably, in two passes: one 2D pass would read every input pixel once
    // per output it touches on *both* axes, which is the product of what these
    // two cost rather than the sum.
    let mut rows = vec![0.0f32; dw * sh];
    for y in 0..sh {
        let row = &plane[y * sw..(y + 1) * sw];
        for (x, span) in across.iter().enumerate() {
            rows[y * dw + x] = span.iter().map(|(i, weight)| row[*i] * weight).sum();
        }
    }

    let mut out = vec![0.0f32; dw * dh];
    for (y, span) in down.iter().enumerate() {
        for x in 0..dw {
            out[y * dw + x] = span
                .iter()
                .map(|(j, weight)| rows[j * dw + x] * weight)
                .sum();
        }
    }

    out
}

/// Which input pixels each output pixel is made of, and in what proportion.
///
/// Output pixel `i` covers `[i·from/to, (i+1)·from/to)` of the input, so a pixel
/// the span swallows whole counts fully and the two it clips count for the
/// fraction actually covered. The weights are normalised rather than divided by
/// the span's width: the two differ only by floating-point drift, and drift here
/// is a row that comes out imperceptibly darker than the one above it.
fn taps(from: usize, to: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = from as f64 / to as f64;

    (0..to)
        .map(|i| {
            let start = i as f64 * scale;
            let end = start + scale;

            // An output pixel narrower than an input one still has to read one:
            // this only arises on an upscale, which the export cap never asks
            // for, and reading nothing would be a black row.
            let first = (start.floor() as usize).min(from.saturating_sub(1));
            let last = (end.ceil() as usize).clamp(first + 1, from);

            let mut span: Vec<(usize, f32)> = (first..last)
                .map(|j| {
                    let covered = (end.min((j + 1) as f64) - start.max(j as f64)).max(0.0);
                    (j, covered as f32)
                })
                .collect();

            let total: f32 = span.iter().map(|(_, weight)| weight).sum();
            if total > 0.0 {
                for tap in &mut span {
                    tap.1 /= total;
                }
            }

            span
        })
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

    /// One grid, for the tests with no opinion about the second — every export
    /// at `ExportSize::Web`, which is every export there was before #58.
    fn web(width: u32, height: u32) -> Grid {
        Grid {
            look: (width, height),
            shipped: (width, height),
        }
    }

    #[test]
    fn every_pixel_comes_back_as_one_of_the_inks() {
        // The defining property of a reduction: nothing between the inks
        // survives, however the error moved to get there.
        let out = render(
            &flat(128, 64, 64),
            &duotone(DiffusionKernel::Atkinson),
            web(64, 64),
        )
        .unwrap();
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
            web(128, 128),
        )
        .unwrap();
        let lit = out.pixels().filter(|p| p.0[0] > 0x80).count() as f32 / (128.0 * 128.0);

        assert!(lit > 0.05 && lit < 0.5, "{lit} of the field was paper");
    }

    #[test]
    fn a_solid_black_frame_does_not_speckle() {
        let out = render(
            &flat(0, 32, 32),
            &duotone(DiffusionKernel::Atkinson),
            web(32, 32),
        )
        .unwrap();
        assert!(out.pixels().all(|p| *p == image::Rgb([0x14, 0x11, 0x0F])));
    }

    #[test]
    fn the_frame_it_produces_is_the_one_that_was_asked_for() {
        // The bug this replaced: the output kept the *source's* size, so a
        // candidate wider than the export cap shipped a poster wider than every
        // other look would have produced, and nothing on screen said so.
        let out = render(
            &flat(200, 2560, 1440),
            &duotone(DiffusionKernel::Atkinson),
            web(1920, 1080),
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (1920, 1080));
    }

    #[test]
    fn a_frame_at_the_size_it_was_asked_for_is_left_alone() {
        // Below the cap nothing resamples, so the pattern is decided on the
        // pixels the model actually returned.
        let out = render(
            &flat(200, 37, 19),
            &duotone(DiffusionKernel::Atkinson),
            web(37, 19),
        )
        .unwrap();
        assert_eq!((out.width(), out.height()), (37, 19));
    }

    #[test]
    fn a_doubled_export_is_the_same_look_with_four_pixels_per_dot() {
        // #58's promise, on this path: 2× is the picture the preview showed
        // with harder edges, not a pattern twice as fine. So every look pixel
        // has to come out as a 2×2 block of one ink — which is also the whole
        // argument for diffusing at the look size and magnifying after.
        let out = render(
            &flat(128, 64, 36),
            &duotone(DiffusionKernel::FloydSteinberg),
            Grid {
                look: (64, 36),
                shipped: (128, 72),
            },
        )
        .unwrap();

        assert_eq!((out.width(), out.height()), (128, 72));
        for y in (0..72).step_by(2) {
            for x in (0..128).step_by(2) {
                let block = out.get_pixel(x, y);
                for (dx, dy) in [(1, 0), (0, 1), (1, 1)] {
                    assert_eq!(out.get_pixel(x + dx, y + dy), block, "at {x},{y}");
                }
            }
        }
    }

    #[test]
    fn a_magnified_frame_carries_only_the_inks_it_was_given() {
        // The reason this is nearest and not a filter: a second tap averages
        // two inks into a colour the reduction exists to have removed. A
        // fractional scale is the case a filter would be tempting for, so it is
        // the one asserted.
        let out = render(
            &flat(128, 96, 54),
            &duotone(DiffusionKernel::Atkinson),
            Grid {
                look: (96, 54),
                shipped: (128, 72),
            },
        )
        .unwrap();

        let ink = image::Rgb([0x14, 0x11, 0x0F]);
        let paper = image::Rgb([0xF4, 0xEF, 0xE6]);
        assert_eq!((out.width(), out.height()), (128, 72));
        assert!(out.pixels().all(|p| *p == ink || *p == paper));
    }

    #[test]
    fn magnifying_to_the_size_it_already_is_changes_nothing() {
        // `ExportSize::Web` is every export there was before #58, and it must
        // still be byte-for-byte the frame the dither decided.
        let decided = flat(0x20, 8, 5);
        assert_eq!(magnify(&decided, (8, 5)), decided);
    }

    #[test]
    fn resampling_holds_the_tone_it_was_handed() {
        // The property the dither depends on: the plane it distributes has to
        // carry the same light as the frame it came from, or a downscale would
        // silently change how much ink the picture ends up with.
        let plane: Vec<f32> = (0..(64 * 36)).map(|i| (i % 17) as f32 / 17.0).collect();
        let before = plane.iter().sum::<f32>() / plane.len() as f32;

        let after = resample(&plane, (64, 36), (48, 27));
        let mean = after.iter().sum::<f32>() / after.len() as f32;

        assert_eq!(after.len(), 48 * 27);
        assert!((mean - before).abs() < 0.01, "{mean} against {before}");
    }

    #[test]
    fn a_halving_averages_rather_than_samples() {
        // Two-into-one is the case a bilinear tap gets wrong by dropping half
        // its input; the mean of the four is the answer an area filter gives.
        let plane = vec![0.0, 1.0, 0.25, 0.75];
        assert_eq!(resample(&plane, (2, 2), (1, 1)), vec![0.5]);
    }

    #[test]
    fn the_spans_of_one_output_pixel_add_up_to_it() {
        // Weights that do not sum to one are a row imperceptibly darker than
        // the one above it, which on a diffused frame is a visible band.
        for (from, to) in [(2560usize, 1920usize), (1440, 1080), (7, 3), (3, 7)] {
            for span in taps(from, to) {
                let total: f32 = span.iter().map(|(_, weight)| weight).sum();
                assert!((total - 1.0).abs() < 1e-5, "{from}→{to} summed to {total}");
                assert!(span.iter().all(|(i, _)| *i < from));
            }
        }
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
            render(&flat(128, 8, 8), &broken, web(8, 8)),
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
            render(&flat(128, 8, 8), &one, web(8, 8)),
            Err(EffectError::UnusableInks)
        ));
    }

    #[test]
    fn the_png_it_writes_is_one_that_reads_back_at_the_size_asked_for() {
        let png = render_png(
            &encode_png(&flat(128, 48, 24)),
            &duotone(DiffusionKernel::Atkinson),
            web(24, 12),
        )
        .unwrap();

        let back = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((back.width(), back.height()), (24, 12));
    }

    #[test]
    fn bytes_that_are_not_a_picture_are_named_rather_than_panicking() {
        assert!(matches!(
            render_png(
                b"not a picture",
                &duotone(DiffusionKernel::Atkinson),
                web(8, 8)
            ),
            Err(EffectError::Undecodable { .. })
        ));
    }

    fn encode_png(image: &image::RgbImage) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }
}
