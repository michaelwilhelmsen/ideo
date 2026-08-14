//! The two candidate duotone pipelines, behind one flag.
//!
//! Everything either side of this module is shared — same decode, same working
//! space, same palette, same kernel constants, same ordered-dither amplitude.
//! The *only* thing that varies between the two arms is what gets thresholded
//! and when the colour is chosen.
//!
//! ## [`Order::QuantiseThenDither`] — what the shipped `note` says
//!
//! > Quantise to a two-entry palette THEN apply Atkinson or Floyd-Steinberg.
//! > Dithering a grey image and tinting it afterwards produces mud, not the
//! > reduction this recipe is built for.
//!
//! Read literally, that makes the palette the quantisation target and the
//! dither the thing that hides the quantisation error: for each pixel, pick the
//! nearest palette entry **in colour space**, and diffuse the leftover
//! **per-channel RGB** error. The image keeps its hue information right up to
//! the moment a colour is chosen.
//!
//! ## [`Order::DitherThenColourise`] — what the research reasons toward
//!
//! Both dither families threshold a *luminance*, so reduce the source to linear
//! luminance, dither that scalar to an N-level mask, and map mask index to
//! colour as a pure LUT at the very end. Colour never participates in the
//! decision.
//!
//! ## [`Order::DitherThenColouriseLumaMatched`] — a third arm, added deliberately
//!
//! **This is not one of the two orders #52 asked for**, and it is here because
//! without it the comparison is unfair in a way that would contaminate the
//! verdict.
//!
//! Order B as the research sketches it thresholds source luminance against an
//! abstract `0..1` scale, so the mask has no idea how light the inks actually
//! are. Studio's `primary` is a mid-luminance orange (Y ≈ 0.25) and its `paper`
//! is Y ≈ 0.88 — nothing like evenly spaced. The measured consequence is that
//! order B loses more than half the image's mean luminance on a four-ink brand
//! palette while order A holds it almost exactly. Handed back as-is, the
//! pictures would show order B looking crushed, and a reader would attribute
//! that to *colourising last* when it is really caused by *assuming the inks
//! are evenly spaced*.
//!
//! This arm isolates that: identical to order B in every respect except that
//! the mask's levels are spaced like the palette's own luminances rather than
//! evenly. It still colourises last, and colour still never enters the
//! threshold decision. At N = 2 there is no interior level to place, so C is
//! the same picture as B — it only says something at N ≥ 3.
//!
//! ## Why they disagree
//!
//! "Nearest in RGB" and "nearest in luminance" are different questions, and
//! they disagree more as the palette grows and as its entries swing further off
//! the line between its two endpoints.
//!
//! #36 guessed the two "may converge mathematically" at N = 2. Measured, they
//! do not: see [`tests::the_orders_diverge_at_every_palette_size`].

use crate::color::{luminance, LinearImage};
use crate::diffusion::{diffuse_pipelined, diffuse_serial};
use crate::dither::{ordered_bias, Kernel};
use crate::palette::Palette;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    /// Quantise against the colour palette; the dither carries RGB error.
    QuantiseThenDither,
    /// Dither luminance to an index against an even `0..1` scale; colourise last.
    DitherThenColourise,
    /// As above, but the mask's levels are the palette's own luminances.
    DitherThenColouriseLumaMatched,
}

pub const ALL_ORDERS: &[Order] = &[
    Order::QuantiseThenDither,
    Order::DitherThenColourise,
    Order::DitherThenColouriseLumaMatched,
];

impl Order {
    pub fn name(self) -> &'static str {
        match self {
            Order::QuantiseThenDither => "quantise-then-dither",
            Order::DitherThenColourise => "dither-then-colourise",
            Order::DitherThenColouriseLumaMatched => "dither-then-colourise (luma-matched)",
        }
    }

    /// The short label used in filenames, so a contact sheet is self-describing
    /// once it has been dragged out of its folder.
    pub fn slug(self) -> &'static str {
        match self {
            Order::QuantiseThenDither => "A-quantise-first",
            Order::DitherThenColourise => "B-colourise-last",
            Order::DitherThenColouriseLumaMatched => "C-colourise-last-luma-matched",
        }
    }
}

