//! The rest of #52's benchmark list: everything that is not a dither.
//!
//! All of these are pointwise or small-neighbourhood and therefore
//! embarrassingly parallel, which is the point — they are here to establish
//! what the *cheap* half of the effect set costs, so the error-diffusion
//! numbers have something to be expensive relative to.
//!
//! These are benchmark-grade, not production-grade. They do the arithmetic a
//! real kernel would do, on the same buffers, in the same working space, so the
//! throughput is honest — but none of them has the parameters #36 will want.

use rayon::prelude::*;

use crate::color::{luminance, LinearImage};
use crate::palette::Palette;

/// Nearest-entry palette quantisation with no dither at all.
///
/// The baseline the dithered variants are measured against: same lookup, none
/// of the error bookkeeping.
pub fn quantise(img: &LinearImage, pal: &Palette, parallel: bool) -> LinearImage {
    let f = |c: &[f32; 3]| pal.entries()[pal.nearest(*c)];
    let px = if parallel {
        img.px.par_iter().map(f).collect()
    } else {
        img.px.iter().map(f).collect()
    };
    LinearImage::new(img.width, img.height, px)
}

/// Per-channel posterisation to `levels` steps, in linear light.
pub fn posterise(img: &LinearImage, levels: u32, parallel: bool) -> LinearImage {
    let n = (levels.max(2) - 1) as f32;
    let f = |c: &[f32; 3]| -> [f32; 3] { std::array::from_fn(|i| (c[i] * n).round() / n) };
    let px = if parallel {
        img.px.par_iter().map(f).collect()
    } else {
        img.px.iter().map(f).collect()
    };
    LinearImage::new(img.width, img.height, px)
}

/// Mosaic: each `cell`×`cell` block becomes its own linear-light mean.
///
/// Two passes — reduce to a block grid, then expand — rather than averaging a
/// block afresh for each of its pixels. The one-pass version is `O(cell²)` per
/// pixel and was measurably the slowest kernel in the whole set at `cell = 8`,
/// which would have been reported as a fact about pixelation rather than about
/// how it had been written.
pub fn pixelate(img: &LinearImage, cell: u32, parallel: bool) -> LinearImage {
    let (w, h) = (img.width, img.height);
    let (cols, rows) = (w.div_ceil(cell), h.div_ceil(cell));

    let block_row = |cy: u32| -> Vec<[f32; 3]> {
        let (y0, y1) = (cy * cell, ((cy + 1) * cell).min(h));
        (0..cols)
            .map(|cx| {
                let (x0, x1) = (cx * cell, ((cx + 1) * cell).min(w));
                let mut acc = [0.0f32; 3];
                let mut n = 0.0f32;
                for sy in y0..y1 {
                    let base = (sy * w) as usize;
                    for s in &img.px[base + x0 as usize..base + x1 as usize] {
                        acc[0] += s[0];
                        acc[1] += s[1];
                        acc[2] += s[2];
                        n += 1.0;
                    }
                }
                [acc[0] / n, acc[1] / n, acc[2] / n]
            })
            .collect()
    };
    let blocks: Vec<[f32; 3]> = if parallel {
        (0..rows).into_par_iter().flat_map_iter(block_row).collect()
    } else {
        (0..rows).flat_map(block_row).collect()
    };

    let expand = |y: u32| -> Vec<[f32; 3]> {
        let base = ((y / cell) * cols) as usize;
        (0..w).map(|x| blocks[base + (x / cell) as usize]).collect()
    };
    let px: Vec<[f32; 3]> = if parallel {
        (0..h).into_par_iter().flat_map_iter(expand).collect()
    } else {
        (0..h).flat_map(expand).collect()
    };
    LinearImage::new(w, h, px)
}

/// Film grain whose density falls off with luminance, seeded per frame.
///
/// The noise is a hash of `(x, y, seed)` rather than a running RNG, because
/// #36 requires video patterns to be frame-stable: a hash lets frame `n` be
/// reproduced from its coordinates alone, and lets the seed be held constant or
/// advanced deliberately rather than by accident.
pub fn grain(img: &LinearImage, amount: f32, seed: u32, parallel: bool) -> LinearImage {
    let w = img.width;
    let f = |(i, c): (usize, &[f32; 3])| -> [f32; 3] {
        let (x, y) = (i as u32 % w, i as u32 / w);
        let n = hash_noise(x, y, seed);
        // Densest in the midtones, fading toward both ends — real film grain
        // is not visible in a blown highlight or a crushed black.
        let l = luminance(*c);
        let density = (4.0 * l * (1.0 - l)).clamp(0.0, 1.0);
        let d = n * amount * density;
        [
            (c[0] + d).clamp(0.0, 1.0),
            (c[1] + d).clamp(0.0, 1.0),
            (c[2] + d).clamp(0.0, 1.0),
        ]
    };
    let px = if parallel {
        img.px.par_iter().enumerate().map(f).collect()
    } else {
        img.px.iter().enumerate().map(f).collect()
    };
    LinearImage::new(img.width, img.height, px)
}

/// A signed value in roughly `-0.5..0.5`, deterministic in `(x, y, seed)`.
#[inline]
fn hash_noise(x: u32, y: u32, seed: u32) -> f32 {
    let mut h =
        x.wrapping_mul(0x27d4_eb2d) ^ y.wrapping_mul(0x1656_67b1) ^ seed.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2545_f491);
    h ^= h >> 13;
    (h as f32 / u32::MAX as f32) - 0.5
}

