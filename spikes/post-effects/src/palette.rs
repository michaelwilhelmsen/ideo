//! The N entries a reduction targets, and the two ways of building them.
//!
//! #52 asks for 2, 3 and 4 entries because "2-entry *may* converge mathematically
//! while ≥3 clearly does not". But *which* three colours matters as much as the
//! count, and the research names the case it expects to fail:
//!
//! > a 2-entry RGB palette which is not luminance-ordered yields incoherent
//! > per-channel noise
//!
//! So there are two constructions here, and the A/B runs both:
//!
//! - [`Palette::ramp`] — a luminance-ordered interpolation between the two inks.
//!   This is the generous reading of the shipped `note`: a duotone with more
//!   levels, still monotonic in lightness.
//! - [`Palette::brand`] — actual roles off one of `palettes.json`'s entries,
//!   which are **not** luminance-ordered (Studio's `secondary` #1F4E79 and
//!   `primary` #D9662C sit close in lightness and far apart in hue).
//!
//! If the two orders differ at all, they should differ most on `brand`.

use crate::color::{luminance, srgb_to_linear};

/// A fixed set of output colours, held in linear light and sorted by luminance.
///
/// Sorted at construction because order B's whole shape is *index → colour*,
/// and an unsorted LUT would map a dithered luminance mask onto colours in an
/// arbitrary order — which is a bug, not a variant worth measuring.
#[derive(Clone, Debug)]
pub struct Palette {
    entries: Vec<[f32; 3]>,
    label: String,
}

impl Palette {
    pub fn from_hex(label: &str, hexes: &[&str]) -> Self {
        let mut entries: Vec<[f32; 3]> = hexes.iter().map(|h| linear_from_hex(h)).collect();
        entries.sort_by(|a, b| luminance(*a).total_cmp(&luminance(*b)));
        Self {
            entries,
            label: label.to_string(),
        }
    }