pub fn apply(
    img: &LinearImage,
    pal: &Palette,
    kernel: Kernel,
    order: Order,
    parallel: bool,
) -> LinearImage {
    let px = match (order, kernel.is_sequential()) {
        (Order::QuantiseThenDither, false) => quantise_ordered(img, pal, kernel),
        (Order::QuantiseThenDither, true) => quantise_diffused(img, pal, kernel, parallel),
        (Order::DitherThenColourise, false) => colourise_ordered(img, pal, kernel, Levels::Even),
        (Order::DitherThenColourise, true) => {
            colourise_diffused(img, pal, kernel, parallel, Levels::Even)
        }
        (Order::DitherThenColouriseLumaMatched, false) => {
            colourise_ordered(img, pal, kernel, Levels::PaletteLuminances)
        }
        (Order::DitherThenColouriseLumaMatched, true) => {
            colourise_diffused(img, pal, kernel, parallel, Levels::PaletteLuminances)
        }
    };
    LinearImage::new(img.width, img.height, px)
}

// --- Order A ---------------------------------------------------------------

fn quantise_ordered(img: &LinearImage, pal: &Palette, kernel: Kernel) -> Vec<[f32; 3]> {
    let step = pal.mean_step();
    (0..img.len())
        .map(|i| {
            let (x, y) = (i as u32 % img.width, i as u32 / img.width);
            let bias = ordered_bias(kernel, x, y) * step;
            // The jitter goes on all three channels equally: it is a
            // perturbation of *where the pixel sits* before the nearest-entry
            // lookup, not a per-channel decision.
            let c = img.px[i];
            let jittered = [c[0] + bias, c[1] + bias, c[2] + bias];
            pal.entries()[pal.nearest(jittered)]
        })
        .collect()
}

fn quantise_diffused(
    img: &LinearImage,
    pal: &Palette,
    kernel: Kernel,
    parallel: bool,
) -> Vec<[f32; 3]> {
    let q = |v: [f32; 3]| pal.entries()[pal.nearest(v)];
    if parallel {
        diffuse_pipelined(&img.px, img.width, img.height, kernel, q)
    } else {
        diffuse_serial(&img.px, img.width, img.height, kernel, q)
    }
}

// --- Order B ---------------------------------------------------------------

/// Where the mask's N levels sit on the luminance scale.
#[derive(Clone, Copy)]
enum Levels {
    /// Evenly spaced in `0..=1`, ignoring how light the inks actually are.
    /// This is the research's own code sketch, and arm B is defined by it.
    Even,
    /// Spaced like the palette's own luminances — arm C's single deviation.
    ///
    /// **Normalised back to `0..=1`**, keeping only the *relative* spacing. The
    /// unnormalised version is a trap: Studio's lightest ink sits at Y ≈ 0.25,
    /// so on a source brighter than that every pixel quantises to the top level
    /// with nowhere for the error to go, and the arm renders a flat field of
    /// one colour. Normalising asks the question that was actually meant —
    /// *are the levels evenly spaced or palette-shaped?* — without also asking
    /// the arm to reproduce a brightness its inks cannot reach.
    ///
    /// A consequence worth knowing when reading the sheets: at N = 2 there is
    /// no interior level to place, so this is **identical to [`Levels::Even`]**
    /// and arms B and C are the same picture. C only says anything at N ≥ 3.
    PaletteLuminances,
}

/// The luminance each mask index stands for, ascending, spanning `0..=1`.
fn level_values(pal: &Palette, levels: Levels) -> Vec<f32> {
    let n = pal.len();
    match levels {
        Levels::Even => (0..n).map(|i| i as f32 / (n - 1) as f32).collect(),
        Levels::PaletteLuminances => {
            let ys: Vec<f32> = pal.entries().iter().map(|e| luminance(*e)).collect();
            let (lo, hi) = (ys[0], ys[n - 1]);
            let span = (hi - lo).max(1e-6);
            ys.iter().map(|y| (y - lo) / span).collect()
        }
    }
}

