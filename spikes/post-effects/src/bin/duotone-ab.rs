//! #52 Q1 — render both duotone orders on real images and hand them back
//! **undecided**.
//!
//! ```text
//! cargo run --release --bin duotone-ab -- --out ~/ideo-spike-52
//! ```
//!
//! For every (source × palette × kernel) it writes two contact sheets:
//!
//! - `*-hero.png` — the arms stacked vertically, each at 1920px, which is how
//!   a hero actually lands on a page. Separated by a white rule.
//! - `*-1to1.png` — the same crop from each arm laid out left to right at
//!   100%, which is where the dither texture is legible.
//!
//! Panel order is always **A (quantise first) → B (colourise last) → C
//! (colourise last, luma-matched)**, top-to-bottom and left-to-right. It is
//! written into `README.md` alongside the images so a sheet is still readable
//! once it has been dragged somewhere else.
//!
//! It also writes `stats.md`: per combination, what share of pixels the arms
//! disagree on and what each does to the frame's mean luminance. The pictures
//! are the deliverable, but the numbers stop "they look different" from being
//! the whole report.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use spike_post_effects::color::{luminance, LinearImage};
use spike_post_effects::dither::Kernel;
use spike_post_effects::orders::{apply, Order, ALL_ORDERS};
use spike_post_effects::palette::Palette;
use spike_post_effects::{default_source_root, DEFAULT_SOURCES};

/// What a hero is delivered at — the same number as `export::MAX_WEB_WIDTH`.
const HERO_WIDTH: u32 = 1920;
const CROP_W: u32 = 760;
const CROP_H: u32 = 620;
const RULE: u32 = 8;

const KERNELS: &[Kernel] = &[Kernel::Atkinson, Kernel::FloydSteinberg];

/// Studio, from `palettes.json` — the palette a new project starts with.
const INK: &str = "#14110F";
const PRIMARY: &str = "#D9662C";
const SECONDARY: &str = "#1F4E79";
const PAPER: &str = "#F4EFE6";

fn palettes() -> Vec<Palette> {
    vec![
        // A duotone with more levels: still a straight line between the two
        // inks, which is the generous reading of the shipped `note`.
        Palette::ramp("ramp2", INK, PRIMARY, 2),
        Palette::ramp("ramp3", INK, PRIMARY, 3),
        Palette::ramp("ramp4", INK, PRIMARY, 4),
        // Actual roles off Studio — not a line, which is the case the research
        // predicts quantise-first handles badly.
        Palette::from_hex("brand3", &[INK, PRIMARY, PAPER]),
        Palette::from_hex("brand4", &[INK, SECONDARY, PRIMARY, PAPER]),
    ]
}

fn main() {
    let out = out_dir();
    let sheets = out.join("duotone-ab");
    fs::create_dir_all(&sheets).expect("create output directory");

    let root = default_source_root();
    let mut stats: Vec<Row> = Vec::new();

    for source in DEFAULT_SOURCES {
        let path = root.join(source.path);
        let decoded = match image::open(&path) {
            Ok(i) => i.to_rgb8(),
            Err(e) => {
                eprintln!("skipping {} — {e} ({})", source.slug, path.display());
                continue;
            }
        };
        let img = LinearImage::from_rgb8(&decoded);
        let source_mean = mean_luminance(&img);
        println!(
            "{} {}×{} mean luminance {source_mean:.4}",
            source.slug, img.width, img.height
        );

        // A crop taken from the same relative place in every source, so the
        // 1:1 sheets are comparable to each other and not just within a pair.
        let cx = (img.width as f32 * 0.28) as u32;
        let cy = (img.height as f32 * 0.42) as u32;

        for pal in palettes() {
            for &kernel in KERNELS {
                let arms: Vec<(Order, LinearImage)> = ALL_ORDERS
                    .iter()
                    .map(|&o| (o, apply(&img, &pal, kernel, o, true)))
                    .collect();

                let stem = format!("{}__{}__{}", source.slug, pal.label(), kernel.name());

                let hero: Vec<LinearImage> = arms
                    .iter()
                    .map(|(_, a)| a.downscale_to_width(HERO_WIDTH))
                    .collect();
                write_png(&sheets.join(format!("{stem}__hero.png")), &stack_v(&hero));

                let crops: Vec<LinearImage> = arms
                    .iter()
                    .map(|(_, a)| a.crop(cx, cy, CROP_W, CROP_H))
                    .collect();
                write_png(&sheets.join(format!("{stem}__1to1.png")), &stack_h(&crops));

                stats.push(Row {
                    source: source.slug,
                    source_mean,
                    palette: pal.label().to_string(),
                    kernel: kernel.name(),
                    means: arms.iter().map(|(_, a)| mean_luminance(a)).collect(),
                    ab: disagreement(&arms[0].1, &arms[1].1),
                    ac: disagreement(&arms[0].1, &arms[2].1),
                    bc: disagreement(&arms[1].1, &arms[2].1),
                });
                println!("  wrote {stem}");
            }
        }
    }

    fs::write(sheets.join("stats.md"), stats_table(&stats)).expect("write stats");
    fs::write(sheets.join("README.md"), readme()).expect("write readme");
    println!("\n{} sheets in {}", stats.len() * 2, sheets.display());
}

