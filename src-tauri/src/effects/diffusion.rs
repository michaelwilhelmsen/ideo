//! Error diffusion — the two kernels no fragment shader can run.
//!
//! Floyd–Steinberg and Atkinson decide each pixel from pixels already decided,
//! which is a data dependency a fragment shader has no way to express. Every
//! other effect in #36 is a shader; these two come here.
//!
//! **Serial, and deliberately so.** #52 built an exact parallelisation of this
//! — pipelined rows, byte-identical output, asserted as an equality — and
//! measured it at **465 ms against 81 ms serial** on a ten-core M1 Max at
//! 2560×1440. The row lead is two columns, so threads mostly spin, every
//! accumulation goes through an atomic that defeats vectorisation, and adjacent
//! rows fight over cache lines. That result is why there is no thread pool in
//! this file, and the reason is written down here so it is not rediscovered as
//! an optimisation opportunity.
//!
//! The stencils are the canonical published ones, reproduced rather than pulled
//! from a crate.

/// Which diffusion. The ordered screens live in the shaders, not here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffusionKernel {
    FloydSteinberg,
    Atkinson,
}

impl DiffusionKernel {
    /// The stencil as `(dx, dy, weight)`.
    fn stencil(self) -> &'static [(i32, i32, f32)] {
        match self {
            DiffusionKernel::FloydSteinberg => FLOYD_STEINBERG,
            DiffusionKernel::Atkinson => ATKINSON,
        }
    }
}

/// `X 7/16 · 3/16 5/16 1/16` — all 16/16 of the error is passed on.
const FLOYD_STEINBERG: &[(i32, i32, f32)] = &[
    (1, 0, 7.0 / 16.0),
    (-1, 1, 3.0 / 16.0),
    (0, 1, 5.0 / 16.0),
    (1, 1, 1.0 / 16.0),
];

/// Six eighths of the error, the missing quarter dropped on purpose — which is
/// why Atkinson holds cleaner highlights and blows out sooner.
const ATKINSON: &[(i32, i32, f32)] = &[
    (1, 0, 1.0 / 8.0),
    (2, 0, 1.0 / 8.0),
    (-1, 1, 1.0 / 8.0),
    (0, 1, 1.0 / 8.0),
    (1, 1, 1.0 / 8.0),
    (0, 2, 1.0 / 8.0),
];

/// Diffuse `src` in raster order, emitting one level index per pixel.
///
/// `quantise` maps an error-corrected value to `(index, emitted)` — the index
/// the caller wants and the value the error is measured against. What is being
/// quantised is entirely the caller's business, which is the seam that lets one
/// loop serve both a two-ink duotone and an N-entry palette reduction.
pub fn diffuse<F>(
    src: &[f32],
    width: u32,
    height: u32,
    kernel: DiffusionKernel,
    quantise: F,
) -> Vec<usize>
where
    F: Fn(f32) -> (usize, f32),
{
    let (w, h) = (width as usize, height as usize);
    debug_assert_eq!(src.len(), w * h);

    let stencil = kernel.stencil();
    // Two accumulators rather than one, in the decomposition #52 settled on:
    // `carry` holds everything arriving from the rows above and `own` holds the
    // current row's forward taps. Floating-point addition is not associative,
    // so keeping the two apart is what makes this loop's result the one the
    // spike's tests pinned.
    let mut carry = vec![0.0f32; src.len()];
    let mut own = vec![0.0f32; w];
    let mut out = vec![0usize; src.len()];

    for y in 0..h {
        own.iter_mut().for_each(|v| *v = 0.0);
        for x in 0..w {
            let i = y * w + x;
            let value = src[i] + carry[i] + own[x];
            let (index, emitted) = quantise(value);
            out[i] = index;

            let err = value - emitted;
            if err == 0.0 {
                continue;
            }

            for (dx, dy, weight) in stencil {
                let nx = x as i64 + *dx as i64;
                let ny = y as i64 + *dy as i64;
                // Error leaves the frame at the edges rather than wrapping — a
                // wrapped tap smears the right edge's error onto the left,
                // which is a bright or dark seam down one side of every export.
                if nx < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let d = err * weight;
                if *dy == 0 {
                    own[nx as usize] += d;
                } else {
                    carry[ny as usize * w + nx as usize] += d;
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_two_levels(v: f32) -> (usize, f32) {
        if v > 0.5 {
            (1, 1.0)
        } else {
            (0, 0.0)
        }
    }

    #[test]
    fn floyd_steinberg_passes_on_all_of_the_error() {
        let total: f32 = FLOYD_STEINBERG.iter().map(|(_, _, w)| w).sum();
        assert!((total - 1.0).abs() < 1e-6, "{total}");
    }

    #[test]
    fn atkinson_deliberately_drops_a_quarter() {
        let total: f32 = ATKINSON.iter().map(|(_, _, w)| w).sum();
        assert!((total - 0.75).abs() < 1e-6, "{total}");
    }

    #[test]
    fn a_flat_half_grey_field_dithers_to_about_half_coverage() {
        // Error diffusion's defining property: the mean survives quantisation.
        // Atkinson drops a quarter of the error, so it is checked more loosely.
        for (kernel, tolerance) in [
            (DiffusionKernel::FloydSteinberg, 0.02),
            (DiffusionKernel::Atkinson, 0.10),
        ] {
            let (w, h) = (128u32, 128u32);
            let src = vec![0.5f32; (w * h) as usize];
            let out = diffuse(&src, w, h, kernel, to_two_levels);
            let lit = out.iter().filter(|v| **v == 1).count() as f32 / out.len() as f32;
            assert!((lit - 0.5).abs() < tolerance, "{kernel:?} lit {lit}");
        }
    }

    #[test]
    fn error_leaves_the_frame_at_the_edges_rather_than_wrapping() {
        let (w, h) = (16u32, 16u32);
        let mut src = vec![0.0f32; (w * h) as usize];
        src[(w - 1) as usize] = 0.9;
        let out = diffuse(&src, w, h, DiffusionKernel::FloydSteinberg, to_two_levels);
        assert_eq!(
            out[w as usize], 0,
            "error wrapped onto the next row's first pixel"
        );
    }

    #[test]
    fn a_flat_black_field_stays_black_and_a_white_one_stays_white() {
        // Nothing to distribute means nothing distributed: a dither that
        // speckles a solid area is the failure everyone notices first.
        let (w, h) = (32u32, 32u32);
        for (level, expected) in [(0.0f32, 0usize), (1.0, 1)] {
            let src = vec![level; (w * h) as usize];
            let out = diffuse(&src, w, h, DiffusionKernel::Atkinson, to_two_levels);
            assert!(out.iter().all(|v| *v == expected), "{level} speckled");
        }
    }

    #[test]
    fn a_single_row_and_a_single_column_both_work() {
        for (w, h) in [(64u32, 1u32), (1, 64)] {
            let src: Vec<f32> = (0..(w * h)).map(|i| (i % 7) as f32 / 7.0).collect();
            let out = diffuse(&src, w, h, DiffusionKernel::Atkinson, to_two_levels);
            assert_eq!(out.len(), (w * h) as usize);
        }
    }
}