/// The index of the level nearest `luma`.
fn level_of(luma: f32, values: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_d = f32::INFINITY;
    for (i, v) in values.iter().enumerate() {
        let d = (luma - v).abs();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

fn colourise_ordered(
    img: &LinearImage,
    pal: &Palette,
    kernel: Kernel,
    levels: Levels,
) -> Vec<[f32; 3]> {
    let values = level_values(pal, levels);
    // The jitter amplitude is one level's worth, so a flat field lands
    // proportionally between the two levels that straddle it.
    let step = (values[values.len() - 1] - values[0]) / (values.len() - 1) as f32;
    (0..img.len())
        .map(|i| {
            let (x, y) = (i as u32 % img.width, i as u32 / img.width);
            let luma = luminance(img.px[i]) + ordered_bias(kernel, x, y) * step;
            pal.entries()[level_of(luma, &values)]
        })
        .collect()
}

fn colourise_diffused(
    img: &LinearImage,
    pal: &Palette,
    kernel: Kernel,
    parallel: bool,
    levels: Levels,
) -> Vec<[f32; 3]> {
    let values = level_values(pal, levels);
    let luma: Vec<[f32; 1]> = img.px.iter().map(|c| [luminance(*c)]).collect();
    let q = |v: [f32; 1]| [values[level_of(v[0], &values)]];
    let mask = if parallel {
        diffuse_pipelined(&luma, img.width, img.height, kernel, q)
    } else {
        diffuse_serial(&luma, img.width, img.height, kernel, q)
    };
    mask.iter()
        .map(|m| pal.entries()[level_of(m[0], &values)])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb_to_linear;

    fn ramp_image(w: u32, h: u32) -> LinearImage {
        let px = (0..(w * h))
            .map(|i| {
                let t = srgb_to_linear(((i % w) * 255 / (w - 1)) as u8);
                [t, t, t]
            })
            .collect();
        LinearImage::new(w, h, px)
    }

    fn mean_luminance(img: &LinearImage) -> f32 {
        img.px.iter().map(|p| luminance(*p)).sum::<f32>() / img.len() as f32
    }

    #[test]
    fn both_orders_emit_only_palette_colours() {
        // Neither arm may invent a colour. If one did, "which looks better"
        // would be comparing a reduction against something that is not one.
        let img = ramp_image(64, 8);
        let pal = Palette::ramp("studio", "#14110F", "#D9662C", 3);
        for &order in ALL_ORDERS {
            for kernel in [Kernel::Bayer4, Kernel::Atkinson, Kernel::FloydSteinberg] {
                let out = apply(&img, &pal, kernel, order, false);
                for p in &out.px {
                    assert!(
                        pal.entries().iter().any(|e| e == p),
                        "{} + {} emitted {p:?}",
                        order.name(),
                        kernel.name()
                    );
                }
            }
        }
    }

    #[test]
    fn the_two_orders_agree_at_the_extremes() {
        // Pure black and pure white must land on the darkest and lightest ink
        // in both arms, whatever happens in between — otherwise a difference in
        // the midtones could not be attributed to the ordering.
        let pal = Palette::ramp("studio", "#14110F", "#D9662C", 4);
        let img = LinearImage::new(2, 1, vec![[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]);
        for &order in ALL_ORDERS {
            let out = apply(&img, &pal, Kernel::Bayer4, order, false);
            assert_eq!(out.px[0], pal.entries()[0], "{}", order.name());
            assert_eq!(out.px[1], pal.entries()[3], "{}", order.name());
        }
    }

    #[test]
    fn the_orders_diverge_at_every_palette_size() {
        // #36 guessed that "for a two-entry palette these may converge
        // mathematically; for three or more they clearly do not". Measured on a
        // neutral sRGB ramp with Floyd–Steinberg and Studio's two inks, the
        // first half of that does not hold: a quarter of the frame already
        // differs at N=2, and the share climbs from there.
        let img = ramp_image(512, 16);
        let mut shares = Vec::new();
        for n in [2usize, 3, 4] {
            let pal = Palette::ramp("studio", "#14110F", "#D9662C", n);
            let a = apply(
                &img,
                &pal,
                Kernel::FloydSteinberg,
                Order::QuantiseThenDither,
                false,
            );
            let b = apply(
                &img,
                &pal,
                Kernel::FloydSteinberg,
                Order::DitherThenColourise,
                false,
            );
            let differing = a.px.iter().zip(&b.px).filter(|(x, y)| x != y).count();
            shares.push(differing as f32 / a.len() as f32);
        }
        assert!(
            shares[0] > 0.15,
            "N=2 differed on only {:.1}%",
            shares[0] * 100.0
        );
        assert!(
            shares.windows(2).all(|w| w[1] > w[0]),
            "divergence did not grow with palette size: {shares:?}"
        );
    }

    #[test]
    fn quantise_first_holds_the_mean_luminance_and_even_levels_do_not() {
        // The measured reason the third arm exists. Order B's mask assumes the
        // inks are evenly spaced in lightness; Studio's are not, so a large
        // share of the image's light disappears. Arm C recovers most of it
        // while still colourising last, which is what makes the remaining
        // difference between A and C attributable to the *order* rather than
        // to level placement.
        let img = ramp_image(512, 16);
        let pal = Palette::from_hex(
            "studio-brand",
            &["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"],
        );
        let source = mean_luminance(&img);
        let of = |o| mean_luminance(&apply(&img, &pal, Kernel::FloydSteinberg, o, false));

        let a = of(Order::QuantiseThenDither);
        let b = of(Order::DitherThenColourise);
        let c = of(Order::DitherThenColouriseLumaMatched);

        assert!((a - source).abs() < 0.02, "A drifted to {a} from {source}");
        assert!(
            b < source * 0.6,
            "B held {b} of {source}, expected far less"
        );
        assert!(c > b * 1.5, "C ({c}) barely improved on B ({b})");
    }

    #[test]
    fn at_two_inks_there_is_no_level_to_place_so_b_and_c_coincide() {
        // Stated in the sheets' README, so it is pinned here: a reader
        // comparing panels B and C on an N=2 sheet is looking at one picture
        // twice, and that is the algorithm, not a rendering slip.
        let img = ramp_image(256, 8);
        let pal = Palette::ramp("studio", "#14110F", "#D9662C", 2);
        for kernel in [Kernel::Bayer4, Kernel::FloydSteinberg, Kernel::Atkinson] {
            let b = apply(&img, &pal, kernel, Order::DitherThenColourise, false);
            let c = apply(
                &img,
                &pal,
                kernel,
                Order::DitherThenColouriseLumaMatched,
                false,
            );
            assert_eq!(b.px, c.px, "{}", kernel.name());
        }
    }

    #[test]
    fn no_arm_collapses_to_a_single_ink_on_a_full_range_source() {
        // A flat panel is the failure this arm's normalisation exists to
        // prevent: unnormalised palette levels saturate at the top whenever the
        // lightest ink is darker than the source, and the arm renders one
        // colour edge to edge.
        let img = ramp_image(512, 16);
        for pal in [
            Palette::ramp("ramp2", "#14110F", "#D9662C", 2),
            Palette::ramp("ramp4", "#14110F", "#D9662C", 4),
            Palette::from_hex("brand4", &["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"]),
        ] {
            for &order in ALL_ORDERS {
                let out = apply(&img, &pal, Kernel::FloydSteinberg, order, false);
                let distinct: std::collections::BTreeSet<[u32; 3]> = out
                    .px
                    .iter()
                    .map(|p| [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
                    .collect();
                assert!(
                    distinct.len() >= 2,
                    "{} on {} emitted one colour",
                    order.name(),
                    pal.label()
                );
            }
        }
    }

    #[test]
    fn the_parallel_path_produces_the_same_picture() {
        let img = ramp_image(200, 60);
        let pal = Palette::ramp("studio", "#14110F", "#D9662C", 3);
        for &order in ALL_ORDERS {
            for kernel in [Kernel::FloydSteinberg, Kernel::Atkinson] {
                let serial = apply(&img, &pal, kernel, order, false);
                let par = apply(&img, &pal, kernel, order, true);
                assert_eq!(serial.px, par.px, "{} + {}", order.name(), kernel.name());
            }
        }
    }

    #[test]
    fn even_levels_split_the_range_evenly() {
        let pal = Palette::ramp("p", "#000000", "#FFFFFF", 3);
        let v = level_values(&pal, Levels::Even);
        assert_eq!(v, vec![0.0, 0.5, 1.0]);
        assert_eq!(level_of(0.24, &v), 0);
        assert_eq!(level_of(0.26, &v), 1);
        assert_eq!(level_of(1.0, &v), 2);
    }

    #[test]
    fn matched_levels_sit_where_the_inks_actually_are() {
        let pal = Palette::from_hex(
            "studio-brand",
            &["#14110F", "#1F4E79", "#D9662C", "#F4EFE6"],
        );
        let v = level_values(&pal, Levels::PaletteLuminances);
        assert_eq!(v.len(), 4);
        assert!(v.windows(2).all(|w| w[1] > w[0]), "{v:?}");
        // Normalised, so the ends are pinned and only the interior moves.
        assert_eq!(v[0], 0.0);
        assert_eq!(v[3], 1.0);
        // The gap that makes the even scale wrong: nothing sits between the
        // orange and the paper, so an even four-step scale invents a level in a
        // range the palette has no ink for.
        assert!(v[3] - v[2] > 0.5, "{v:?}");
        assert!(v[1] < 0.15, "{v:?}");
    }
}