struct Row {
    source: &'static str,
    source_mean: f32,
    palette: String,
    kernel: &'static str,
    means: Vec<f32>,
    ab: f32,
    ac: f32,
    bc: f32,
}

fn stats_table(rows: &[Row]) -> String {
    let mut s = String::from(
        "# Duotone ordering A/B — measured\n\n\
         Arms: **A** quantise-then-dither · **B** dither-then-colourise (even levels) · \
         **C** dither-then-colourise (luma-matched).\n\n\
         `differ` is the share of pixels on which two arms emit a different ink. \
         `mean Y` is the frame's mean linear luminance; the source's own is given for \
         comparison, and an arm that lands far from it has lost or gained light that \
         was in the original.\n\n\
         | source | palette | kernel | source mean Y | A mean Y | B mean Y | C mean Y | A↔B differ | A↔C differ | B↔C differ |\n\
         | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n",
    );
    for r in rows {
        s.push_str(&format!(
            "| {} | {} | {} | {:.4} | {:.4} | {:.4} | {:.4} | {:.1}% | {:.1}% | {:.1}% |\n",
            r.source,
            r.palette,
            r.kernel,
            r.source_mean,
            r.means[0],
            r.means[1],
            r.means[2],
            r.ab * 100.0,
            r.ac * 100.0,
            r.bc * 100.0,
        ));
    }

    // A per-palette roll-up, because the per-row table is 30 lines and the
    // shape of the answer is easier to see collapsed.
    let mut by_palette: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows {
        by_palette.entry(r.palette.as_str()).or_default().push(r);
    }
    s.push_str("\n## By palette\n\n| palette | mean A↔B divergence | mean |A − source| | mean |B − source| | mean |C − source| |\n| --- | --- | --- | --- | --- |\n");
    for (pal, rs) in by_palette {
        let n = rs.len() as f32;
        let avg = |f: &dyn Fn(&Row) -> f32| rs.iter().map(|r| f(r)).sum::<f32>() / n;
        s.push_str(&format!(
            "| {} | {:.1}% | {:.4} | {:.4} | {:.4} |\n",
            pal,
            avg(&|r| r.ab) * 100.0,
            avg(&|r| (r.means[0] - r.source_mean).abs()),
            avg(&|r| (r.means[1] - r.source_mean).abs()),
            avg(&|r| (r.means[2] - r.source_mean).abs()),
        ));
    }
    s
}