    /// `n` steps interpolated between two inks, **in linear light**.
    ///
    /// Interpolating the encoded bytes instead would put the intermediate steps
    /// in the wrong place — the same mistake as dithering encoded values, one
    /// stage earlier — and the midtones are exactly where the two orders are
    /// expected to disagree.
    pub fn ramp(label: &str, dark_hex: &str, light_hex: &str, n: usize) -> Self {
        assert!(n >= 2);
        let a = linear_from_hex(dark_hex);
        let b = linear_from_hex(light_hex);
        let entries = (0..n)
            .map(|i| {
                let t = i as f32 / (n - 1) as f32;
                [
                    a[0] + (b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t,
                ]
            })
            .collect();
        Self {
            entries,
            label: label.to_string(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn entries(&self) -> &[[f32; 3]] {
        &self.entries
    }

    /// The entry closest to `c` by squared distance in linear RGB.
    ///
    /// This is order A's quantiser: it answers "which ink is this colour",
    /// which is a different question from "how light is this pixel", and the
    /// gap between those two questions is what the A/B is measuring.
    pub fn nearest(&self, c: [f32; 3]) -> usize {
        let mut best = 0usize;
        let mut best_d = f32::INFINITY;
        for (i, e) in self.entries.iter().enumerate() {
            let d = (c[0] - e[0]).powi(2) + (c[1] - e[1]).powi(2) + (c[2] - e[2]).powi(2);
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        best
    }

    /// How far apart the entries are, as a single number.
    ///
    /// Ordered dithering needs an amplitude to jitter by. Palette entries are
    /// not evenly spaced in RGB, so there is no exact answer; the mean gap
    /// between adjacent luminances is used, and the same number is used for
    /// both orders so it cannot bias the comparison.
    pub fn mean_step(&self) -> f32 {
        if self.entries.len() < 2 {
            return 0.0;
        }
        let lo = luminance(self.entries[0]);
        let hi = luminance(self.entries[self.entries.len() - 1]);
        (hi - lo) / (self.entries.len() - 1) as f32
    }

    /// How far the furthest entry sits off the straight line joining the
    /// darkest and lightest entries, in linear RGB.
    ///
    /// This — not the luminance spacing — is the axis the A/B turns on. A
    /// [`Palette::ramp`] is that line by construction, so "nearest entry in
    /// RGB" and "nearest entry in luminance" pick the same colour and the two
    /// orders have little room to disagree. A palette whose middle entries
    /// swing away from the line (Studio's navy `secondary` against its orange
    /// `primary`) breaks that agreement, which is the case the research
    /// predicts quantise-first handles badly.
    pub fn off_ramp_distance(&self) -> f32 {
        if self.entries.len() < 3 {
            return 0.0;
        }
        let a = self.entries[0];
        let b = self.entries[self.entries.len() - 1];
        let axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let axis_len2 = axis.iter().map(|v| v * v).sum::<f32>().max(1e-9);
        self.entries[1..self.entries.len() - 1]
            .iter()
            .map(|e| {
                let d = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
                let t = (0..3).map(|i| d[i] * axis[i]).sum::<f32>() / axis_len2;
                (0..3)
                    .map(|i| (d[i] - t * axis[i]).powi(2))
                    .sum::<f32>()
                    .sqrt()
            })
            .fold(0.0f32, f32::max)
    }
}

fn linear_from_hex(hex: &str) -> [f32; 3] {
    let h = hex.trim_start_matches('#');
    assert_eq!(h.len(), 6, "expected #RRGGBB, got {hex}");
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).expect("hex digits");
    [
        srgb_to_linear(byte(0)),
        srgb_to_linear(byte(2)),
        srgb_to_linear(byte(4)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_parses_to_linear_light() {
        let white = linear_from_hex("#FFFFFF");
        assert!((luminance(white) - 1.0).abs() < 1e-5);
        assert_eq!(linear_from_hex("#000000"), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_ramp_is_monotonic_in_luminance() {
        let p = Palette::ramp("studio", "#14110F", "#D9662C", 4);
        assert_eq!(p.len(), 4);
        let l: Vec<f32> = p.entries().iter().map(|e| luminance(*e)).collect();
        assert!(l.windows(2).all(|w| w[1] > w[0]), "{l:?}");
    }

    #[test]
    fn a_ramp_keeps_its_two_endpoints_exactly() {
        let p = Palette::ramp("studio", "#14110F", "#D9662C", 3);
        assert_eq!(p.entries()[0], linear_from_hex("#14110F"));
        assert_eq!(p.entries()[2], linear_from_hex("#D9662C"));
    }

    #[test]
    fn entries_are_sorted_by_luminance_however_they_arrive() {
        let p = Palette::from_hex("scrambled", &["#F4EFE6", "#14110F", "#D9662C"]);
        let l: Vec<f32> = p.entries().iter().map(|e| luminance(*e)).collect();
        assert!(l.windows(2).all(|w| w[1] > w[0]), "{l:?}");
    }

    #[test]
    fn a_ramp_has_nothing_off_its_own_line() {
        let p = Palette::ramp("studio", "#14110F", "#D9662C", 4);
        assert!(p.off_ramp_distance() < 1e-5, "{}", p.off_ramp_distance());
    }

    #[test]
    fn the_studio_brand_palette_is_the_awkward_one() {
        // The case the research predicts breaks quantise-first: entries that a
        // luminance-ordered LUT has to put in a line, but that sit well off it
        // in colour. Measured against the ramp between the same two endpoints,
        // so the comparison is like for like.
        let brand = Palette::from_hex(
            "studio-brand",
            &["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"],
        );
        let ramp = Palette::ramp("studio-ramp", "#14110F", "#F4EFE6", 4);
        assert!(
            brand.off_ramp_distance() > 0.05,
            "brand sits only {} off its own line",
            brand.off_ramp_distance()
        );
        assert!(brand.off_ramp_distance() > ramp.off_ramp_distance() * 10.0);
    }

    #[test]
    fn nearest_picks_by_colour_and_not_by_lightness() {
        // A saturated blue is nearer Studio's navy than its paper, even though
        // paper is the closer of the two in luminance terms for a bright blue.
        let p = Palette::from_hex("studio", &["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"]);
        let blue = linear_from_hex("#2B4CE0");
        assert_eq!(p.entries()[p.nearest(blue)], linear_from_hex("#1F4E79"));
    }

    #[test]
    fn mean_step_spans_the_palette() {
        let p = Palette::ramp("r", "#000000", "#FFFFFF", 3);
        assert!((p.mean_step() - 0.5).abs() < 1e-4);
    }
}
