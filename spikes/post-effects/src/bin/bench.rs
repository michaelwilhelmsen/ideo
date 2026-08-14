//! #52 Q2 — what preview latency actually is, on this machine, in linear light.
//!
//! ```text
//! cargo run --release --bin bench -- --out ~/ideo-spike-52
//! ```
//!
//! Replaces the research's `[UNVERIFIED]` extrapolation from a 2008-era paper's
//! 8K×8K/4s figure with measurements at the sizes this app deals in.
//!
//! ## What is inside the timed region, and why
//!
//! **The kernel, and the working-space conversion it needs.** Decoding a PNG
//! and encoding one back are real costs but they belong to whatever the preview
//! does with the result, not to the effect — a preview that keeps a decoded
//! frame in memory pays them once, and one that re-decodes per keystroke has a
//! problem no kernel choice fixes. So they are measured, and reported
//! separately, rather than folded in.
//!
//! **Buffer allocation is inside.** A production implementation would reuse
//! buffers across frames and could shave this, so the numbers are if anything
//! pessimistic — which is the right direction for a budget.
//!
//! ## Method
//!
//! Every measurement is the **median** of its runs after a discarded warm-up,
//! with the min and max reported so a noisy row is visible as noisy rather than
//! quietly averaged. Run counts fall as the images grow, since the point is a
//! stable median and not a fixed sample size.

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use spike_post_effects::color::{LinearImage, SrgbEncodeTable};
use spike_post_effects::dither::Kernel;
use spike_post_effects::kernels;
use spike_post_effects::orders::{apply, Order};
use spike_post_effects::palette::Palette;
use spike_post_effects::{default_source_root, DEFAULT_SOURCES};

/// The sizes the table covers.
///
/// - 1024×576 — a plausible interactive preview. The editor shows a 4-up batch,
///   so a cell is roughly this once the window and DPR are accounted for.
/// - 1920×1080 — `export::MAX_WEB_WIDTH`, what a hero is actually delivered at.
/// - 2560×1440 — a real raw model output from the project store, unmodified.
const SIZES: &[(u32, u32)] = &[(1024, 576), (1920, 1080), (2560, 1440)];

/// Where the interactive budget sits. Not a measured value — the conventional
/// threshold for a control that should feel live.
const INTERACTIVE_BUDGET_MS: f64 = 100.0;