fn readme() -> String {
    let mut s = String::from(
        "# Duotone ordering A/B — #52 Q1\n\n\
         **Handed back undecided.** #52 asks for the pictures and a description of \
         how the arms differ, and says the verdict is made by eye elsewhere.\n\n\
         ## Panel order\n\n\
         Every sheet has three panels, always in this order — top to bottom on \
         `*-hero.png`, left to right on `*-1to1.png`:\n\n\
         1. **A — quantise then dither.** What `rs-duotone-dither` and \
         `gn-duotone-landscape` say on screen today. Nearest palette entry in linear \
         RGB; the per-channel colour error is what gets diffused.\n\
         2. **B — dither then colourise.** What the research reasons toward, \
         implemented as its own code sketch has it: threshold source luminance \
         against an even 0..1 scale, map the resulting index to an ink last.\n\
         3. **C — dither then colourise, luma-matched.** *Not one of the two orders \
         #52 named.* Identical to B except the mask's levels sit at the palette's own \
         luminances instead of at even steps. It is here because Studio's inks are \
         nowhere near evenly spaced, so B loses over half the frame's light on the \
         four-ink palettes — and without C, that loss would read as an argument \
         about ordering when it is really an argument about level placement.\n\n\
         ## Reading them\n\n\
         `*-hero.png` is each arm at 1920px, which is what `export::MAX_WEB_WIDTH` \
         delivers and therefore how these are actually seen. `*-1to1.png` is the same \
         crop from each arm at 100%, which is the only place the dither texture is \
         honestly legible.\n\n\
         Filenames are `<source>__<palette>__<kernel>__<view>.png`.\n\n\
         ## Palettes\n\n\
         `rampN` interpolates N steps between Studio's `ink` and `primary` in linear \
         light — a duotone with more levels, still a straight line in colour space. \
         `brandN` uses Studio's actual roles, which are not a line.\n\n\
         ## Sources\n\n",
    );
    for src in DEFAULT_SOURCES {
        s.push_str(&format!("- **{}** — {}\n", src.slug, src.kind));
    }
    s.push_str(
        "\nThese are the app's own generated outputs, read from the local project store. \
         They are not copied into the repo.\n",
    );
    s
}

fn mean_luminance(img: &LinearImage) -> f32 {
    img.px.iter().map(|p| luminance(*p)).sum::<f32>() / img.len() as f32
}

fn disagreement(a: &LinearImage, b: &LinearImage) -> f32 {
    let n = a.px.iter().zip(&b.px).filter(|(x, y)| x != y).count();
    n as f32 / a.len() as f32
}

/// Panels stacked top to bottom, separated by a white rule.
fn stack_v(panels: &[LinearImage]) -> LinearImage {
    let w = panels.iter().map(|p| p.width).max().unwrap_or(1);
    let h: u32 = panels.iter().map(|p| p.height).sum::<u32>() + RULE * (panels.len() as u32 - 1);
    let mut px = vec![[1.0f32; 3]; (w * h) as usize];
    let mut y0 = 0u32;
    for p in panels {
        for y in 0..p.height {
            let dst = ((y0 + y) * w) as usize;
            let src = (y * p.width) as usize;
            px[dst..dst + p.width as usize].copy_from_slice(&p.px[src..src + p.width as usize]);
        }
        y0 += p.height + RULE;
    }
    LinearImage::new(w, h, px)
}

/// Panels laid out left to right, separated by a white rule.
fn stack_h(panels: &[LinearImage]) -> LinearImage {
    let h = panels.iter().map(|p| p.height).max().unwrap_or(1);
    let w: u32 = panels.iter().map(|p| p.width).sum::<u32>() + RULE * (panels.len() as u32 - 1);
    let mut px = vec![[1.0f32; 3]; (w * h) as usize];
    let mut x0 = 0u32;
    for p in panels {
        for y in 0..p.height {
            let dst = (y * w + x0) as usize;
            let src = (y * p.width) as usize;
            px[dst..dst + p.width as usize].copy_from_slice(&p.px[src..src + p.width as usize]);
        }
        x0 += p.width + RULE;
    }
    LinearImage::new(w, h, px)
}

fn write_png(path: &Path, img: &LinearImage) {
    img.to_rgb8()
        .save(path)
        .unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

/// Where the sheets go. Deliberately outside the repo — these are derived from
/// the user's own generated images and are not committed.
fn out_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--out" {
            return PathBuf::from(args.next().expect("--out needs a path"));
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("ideo-spike-52")
}
