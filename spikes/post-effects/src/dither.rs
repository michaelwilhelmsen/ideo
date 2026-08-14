//! Threshold matrices and error-diffusion coefficients.
//!
//! The constants are the canonical published ones (Wikipedia "Ordered
//! dithering", "Floyd–Steinberg dithering", "Atkinson dithering"), reproduced
//! rather than pulled from a crate, per #36's "write the kernels" finding.
//!
//! Nothing here decides *what* is being thresholded — that is the whole
//! argument, and it lives in `orders.rs`.

/// The kernels the A/B and the benchmark share.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
    Bayer4,
    Bayer8,
    /// A clustered-dot 8×8 screen — the halftone-ish member of the ordered
    /// family, included because two shipped recipes ask for a screen rather
    /// than a diffusion.
    Clustered8,
    FloydSteinberg,
    Atkinson,
}

impl Kernel {
    pub fn name(self) -> &'static str {
        match self {
            Kernel::Bayer4 => "bayer4",
            Kernel::Bayer8 => "bayer8",
            Kernel::Clustered8 => "clustered8",
            Kernel::FloydSteinberg => "floyd-steinberg",
            Kernel::Atkinson => "atkinson",
        }
    }

    /// Whether output pixels depend on already-decided output pixels.
    ///
    /// This is the property that decides the preview architecture, so it is a
    /// method rather than a comment: the parallel benchmark branches on it.
    pub fn is_sequential(self) -> bool {
        matches!(self, Kernel::FloydSteinberg | Kernel::Atkinson)
    }

    /// The diffusion stencil as `(dx, dy, weight)`, for the sequential kernels.
    pub fn stencil(self) -> &'static [(i32, i32, f32)] {
        match self {
            Kernel::FloydSteinberg => FLOYD_STEINBERG,
            Kernel::Atkinson => ATKINSON,
            _ => &[],
        }
    }

    /// How many columns ahead the previous row must be before this row's next
    /// pixel is safe to compute.
    ///
    /// Read straight off the stencil: the largest `dx` written into a lower
    /// row, plus one. This is what makes the pipelined parallel scheme in
    /// [`crate::diffusion`] exact rather than approximate.
    pub fn row_lead(self) -> u32 {
        self.stencil()
            .iter()
            .filter(|(_, dy, _)| *dy > 0)
            .map(|(dx, _, _)| *dx)
            .max()
            .map(|dx| (dx.max(0) as u32) + 1)
            .unwrap_or(0)
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

const BAYER_4: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

const BAYER_8: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// An 8×8 clustered-dot screen: thresholds spiral outward from two centres, so
/// set pixels clump into growing dots instead of scattering.
const CLUSTERED_8: [[u8; 8]; 8] = [
    [24, 10, 12, 26, 35, 47, 49, 37],
    [8, 0, 2, 14, 45, 59, 61, 51],
    [22, 6, 4, 16, 43, 57, 63, 53],
    [30, 20, 18, 28, 33, 41, 55, 39],
    [34, 46, 48, 36, 25, 11, 13, 27],
    [44, 58, 60, 50, 9, 1, 3, 15],
    [42, 56, 62, 52, 23, 7, 5, 17],
    [32, 40, 54, 38, 31, 21, 19, 29],
];

/// A signed jitter in `-0.5..0.5` for the pixel at `(x, y)`.
///
/// Signed and centred so that adding it to a value leaves the *mean* of a flat
/// region untouched — an uncentred threshold would lighten or darken every flat
/// area, which on the flat-graphic source would be mistaken for an ordering
/// effect.
pub fn ordered_bias(kernel: Kernel, x: u32, y: u32) -> f32 {
    match kernel {
        Kernel::Bayer4 => cell(BAYER_4[(y % 4) as usize][(x % 4) as usize] as f32, 16.0),
        Kernel::Bayer8 => cell(BAYER_8[(y % 8) as usize][(x % 8) as usize] as f32, 64.0),
        Kernel::Clustered8 => cell(CLUSTERED_8[(y % 8) as usize][(x % 8) as usize] as f32, 64.0),
        _ => 0.0,
    }
}

fn cell(v: f32, n: f32) -> f32 {
    (v + 0.5) / n - 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn every_ordered_matrix_is_a_permutation_of_its_range() {
        let b4: Vec<u8> = BAYER_4.iter().flatten().copied().collect();
        let b8: Vec<u8> = BAYER_8.iter().flatten().copied().collect();
        let c8: Vec<u8> = CLUSTERED_8.iter().flatten().copied().collect();
        for (name, m, n) in [
            ("bayer4", b4, 16u8),
            ("bayer8", b8, 64),
            ("clustered8", c8, 64),
        ] {
            let mut sorted = m.clone();
            sorted.sort_unstable();
            let expected: Vec<u8> = (0..n).collect();
            assert_eq!(sorted, expected, "{name} is not a permutation of 0..{n}");
        }
    }

    #[test]
    fn ordered_bias_is_centred_on_zero_over_one_tile() {
        for kernel in [Kernel::Bayer4, Kernel::Bayer8, Kernel::Clustered8] {
            let n = 8u32;
            let sum: f32 = (0..n)
                .flat_map(|y| (0..n).map(move |x| (x, y)))
                .map(|(x, y)| ordered_bias(kernel, x, y))
                .sum();
            assert!(sum.abs() < 1e-4, "{} sums to {sum}", kernel.name());
        }
    }

    #[test]
    fn ordered_bias_stays_inside_half_a_step() {
        for kernel in [Kernel::Bayer4, Kernel::Bayer8, Kernel::Clustered8] {
            for y in 0..8 {
                for x in 0..8 {
                    let b = ordered_bias(kernel, x, y);
                    assert!(b > -0.5 && b < 0.5, "{} gave {b}", kernel.name());
                }
            }
        }
    }

    #[test]
    fn the_row_lead_matches_each_stencil() {
        // Floyd–Steinberg reaches one column right on the row below, Atkinson
        // also one (its `(2, 0)` tap stays on the current row). Both therefore
        // need the previous row two columns ahead.
        assert_eq!(Kernel::FloydSteinberg.row_lead(), 2);
        assert_eq!(Kernel::Atkinson.row_lead(), 2);
        assert_eq!(Kernel::Bayer4.row_lead(), 0);
    }

    #[test]
    fn only_the_diffusion_kernels_are_sequential() {
        assert!(Kernel::FloydSteinberg.is_sequential());
        assert!(Kernel::Atkinson.is_sequential());
        for k in [Kernel::Bayer4, Kernel::Bayer8, Kernel::Clustered8] {
            assert!(!k.is_sequential(), "{}", k.name());
        }
    }
}