fn main() {
    let out = out_dir();
    fs::create_dir_all(&out).expect("create output directory");

    let source = load_source();
    println!(
        "source {}×{}, {} cores\n",
        source.width,
        source.height,
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    );

    let pal2 = Palette::ramp("ramp2", "#14110F", "#D9662C", 2);
    let pal4 = Palette::ramp("ramp4", "#14110F", "#D9662C", 4);
    let pal8 = Palette::ramp("ramp8", "#14110F", "#D9662C", 8);
    let pal16 = Palette::ramp("ramp16", "#14110F", "#D9662C", 16);

    let mut rows: Vec<Row> = Vec::new();

    for &(w, h) in SIZES {
        let img = fit(&source, w, h);
        let label = format!("{}×{}", img.width, img.height);
        let mp = (img.width as f64 * img.height as f64) / 1_000_000.0;
        println!("--- {label} ({mp:.2} MP) ---");

        let mut push = |group: &'static str, name: String, serial: Stat, parallel: Option<Stat>| {
            println!(
                "  {name:<34} {:>8.2} ms{}",
                serial.median_ms(),
                parallel
                    .as_ref()
                    .map(|p| format!(
                        "  ∥ {:>7.2} ms  ×{:.1}",
                        p.median_ms(),
                        serial.median_ms() / p.median_ms()
                    ))
                    .unwrap_or_default()
            );
            rows.push(Row {
                group,
                size: label.clone(),
                mp,
                name,
                serial,
                parallel,
            });
        };

        // The mandatory tax every effect pays, whichever kernel follows it.
        let rgb = img.to_rgb8();
        let table = SrgbEncodeTable::new();
        push(
            "working space",
            "decode sRGB → linear (256-entry table)".into(),
            time(&img, |_| LinearImage::from_rgb8(&rgb)),
            None,
        );
        push(
            "working space",
            "encode linear → sRGB (exact, powf)".into(),
            time(&img, |i| i.to_rgb8()),
            None,
        );
        push(
            "working space",
            "encode linear → sRGB (4096-entry table)".into(),
            time(&img, |i| i.to_rgb8_via_table(&table)),
            None,
        );

        for (kernel, name) in [
            (Kernel::Bayer4, "ordered dither, Bayer 4×4"),
            (Kernel::Bayer8, "ordered dither, Bayer 8×8"),
            (Kernel::Clustered8, "ordered dither, clustered-dot 8×8"),
        ] {
            push(
                "ordered dither",
                name.into(),
                time(&img, |i| {
                    apply(i, &pal2, kernel, Order::QuantiseThenDither, false)
                }),
                None,
            );
        }

        for (kernel, name) in [
            (Kernel::FloydSteinberg, "Floyd–Steinberg"),
            (Kernel::Atkinson, "Atkinson"),
        ] {
            push(
                "error diffusion",
                format!("{name}, RGB (order A)"),
                time(&img, |i| {
                    apply(i, &pal2, kernel, Order::QuantiseThenDither, false)
                }),
                Some(time(&img, |i| {
                    apply(i, &pal2, kernel, Order::QuantiseThenDither, true)
                })),
            );
            push(
                "error diffusion",
                format!("{name}, luminance (order B)"),
                time(&img, |i| {
                    apply(i, &pal2, kernel, Order::DitherThenColourise, false)
                }),
                Some(time(&img, |i| {
                    apply(i, &pal2, kernel, Order::DitherThenColourise, true)
                })),
            );
        }

        for pal in [&pal2, &pal4, &pal8, &pal16] {
            push(
                "quantisation",
                format!("palette quantise, {} entries", pal.len()),
                time(&img, |i| kernels::quantise(i, pal, false)),
                Some(time(&img, |i| kernels::quantise(i, pal, true))),
            );
        }

        push(
            "pointwise",
            "posterise, 6 levels".into(),
            time(&img, |i| kernels::posterise(i, 6, false)),
            Some(time(&img, |i| kernels::posterise(i, 6, true))),
        );
        push(
            "pointwise",
            "pixelate, 8px cells".into(),
            time(&img, |i| kernels::pixelate(i, 8, false)),
            Some(time(&img, |i| kernels::pixelate(i, 8, true))),
        );
        push(
            "pointwise",
            "film grain".into(),
            time(&img, |i| kernels::grain(i, 0.15, 1, false)),
            Some(time(&img, |i| kernels::grain(i, 0.15, 1, true))),
        );
        push(
            "pointwise",
            "ASCII cell mapping, 8px cells".into(),
            time(&img, |i| kernels::ascii_map(i, 8, false)),
            Some(time(&img, |i| kernels::ascii_map(i, 8, true))),
        );
        println!();
    }

    let report = report(&rows);
    fs::write(out.join("latency.md"), &report).expect("write latency table");
    println!("wrote {}", out.join("latency.md").display());
}

struct Row {
    group: &'static str,
    size: String,
    mp: f64,
    name: String,
    serial: Stat,
    parallel: Option<Stat>,
}

/// The runs for one measurement, kept whole so the spread can be reported.
struct Stat(Vec<Duration>);

impl Stat {
    fn median_ms(&self) -> f64 {
        self.0[self.0.len() / 2].as_secs_f64() * 1000.0
    }
    fn min_ms(&self) -> f64 {
        self.0[0].as_secs_f64() * 1000.0
    }
    fn max_ms(&self) -> f64 {
        self.0[self.0.len() - 1].as_secs_f64() * 1000.0
    }
}

/// Time `f` over the image, discarding a warm-up run.
///
/// `std::hint::black_box` on the result, or the optimiser is free to notice
/// that nothing reads it and delete the kernel outright — which would report a
/// very fast dither indeed.
fn time<T>(img: &LinearImage, f: impl Fn(&LinearImage) -> T) -> Stat {
    let runs = match img.len() {
        0..=1_000_000 => 9,
        1_000_001..=3_000_000 => 5,
        _ => 5,
    };
    std::hint::black_box(f(img));
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            std::hint::black_box(f(img));
            t.elapsed()
        })
        .collect();
    times.sort_unstable();
    Stat(times)
}

/// Resample the source to a given size, keeping it a real image rather than
/// synthetic noise — dither cost is data-dependent (a flat region diffuses zero
/// error and skips work), so a random buffer would overstate it.
fn fit(src: &LinearImage, w: u32, h: u32) -> LinearImage {
    let scaled = src.downscale_to_width(w);
    if scaled.height >= h {
        scaled.crop(0, (scaled.height - h) / 2, w, h)
    } else {
        scaled
    }
}