/// Luminance-to-glyph mapping at cell resolution.
///
/// This measures the *mapping*, which is the part that scales with pixel count:
/// average each cell's linear luminance and pick a glyph from a ramp. Compositing
/// a glyph atlas back out is a fixed cost per cell and belongs to #36, not here.
pub fn ascii_map(img: &LinearImage, cell: u32, parallel: bool) -> Vec<u8> {
    const RAMP: &[u8] = b" .:-=+*#%@";
    let (w, h) = (img.width, img.height);
    let (cols, rows) = (w.div_ceil(cell), h.div_ceil(cell));
    let row = |cy: u32| -> Vec<u8> {
        (0..cols)
            .map(|cx| {
                let (x0, y0) = (cx * cell, cy * cell);
                let (x1, y1) = ((x0 + cell).min(w), (y0 + cell).min(h));
                let mut acc = 0.0f32;
                let mut n = 0.0f32;
                for y in y0..y1 {
                    for x in x0..x1 {
                        acc += luminance(img.px[(y * w + x) as usize]);
                        n += 1.0;
                    }
                }
                let l = (acc / n).clamp(0.0, 1.0);
                RAMP[((l * (RAMP.len() - 1) as f32).round() as usize).min(RAMP.len() - 1)]
            })
            .collect()
    };
    if parallel {
        (0..rows).into_par_iter().flat_map_iter(row).collect()
    } else {
        (0..rows).flat_map(row).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: u32, h: u32, v: f32) -> LinearImage {
        LinearImage::new(w, h, vec![[v; 3]; (w * h) as usize])
    }

    #[test]
    fn posterise_keeps_the_endpoints() {
        let img = LinearImage::new(2, 1, vec![[0.0; 3], [1.0; 3]]);
        let out = posterise(&img, 4, false);
        assert_eq!(out.px[0], [0.0; 3]);
        assert_eq!(out.px[1], [1.0; 3]);
    }

    #[test]
    fn posterise_lands_only_on_its_levels() {
        let img = LinearImage::new(5, 1, (0..5).map(|i| [i as f32 / 4.0; 3]).collect());
        let out = posterise(&img, 3, false);
        for p in &out.px {
            assert!(
                [0.0f32, 0.5, 1.0].iter().any(|l| (l - p[0]).abs() < 1e-6),
                "{p:?}"
            );
        }
    }

    #[test]
    fn pixelate_averages_within_a_block_and_not_across_one() {
        let img = LinearImage::new(4, 1, vec![[0.0; 3], [1.0; 3], [0.0; 3], [0.0; 3]]);
        let out = pixelate(&img, 2, false);
        assert!((out.px[0][0] - 0.5).abs() < 1e-6);
        assert!((out.px[1][0] - 0.5).abs() < 1e-6);
        assert!((out.px[2][0] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn grain_is_frame_stable_for_a_fixed_seed_and_moves_for_a_new_one() {
        // The property #36 needs on video: same seed, same picture, so a
        // stationary shot does not crawl.
        let img = flat(32, 32, 0.5);
        let a = grain(&img, 0.2, 7, false);
        let b = grain(&img, 0.2, 7, false);
        let c = grain(&img, 0.2, 8, false);
        assert_eq!(a.px, b.px);
        assert_ne!(a.px, c.px);
    }

    #[test]
    fn grain_leaves_blown_highlights_and_crushed_blacks_alone() {
        let white = grain(&flat(16, 16, 1.0), 0.5, 1, false);
        let black = grain(&flat(16, 16, 0.0), 0.5, 1, false);
        assert!(white.px.iter().all(|p| (p[0] - 1.0).abs() < 1e-6));
        assert!(black.px.iter().all(|p| p[0].abs() < 1e-6));
    }

    #[test]
    fn ascii_maps_dark_to_space_and_light_to_the_densest_glyph() {
        assert_eq!(ascii_map(&flat(8, 8, 0.0), 4, false), b"    ");
        assert_eq!(ascii_map(&flat(8, 8, 1.0), 4, false), b"@@@@");
    }

    #[test]
    fn ascii_covers_a_partial_trailing_cell() {
        // A 10px width at cell 4 is three columns, the last one two wide.
        let out = ascii_map(&flat(10, 4, 1.0), 4, false);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn the_parallel_paths_agree_with_the_serial_ones() {
        let img = LinearImage::new(
            64,
            64,
            (0..64 * 64)
                .map(|i| [(i % 97) as f32 / 97.0, (i % 61) as f32 / 61.0, 0.4])
                .collect(),
        );
        let pal = Palette::ramp("p", "#14110F", "#D9662C", 4);
        assert_eq!(
            quantise(&img, &pal, false).px,
            quantise(&img, &pal, true).px
        );
        assert_eq!(posterise(&img, 6, false).px, posterise(&img, 6, true).px);
        assert_eq!(pixelate(&img, 8, false).px, pixelate(&img, 8, true).px);
        assert_eq!(grain(&img, 0.2, 3, false).px, grain(&img, 0.2, 3, true).px);
        assert_eq!(ascii_map(&img, 8, false), ascii_map(&img, 8, true));
    }
}