/// The widest of the three sources.
///
/// Widest rather than first, because [`fit`] only ever scales *down* — running
/// the 2560×1440 row off a 2048-wide source would silently report a smaller
/// image under a larger heading, which is the one mistake a latency table
/// cannot survive.
fn load_source() -> LinearImage {
    let root = default_source_root();
    let mut best: Option<(&str, LinearImage)> = None;
    for s in DEFAULT_SOURCES {
        let path = root.join(s.path);
        let Ok(img) = image::open(&path) else {
            continue;
        };
        let img = LinearImage::from_rgb8(&img.to_rgb8());
        if best.as_ref().is_none_or(|(_, b)| img.width > b.width) {
            best = Some((s.slug, img));
        }
    }
    let (slug, img) = best.unwrap_or_else(|| panic!("no source image under {}", root.display()));
    println!("using {slug} ({}×{})", img.width, img.height);
    img
}

fn report(rows: &[Row]) -> String {
    let mut s = String::from(
        "# Post-effect latency — measured\n\n\
         Median of 5–9 runs after a warm-up; min/max given so a noisy row reads as noisy. \
         Times are the kernel only, in linear light, including its own buffer allocation. \
         Decode and encode are listed separately at the top of each size — every effect \
         pays them, but only once per frame held in memory.\n\n\
         `∥` is the parallel run. Ordered dither and the pointwise kernels use rayon; \
         error diffusion uses the pipelined-row scheme, which produces byte-identical \
         output to the serial run and is therefore a like-for-like comparison rather than \
         a different algorithm.\n\n",
    );

    let mut sizes: Vec<&str> = Vec::new();
    for r in rows {
        if !sizes.contains(&r.size.as_str()) {
            sizes.push(&r.size);
        }
    }

    for size in &sizes {
        let mp = rows
            .iter()
            .find(|r| &r.size == size)
            .map(|r| r.mp)
            .unwrap_or(0.0);
        let _ = write!(s, "## {size} ({mp:.2} MP)\n\n| group | kernel | serial median | min–max | parallel median | speedup | ms/MP (best) |\n| --- | --- | --- | --- | --- | --- | --- |\n");
        for r in rows.iter().filter(|r| &r.size == size) {
            let best = r
                .parallel
                .as_ref()
                .map(|p| p.median_ms().min(r.serial.median_ms()))
                .unwrap_or_else(|| r.serial.median_ms());
            let _ = writeln!(
                s,
                "| {} | {} | {:.2} ms | {:.2}–{:.2} | {} | {} | {:.2} |",
                r.group,
                r.name,
                r.serial.median_ms(),
                r.serial.min_ms(),
                r.serial.max_ms(),
                r.parallel
                    .as_ref()
                    .map(|p| format!("{:.2} ms", p.median_ms()))
                    .unwrap_or_else(|| "—".into()),
                r.parallel
                    .as_ref()
                    .map(|p| format!("×{:.1}", r.serial.median_ms() / p.median_ms()))
                    .unwrap_or_else(|| "—".into()),
                best / r.mp,
            );
        }
        s.push('\n');
    }

    // The one comparison the preview decision turns on.
    let _ = write!(
        s,
        "## The asymmetry, stated\n\n\
         | size | slowest ordered dither | slowest error diffusion (serial) | slowest error diffusion (∥) |\n| --- | --- | --- | --- |\n"
    );
    for size in &sizes {
        let of = |group: &str, parallel: bool| -> f64 {
            rows.iter()
                .filter(|r| &r.size == size && r.group == group)
                .map(|r| {
                    if parallel {
                        r.parallel
                            .as_ref()
                            .map(|p| p.median_ms())
                            .unwrap_or(r.serial.median_ms())
                    } else {
                        r.serial.median_ms()
                    }
                })
                .fold(0.0f64, f64::max)
        };
        let _ = writeln!(
            s,
            "| {size} | {:.2} ms | {:.2} ms | {:.2} ms |",
            of("ordered dither", false),
            of("error diffusion", false),
            of("error diffusion", true),
        );
    }
    let _ = write!(
        s,
        "\nAgainst a {INTERACTIVE_BUDGET_MS:.0} ms interactive budget, for the kernel alone.\n"
    );
    s
}

fn out_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--out" {
            return PathBuf::from(args.next().expect("--out needs a path"));
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("ideo-spike-52")
}
