//! What to ask ffmpeg for — argument lists, and nothing that runs them.
//!
//! Split from `ffmpeg.rs` on purpose, and it is the half that carries the
//! judgement: the codecs, the quality, the width cap and the ping-pong graph are
//! all decisions about what a landing page can afford, and every one of them is
//! a pure function of the request. So they are unit-tested without ffmpeg
//! installed, on a machine that has never encoded anything.
//!
//! The other half of PRD §8's "abstraction that does not care which ffmpeg it
//! talks to" is here rather than there: a bundled static binary would take the
//! same arguments, so bundling later touches `ffmpeg.rs` and leaves this file
//! alone.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::ExportError;

/// The widest a hero ever needs to be delivered.
///
/// Raw model output is routinely wider (PRD §8 — "far too heavy for a landing
/// page"), and a 4K clip behind a headline is bytes nobody sees. The cap only
/// ever scales *down*: `min(MAX_WEB_WIDTH, iw)` leaves a narrower clip alone
/// rather than upscaling it into a bigger file with no more detail in it.
pub const MAX_WEB_WIDTH: u32 = 1920;

/// How big a deliverable ships (#58).
///
/// A treated export is the one case where more pixels are worth paying for, and
/// the reason is that a treatment is not photographic detail — it is a pattern
/// generated at the output grid. A dither drawn at 3840 has edges exactly one
/// output pixel hard whatever the picture underneath was; the upscaled photo
/// only has to supply tone, and a two-ink quantiser throws away most of the
/// tonal precision anyway. So the pattern stays sharp where a plain upscale
/// would just be a bigger blur.
///
/// **Every size is the same look.** The pattern is scaled with the export
/// ([`pattern_scale`](ExportSize::pattern_scale)), so `Double` is the picture the preview showed with harder
/// edges rather than a finer screen — which is what keeps the preview honest at
/// one size instead of needing to follow this choice around the app. It is also
/// what makes the MP4 better rather than merely bigger: a cell several output
/// pixels across survives the 4:2:0 chroma that ruins a one-pixel one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExportSize {
    /// [`MAX_WEB_WIDTH`], and what every export was before this existed.
    Web,
    /// The candidate's own size, uncapped — the pixels the model actually
    /// returned, rather than the ones left after the web cap.
    Native,
    /// Twice the web width. Offered only where a treatment is being baked:
    /// upscaling a clean plate is bytes with nothing in them.
    Double,
}

impl ExportSize {
    /// The width to deliver at, from the source's own.
    pub fn target_width(self, source: u32) -> u32 {
        match self {
            ExportSize::Web => source.min(MAX_WEB_WIDTH),
            ExportSize::Native => source,
            ExportSize::Double => source.min(MAX_WEB_WIDTH).saturating_mul(2),
        }
    }

    /// The same number as an ffmpeg `w=` expression, for the paths that scale
    /// without ever having asked how wide the input is.
    ///
    /// Rounded down to even, for the reason the height carries `-2`: 4:2:0
    /// chroma cannot express an odd number of *columns* either, and libx264
    /// refuses the encode outright rather than delivering a slightly wrong
    /// picture. The cap hid this while it was the only expression here — 1920 is
    /// even, so only a source narrower than the cap could arrive odd — and
    /// `iw` exposes it for every width a model cares to return.
    ///
    /// It is also what keeps this and `bake::shipped_size` in step. That one
    /// ends `& !1`, so without the same rounding here, turning a treatment on
    /// would silently resize an odd-width deliverable by a pixel — which is the
    /// one thing the two are arranged never to do.
    pub fn width_expression(self) -> String {
        let target = match self {
            ExportSize::Web => format!("min({MAX_WEB_WIDTH},iw)"),
            ExportSize::Native => "iw".to_string(),
            ExportSize::Double => format!("min({MAX_WEB_WIDTH},iw)*2"),
        };

        format!("trunc({target}/2)*2")
    }

    /// Output pixels per look pixel, for the size that was chosen.
    ///
    /// The look is defined at the web width, and everything above it is the same
    /// look with more pixels under it — so this is the number the shader divides its
    /// pattern coordinates by. `Double` is exactly 2 by construction; `Native` is
    /// however much wider than the cap the source happened to be, which is 1 for
    /// every candidate that was never over it.
    ///
    /// ## `Native` is the one scale that can be fractional, and that is deliberate
    ///
    /// A 2560-wide source gives 1.333, and a grid-based pattern — the ordered
    /// dithers, the grain — then lands on look pixels one and two output pixels
    /// wide in turn, rather than uniformly two. That is not the grid coming apart:
    /// it is exactly what a nearest-neighbour magnification by 1.333 looks like,
    /// which is what "the same look, resolved by more pixels" *means* at a ratio
    /// that is not a whole number. The alternatives were both worse and both were
    /// rejected: rounding the scale to 1 would ship a pattern a third finer than
    /// the one the preview showed, and rounding the *width* to a whole multiple of
    /// the cap would quietly deliver `Web` under `Native`'s name.
    ///
    /// It only arises for a treated still, and only from a style candidate over the
    /// cap — every clip is under it (the animate models cap at 720p), so a clip's
    /// `Native` is its `Web`. The halftone screen scales continuously and is
    /// unaffected either way.
    pub fn pattern_scale(self, shipped_width: u32) -> f64 {
        match self {
            ExportSize::Web => 1.0,
            ExportSize::Double => 2.0,
            ExportSize::Native => {
                let shipped = shipped_width.max(1);
                f64::from(shipped) / f64::from(shipped.min(MAX_WEB_WIDTH))
            }
        }
    }

    /// This size, as it applies to an export with no treatment in it.
    ///
    /// `Double` degrades to the source's own size, because the argument for
    /// upscaling is entirely about a pattern drawn at the output grid. With no
    /// pattern, a 2× file carries exactly the detail the 1× file had and twice
    /// the bytes. The panel does not offer the combination; this is what makes
    /// it impossible to route around.
    fn untreated(self) -> ExportSize {
        match self {
            ExportSize::Double => ExportSize::Native,
            other => other,
        }
    }
}

/// H.264's quality knob. 23 is ffmpeg's own default and the usual web hero
/// setting — visually clean at a fraction of the source's weight.
const H264_CRF: &str = "23";

/// VP9 wants a higher number for the same picture; 33 is close to 23 in H.264.
/// Paired with `-b:v 0`, without which VP9 reads the CRF as a ceiling on a
/// bitrate-targeted encode rather than as the quality target.
const VP9_CRF: &str = "33";

/// JPEG quality for the poster, on ffmpeg's inverted 2–31 scale. 3 is near the
/// top: the poster is the first paint, and a visible artefact there is the one
/// frame every visitor sees.
const POSTER_QUALITY: &str = "3";

/// What an encode reads from.
///
/// Three variants and not one, because the width cap is the difference between
/// them (#36). A treatment's pattern is *rendered at the export resolution*, so
/// scaling afterwards would destroy the cell size the user dialled in — but the
/// untreated path still has to scale, and both have to produce the same
/// dimensions or turning a treatment on would silently resize the deliverable.
#[derive(Debug, Clone)]
pub enum Input {
    /// The candidate's own file, still at whatever the model returned.
    Source(PathBuf),
    /// One treated still, already at the export resolution.
    TreatedStill(PathBuf),
    /// Treated frames, already at the export resolution.
    ///
    /// `pattern` is an ffmpeg sequence pattern (`out-%06d.png`) relative to
    /// nothing — it is passed whole, and the frames live in a temp folder this
    /// process created.
    TreatedFrames { pattern: String, fps: f64 },
}

impl Input {
    /// Where ffmpeg reads it from.
    fn arguments(&self) -> Vec<String> {
        match self {
            Input::Source(path) | Input::TreatedStill(path) => {
                vec!["-i".to_string(), path.to_string_lossy().to_string()]
            }
            Input::TreatedFrames { pattern, fps } => vec![
                // Before `-i`, so it is the *input* rate rather than a
                // re-timing of one ffmpeg guessed at.
                "-framerate".to_string(),
                format!("{fps}"),
                "-i".to_string(),
                pattern.clone(),
            ],
        }
    }

    /// Whether the width cap still has to be applied.
    ///
    /// Only to the untreated path. Everything else arrives at the size it will
    /// ship at, because that is the whole point of rendering the shader at the
    /// export resolution.
    fn needs_scaling(&self) -> bool {
        matches!(self, Input::Source(_))
    }

    /// Whether a treatment has been rendered into these pixels.
    ///
    /// Worth asking because a treated frame is a fundamentally different
    /// picture to encode. Model output is photographic — smooth gradients,
    /// colour that varies slowly — and every default in a web encoder is tuned
    /// for it. A dither is the opposite: a two-colour pattern at the pixel
    /// grid, carrying its tone in the arrangement rather than in the colours.
    /// The settings that are right for one are wrong for the other, which is
    /// what {@link Deliverable::extension} and the WebM's pixel format both
    /// turn on.
    fn is_treated(&self) -> bool {
        !matches!(self, Input::Source(_))
    }
}

/// One of the three files PRD §8 promises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deliverable {
    Mp4,
    WebM,
    Poster,
}

impl Deliverable {
    pub fn as_str(self) -> &'static str {
        match self {
            Deliverable::Mp4 => "mp4",
            Deliverable::WebM => "webm",
            Deliverable::Poster => "poster",
        }
    }

    /// What the file is called, which for the poster depends on what is in it.
    ///
    /// A treated poster is a PNG. JPEG's chroma subsampling is the same knife
    /// that ruins the video — measured on a two-ink Bayer ramp, PNG comes back
    /// pixel-exact at 24 KB where JPEG is 1.75 MB and still slightly wrong. A
    /// dither is nearly the ideal case for PNG's filters and nearly the worst
    /// case for a DCT, so this is smaller *and* correct, not a trade.
    ///
    /// Untreated posters stay JPEG: model output is photographic, and there
    /// PNG would be several times the weight of the JPEG for no visible gain.
    fn extension(self, treated: bool) -> &'static str {
        match self {
            Deliverable::Mp4 => "mp4",
            Deliverable::WebM => "webm",
            Deliverable::Poster if treated => "png",
            Deliverable::Poster => "jpg",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            // The poster sits beside the clip in the same folder, so it says
            // what it is — `hero.mp4` and `hero-poster.jpg` read as one set.
            Deliverable::Poster => "-poster",
            _ => "",
        }
    }
}

/// Which files this export was asked for.
///
/// Three booleans rather than a set, because that is what the panel is: three
/// checkboxes, and a request for none of them is a mistake worth naming.
#[derive(Debug, Clone, Copy)]
pub struct Formats {
    pub mp4: bool,
    pub webm: bool,
    pub poster: bool,
}

/// One file, and the arguments that produce it.
#[derive(Debug, Clone)]
pub struct Step {
    pub deliverable: Deliverable,
    pub file_name: String,
    pub args: Vec<String>,
}

/// Everything one export does, in order.
#[derive(Debug, Clone)]
pub struct Plan {
    pub steps: Vec<Step>,
}

/// What is being exported — which decides what can be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Medium {
    Still,
    Clip,
}

/// Whether a file is a clip, from its extension.
///
/// The file rather than the generation's stage, for the reason
/// `components/editor/shared.tsx` gives on the other side of the boundary: the
/// stage is a separate field, and asking the file what it is means a project
/// somebody has been editing by hand still exports what it actually holds.
pub fn medium_of(source: &Path) -> Medium {
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    // The same two containers the frontend's `VIDEO_EXTENSIONS` names, and for
    // the same reason: they are what `extension_for` can produce. Anything else
    // in the assets folder is treated as a picture, which costs a refused video
    // export rather than a filter graph ffmpeg cannot run.
    match extension.as_str() {
        "mp4" | "webm" => Medium::Clip,
        _ => Medium::Still,
    }
}

/// The arguments for every file this export produces, or a reason it produces
/// none.
///
/// `rewind` is honoured only on a clip. A still has no time axis to play
/// backwards, and silently accepting the flag there would make the panel's two
/// controls look independent when one is meaningless without the other.
pub fn plan(
    input: &Input,
    base_name: &str,
    formats: Formats,
    rewind: bool,
    medium: Medium,
    size: ExportSize,
) -> Result<Plan, ExportError> {
    let wants_video = formats.mp4 || formats.webm;

    if !wants_video && !formats.poster {
        return Err(ExportError::NothingRequested);
    }

    if wants_video && medium == Medium::Still {
        return Err(ExportError::NotAClip);
    }

    let ping_pong = rewind && medium == Medium::Clip;
    let base_name = &safe_base_name(base_name);
    let mut steps = Vec::new();

    if formats.mp4 {
        steps.push(step(
            Deliverable::Mp4,
            input,
            base_name,
            ping_pong,
            size,
            &[
                "-c:v",
                "libx264",
                "-profile:v",
                "high",
                // 4:2:0 even on a treated export, where it visibly ruins the
                // dither. The faithful alternative is High 4:4:4 Predictive,
                // which no browser decodes — so an MP4 in it would not be a
                // better hero, it would be a file the page cannot play. The
                // WebM below carries the honest version for everyone whose
                // browser will take it; this stays the one that always plays.
                "-pix_fmt",
                "yuv420p",
                // Left at the usual web setting on purpose. Measured on a
                // two-ink dither, taking this from 23 to 12 moved the error by
                // 0.2 of 255 and nearly doubled the file: the damage here is
                // the chroma format, and no quality setting reaches it.
                "-crf",
                H264_CRF,
                "-preset",
                "slow",
                // The index up front, so the browser can start playing before
                // the whole file has arrived. Without it a hero clip is a blank
                // box until the last byte lands.
                "-movflags",
                "+faststart",
                // A hero loop is silent, and an audio track is bytes with
                // nothing in them.
                "-an",
            ],
        ));
    }

    if formats.webm {
        steps.push(step(
            Deliverable::WebM,
            input,
            base_name,
            ping_pong,
            size,
            &[
                "-c:v",
                "libvpx-vp9",
                "-pix_fmt",
                webm_pixel_format(input),
                "-crf",
                VP9_CRF,
                "-b:v",
                "0",
                "-row-mt",
                "1",
                "-deadline",
                "good",
                "-cpu-used",
                "2",
                "-an",
            ],
        ));
    }

    if formats.poster {
        // The first frame, and the first frame of the *forward* pass either way
        // — a ping-pong clip starts where the original does, so the poster is
        // the same picture whether or not rewind is on.
        //
        // A PNG carries no quality knob: it is lossless, so the JPEG scale
        // would be a setting with nothing to set.
        let poster: &[&str] = if input.is_treated() {
            &["-frames:v", "1", "-f", "image2"]
        } else {
            &["-frames:v", "1", "-q:v", POSTER_QUALITY, "-f", "image2"]
        };

        steps.push(step(
            Deliverable::Poster,
            input,
            base_name,
            false,
            size,
            poster,
        ));
    }

    Ok(Plan { steps })
}

/// What the WebM stores colour at.
///
/// 4:2:0 keeps one colour sample per four pixels, which is invisible on
/// photographic output and fatal to a dither: two inks alternating pixel by
/// pixel average into one wrong colour before the codec starts. Measured on a
/// two-ink Bayer ramp, 4:2:0 leaves 21% of pixels anywhere near an ink and 4:4:4
/// leaves 100%.
///
/// Only VP9 can be asked. It costs bytes — roughly double on that same ramp —
/// which is why an untreated export does not pay it: there is nothing there
/// that subsampling harms.
fn webm_pixel_format(input: &Input) -> &'static str {
    if input.is_treated() {
        "yuv444p"
    } else {
        "yuv420p"
    }
}

fn step(
    deliverable: Deliverable,
    input: &Input,
    base_name: &str,
    ping_pong: bool,
    size: ExportSize,
    encoder: &[&str],
) -> Step {
    let file_name = format!(
        "{base_name}{}.{}",
        deliverable.suffix(),
        deliverable.extension(input.is_treated())
    );

    // Only the untreated path still has a scale to apply, and only there does
    // the chosen size mean anything to ffmpeg: a treated frame arrives at the
    // size it will ship at, because that is where the shader drew it.
    let scaled = input.needs_scaling().then(|| size.untreated());

    let mut args = vec![
        // Re-exporting the same candidate to the same folder is the normal way
        // to change one setting, so the previous attempt is replaced rather
        // than refused. The name is derived from the generation, so this can
        // only ever overwrite an earlier export of the same thing.
        "-y".to_string(),
    ];
    args.extend(input.arguments());

    if ping_pong {
        args.push("-filter_complex".to_string());
        args.push(ping_pong_graph(scaled));
        args.push("-map".to_string());
        args.push("[out]".to_string());
    } else {
        args.push("-vf".to_string());
        args.push(geometry_filter(scaled));
    }

    args.extend(encoder.iter().map(|arg| (*arg).to_string()));
    args.push(file_name.clone());

    Step {
        deliverable,
        file_name,
        args,
    }
}

/// A file name from something a user typed.
///
/// The base name is the project's own name, so it arrives from the webview with
/// whatever is in it — spaces, slashes, an emoji, a leading dot. Filtered rather
/// than rejected, because refusing to export a project called "Atlas / hero"
/// would be a strange thing to refuse; the *export* is what has to be a legal
/// file name, not the project.
///
/// A slash matters more than the rest: the steps run with the destination as
/// their working directory (see `ffmpeg::run`), so a name carrying one would
/// otherwise write outside the folder the user chose.
fn safe_base_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Runs of punctuation collapse rather than becoming a row of dashes, and a
    // name that filtered away entirely still has to be a file.
    let trimmed = cleaned
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<&str>>()
        .join("-");

    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

/// Scale to the cap and never past it, on even dimensions.
///
/// `-2` rather than `-1` for the height: H.264's 4:2:0 chroma cannot express an
/// odd number of rows, and an odd height is a hard encoder failure rather than a
/// slightly wrong picture. `setsar=1` because a model that returns non-square
/// pixels would otherwise deliver a clip the browser stretches.
fn geometry_filter(scaled: Option<ExportSize>) -> String {
    if let Some(size) = scaled {
        format!("scale=w='{}':h=-2,setsar=1", size.width_expression())
    } else {
        // Already at the export resolution, so the only thing left to say is
        // that the pixels are square and the height is even — 4:2:0 chroma
        // cannot express an odd number of rows, and an odd height is a hard
        // encoder failure rather than a slightly wrong picture.
        "scale=w=iw:h=-2,setsar=1".to_string()
    }
}

/// Forward, then backwards, with no frame shown twice (PRD §4.5).
///
/// The two `trim`s are the seam. A naive `[a][reverse]concat` plays the last
/// frame twice at the turn and the first frame twice at the wrap, which is
/// exactly the stutter rewind exists to avoid. Dropping frame 0 before
/// reversing and frame 0 again after it leaves the reversed half as frames
/// `N-2 … 1`, so the whole loop reads `0 … N-1, N-2 … 1` and then back to `0`:
/// every frame once, in both directions.
///
/// `reverse` buffers the decoded stream in memory, which is why this is only
/// ever pointed at a hero clip of a few seconds.
fn ping_pong_graph(scaled: Option<ExportSize>) -> String {
    format!(
        "[0:v]{scale},split[a][b];\
         [b]trim=start_frame=1,setpts=PTS-STARTPTS,reverse,\
         trim=start_frame=1,setpts=PTS-STARTPTS[r];\
         [a][r]concat=n=2:v=1[out]",
        scale = geometry_filter(scaled)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ALL: Formats = Formats {
        mp4: true,
        webm: true,
        poster: true,
    };

    fn clip() -> Input {
        Input::Source(PathBuf::from("/projects/atlas/assets/gen-1.mp4"))
    }

    fn still() -> Input {
        Input::Source(PathBuf::from("/projects/atlas/assets/gen-1.png"))
    }

    /// What a bake hands back: frames already at the export resolution.
    fn treated_frames() -> Input {
        Input::TreatedFrames {
            pattern: "out-%06d.png".to_string(),
            fps: 24.0,
        }
    }

    fn args_for(plan: &Plan, deliverable: Deliverable) -> Vec<String> {
        plan.steps
            .iter()
            .find(|step| step.deliverable == deliverable)
            .expect("the plan should hold that deliverable")
            .args
            .clone()
    }

    #[test]
    fn a_clip_produces_the_three_files_prd_8_promises() {
        let plan = plan(
            &clip(),
            "atlas-hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();

        let names: Vec<&str> = plan.steps.iter().map(|s| s.file_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["atlas-hero.mp4", "atlas-hero.webm", "atlas-hero-poster.jpg"]
        );
    }

    #[test]
    fn only_what_was_asked_for_is_encoded() {
        let plan = plan(
            &clip(),
            "atlas-hero",
            Formats {
                mp4: false,
                webm: true,
                poster: false,
            },
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();

        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].deliverable, Deliverable::WebM);
    }

    #[test]
    fn asking_for_nothing_is_a_named_refusal_rather_than_an_empty_run() {
        let outcome = plan(
            &clip(),
            "atlas-hero",
            Formats {
                mp4: false,
                webm: false,
                poster: false,
            },
            false,
            Medium::Clip,
            ExportSize::Web,
        );

        assert!(matches!(outcome, Err(ExportError::NothingRequested)));
    }

    /// A styled still is a legitimate final deliverable (#31), and the poster is
    /// what it delivers. Asking a picture for an MP4 is the caller's mistake and
    /// is named as one rather than producing a one-frame video.
    #[test]
    fn a_still_exports_its_poster_and_refuses_a_clip() {
        let poster_only = Formats {
            mp4: false,
            webm: false,
            poster: true,
        };
        let plan = plan(
            &still(),
            "atlas-hero",
            poster_only,
            false,
            Medium::Still,
            ExportSize::Web,
        )
        .unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].file_name, "atlas-hero-poster.jpg");

        let refused = plan_video_from(&still());
        assert!(matches!(refused, Err(ExportError::NotAClip)));
    }

    fn plan_video_from(source: &Input) -> Result<Plan, ExportError> {
        plan(
            source,
            "atlas-hero",
            Formats {
                mp4: true,
                webm: false,
                poster: false,
            },
            false,
            Medium::Still,
            ExportSize::Web,
        )
    }

    #[test]
    fn the_mp4_is_web_ready_rather_than_merely_encoded() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::Mp4,
        );

        // Quality-targeted rather than bitrate-targeted, playable before it has
        // finished downloading, and in the pixel format every browser decodes.
        assert!(args.windows(2).any(|w| w == ["-crf", H264_CRF]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
        assert!(args.contains(&"-an".to_string()));
    }

    #[test]
    fn the_webm_pairs_its_crf_with_the_flag_that_makes_it_mean_quality() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::WebM,
        );

        assert!(args.windows(2).any(|w| w == ["-c:v", "libvpx-vp9"]));
        assert!(args.windows(2).any(|w| w == ["-crf", VP9_CRF]));
        // Without this VP9 treats the CRF as a ceiling and targets a bitrate of
        // zero, which is a file with nothing in it.
        assert!(args.windows(2).any(|w| w == ["-b:v", "0"]));
    }

    #[test]
    fn every_deliverable_is_capped_at_the_web_width_on_even_dimensions() {
        let plan = plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap();

        for step in &plan.steps {
            let filters = step.args.join(" ");
            assert!(
                filters.contains(&format!("min({MAX_WEB_WIDTH},iw)")),
                "{:?} is not capped",
                step.deliverable
            );
            // `-2`, not `-1`: an odd height is a hard failure in 4:2:0.
            assert!(
                filters.contains("h=-2"),
                "{:?} may go odd",
                step.deliverable
            );
        }
    }

    #[test]
    fn the_poster_is_a_single_frame() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::Poster,
        );

        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(args.windows(2).any(|w| w == ["-q:v", POSTER_QUALITY]));
    }

    #[test]
    fn rewind_plays_the_clip_forward_then_backwards() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, true, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::Mp4,
        );

        let graph = args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .map(|at| args[at + 1].clone())
            .expect("rewind should build a filter graph");

        assert!(graph.contains("reverse"));
        assert!(graph.contains("concat=n=2:v=1"));
        // Both ends of the reversed half are dropped, or the turn and the wrap
        // each show a frame twice — the seam rewind exists to avoid.
        assert_eq!(graph.matches("trim=start_frame=1").count(), 2);
    }

    #[test]
    fn without_rewind_nothing_is_reversed() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::Mp4,
        );

        assert!(!args.iter().any(|arg| arg.contains("reverse")));
        assert!(args.contains(&"-vf".to_string()));
    }

    /// The poster is the first frame of the forward pass either way, so it never
    /// pays for a reverse it does not use — and a rewound export's poster is the
    /// same picture as a plain one's.
    #[test]
    fn the_poster_never_reverses_even_when_the_clip_does() {
        let args = args_for(
            &plan(&clip(), "hero", ALL, true, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::Poster,
        );

        assert!(!args.iter().any(|arg| arg.contains("reverse")));
    }

    /// Rewind is a question about time, and a picture has none. Accepting the
    /// flag on a still would build a graph `reverse` cannot run.
    #[test]
    fn rewind_is_ignored_on_a_still() {
        let args = args_for(
            &plan(
                &still(),
                "hero",
                Formats {
                    mp4: false,
                    webm: false,
                    poster: true,
                },
                true,
                Medium::Still,
                ExportSize::Web,
            )
            .unwrap(),
            Deliverable::Poster,
        );

        assert!(!args.iter().any(|arg| arg.contains("reverse")));
    }

    #[test]
    fn a_treated_clip_encodes_from_its_frames_at_its_own_rate() {
        // #36's bake. The frames are already at the export resolution, so the
        // rate has to come with them or the clip is re-timed to whatever ffmpeg
        // assumes for an image sequence.
        let plan = plan(
            &treated_frames(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();
        let args = args_for(&plan, Deliverable::Mp4);

        assert!(args.windows(2).any(|w| w == ["-framerate", "24"]));
        assert!(args.contains(&"out-%06d.png".to_string()));
    }

    #[test]
    fn the_scale_is_how_much_bigger_than_the_web_width_it_ended_up() {
        // The look is defined at the web width; the shader divides its pattern
        // coordinates by this, so getting it wrong is a treatment that changes
        // density when the size changes — which is the one thing #58 settled
        // that it must not do.
        assert_eq!(ExportSize::Web.pattern_scale(1920), 1.0);
        assert_eq!(ExportSize::Web.pattern_scale(1280), 1.0);
        assert_eq!(ExportSize::Double.pattern_scale(3840), 2.0);
        assert_eq!(ExportSize::Double.pattern_scale(2560), 2.0);
        // Native is the one size that can land on a fraction, and it is kept
        // rather than rounded: 1.333 is what a nearest-neighbour magnification
        // by 1.333 costs, and both ways of rounding it away ship something
        // other than what the preview showed.
        assert_eq!(ExportSize::Native.pattern_scale(2560), 2560.0 / 1920.0);
        // A source that was never over the cap is not scaled at all, so Native
        // and Web are the same export rather than two names for it.
        assert_eq!(ExportSize::Native.pattern_scale(1280), 1.0);
        // Which is every clip there is: the animate models cap at 720p, so a
        // fractional scale is a treated *still* from an oversized style
        // candidate and nothing else.
        assert_eq!(ExportSize::Native.pattern_scale(1920), 1.0);
    }

    #[test]
    fn every_size_delivers_an_even_width_whatever_the_source_is() {
        // 4:2:0 chroma cannot express an odd number of columns any more than an
        // odd number of rows, and libx264 refuses the encode rather than
        // delivering a slightly wrong picture. The cap hid this while it was the
        // only expression here — 1920 is even — and `iw` exposes it for every
        // width a model cares to return.
        for size in [ExportSize::Web, ExportSize::Native, ExportSize::Double] {
            let expression = size.width_expression();
            assert!(
                expression.starts_with("trunc(") && expression.ends_with("/2)*2"),
                "{size:?} can deliver an odd width: {expression}"
            );

            // And the treated path lands on the same number, or turning a
            // treatment on would resize the deliverable by a pixel.
            for source in [1919u32, 1921, 2561, 3841] {
                let (width, _) = super::super::bake::shipped_size(source, 1080, size);
                assert_eq!(width % 2, 0, "{size:?} at {source} gave an odd width");
            }
        }
    }

    #[test]
    fn a_native_export_delivers_the_pixels_the_model_returned() {
        // The cap is a default rather than a law (#58): asked for native, the
        // untreated path stops capping instead of capping somewhere else.
        let plan = plan(
            &clip(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Native,
        )
        .unwrap();

        for step in &plan.steps {
            let filters = step.args.join(" ");
            assert!(
                !filters.contains(&format!("min({MAX_WEB_WIDTH},iw)")),
                "{:?} was still capped",
                step.deliverable
            );
            assert!(
                filters.contains("scale=w='trunc(iw/2)*2'"),
                "{:?}",
                step.deliverable
            );
            assert!(filters.contains("h=-2"), "{:?}", step.deliverable);
        }
    }

    #[test]
    fn an_untreated_export_is_never_upscaled_however_it_is_asked() {
        // 2x buys a pattern drawn at the output grid. With no pattern there is
        // nothing to draw, so the same request delivers the source's own size —
        // the panel does not offer this combination, and this is the half of
        // that which cannot be routed around.
        let plan = plan(
            &clip(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Double,
        )
        .unwrap();

        for step in &plan.steps {
            let filters = step.args.join(" ");
            assert!(
                !filters.contains(&format!("min({MAX_WEB_WIDTH},iw)")),
                "{:?} was upscaled with nothing to sharpen",
                step.deliverable
            );
            assert!(
                filters.contains("scale=w='trunc(iw/2)*2'"),
                "{:?}",
                step.deliverable
            );
        }
    }

    #[test]
    fn a_treated_export_is_not_scaled_a_second_time() {
        // The pattern was rendered at the export resolution; scaling it again
        // is what destroys the cell size the user dialled in.
        for step in &plan(
            &treated_frames(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap()
        .steps
        {
            let filters = step.args.join(" ");
            assert!(
                !filters.contains(&format!("min({MAX_WEB_WIDTH},iw)")),
                "{:?} was capped a second time",
                step.deliverable
            );
            // Still even, and still square pixels — those are properties of the
            // encode rather than of the scaling.
            assert!(
                filters.contains("h=-2"),
                "{:?} may go odd",
                step.deliverable
            );
            assert!(filters.contains("setsar=1"), "{:?}", step.deliverable);
        }
    }

    #[test]
    fn the_size_a_treated_export_was_asked_for_changes_nothing_here() {
        // Treated frames arrive at the size the shader drew them, whatever that
        // was, so the chosen size has already been spent by the time these
        // arguments are built. A scale filter reappearing here would resize the
        // frames the bake just rendered at the right size.
        for size in [ExportSize::Web, ExportSize::Native, ExportSize::Double] {
            let plan = plan(&treated_frames(), "hero", ALL, false, Medium::Clip, size).unwrap();
            for step in &plan.steps {
                let filters = step.args.join(" ");
                assert!(
                    filters.contains("scale=w=iw:h=-2"),
                    "{:?} at {size:?} was rescaled",
                    step.deliverable
                );
            }
        }
    }

    #[test]
    fn the_webview_agrees_about_how_wide_a_deliverable_is() {
        // The preview draws the pattern at the size the file will be, so it has
        // to know this number, and asking Rust for a constant once per frame
        // would be absurd. Mirrored means it can drift — and drift here is
        // silent: the preview would simply show a pattern at a density the
        // export does not have, which is the exact bug the mirroring is for.
        let mirrored = include_str!("../../../src/lib/export/deliverables.ts");
        let line = mirrored
            .lines()
            .find(|line| line.contains("MAX_EXPORT_WIDTH ="))
            .expect("the mirrored width in deliverables.ts");

        assert!(
            line.contains(&MAX_WEB_WIDTH.to_string()),
            "the webview caps exports at a different width: {line}"
        );
    }

    #[test]
    fn a_treated_webm_keeps_its_colour_at_full_resolution() {
        // The bug this is here for: a two-ink dither through 4:2:0 averages
        // into one wrong colour, because the inks differ in chroma and 4:2:0
        // keeps one chroma sample per four pixels. Measured on a Bayer ramp,
        // 21% of pixels landed near an ink at 4:2:0 against 100% at 4:4:4.
        let treated = args_for(
            &plan(
                &treated_frames(),
                "hero",
                ALL,
                false,
                Medium::Clip,
                ExportSize::Web,
            )
            .unwrap(),
            Deliverable::WebM,
        );
        assert!(treated.windows(2).any(|w| w == ["-pix_fmt", "yuv444p"]));

        // Untreated output is photographic, where subsampling is invisible and
        // 4:4:4 would be bytes for nothing.
        let plain = args_for(
            &plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap(),
            Deliverable::WebM,
        );
        assert!(plain.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
    }

    #[test]
    fn a_treated_mp4_stays_in_the_format_browsers_decode() {
        // Deliberately *not* fixed the way the WebM is. H.264 at 4:4:4 means
        // High 4:4:4 Predictive, which no browser decodes — the dither would
        // survive into a file the landing page cannot play. This is the one
        // deliverable that always plays, and it is allowed to be the soft one.
        let args = args_for(
            &plan(
                &treated_frames(),
                "hero",
                ALL,
                false,
                Medium::Clip,
                ExportSize::Web,
            )
            .unwrap(),
            Deliverable::Mp4,
        );

        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]));
    }

    #[test]
    fn a_treated_poster_is_a_png_and_an_untreated_one_is_a_jpeg() {
        // JPEG subsamples chroma exactly as 4:2:0 does. On a two-ink dither the
        // PNG came back pixel-exact at 24 KB where the JPEG was 1.75 MB and
        // still wrong — smaller *and* correct, which is why this is not a
        // trade-off that needs a setting.
        let treated = plan(
            &treated_frames(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();
        let poster = treated
            .steps
            .iter()
            .find(|step| step.deliverable == Deliverable::Poster)
            .unwrap();

        assert_eq!(poster.file_name, "hero-poster.png");
        // A quality scale on a lossless format is a knob attached to nothing.
        assert!(!poster.args.iter().any(|arg| arg == "-q:v"));

        let plain = plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap();
        let plain_poster = plain
            .steps
            .iter()
            .find(|step| step.deliverable == Deliverable::Poster)
            .unwrap();

        assert_eq!(plain_poster.file_name, "hero-poster.jpg");
        assert!(plain_poster
            .args
            .windows(2)
            .any(|w| w == ["-q:v", POSTER_QUALITY]));
    }

    #[test]
    fn every_deliverable_carries_the_treatment() {
        // A clean poster advertising a dithered video is a lie about the file
        // it represents — the poster is one more frame through the same shader,
        // so it comes out of the same treated sequence.
        let plan = plan(
            &treated_frames(),
            "hero",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();

        assert_eq!(plan.steps.len(), 3);
        for step in &plan.steps {
            assert!(
                step.args.contains(&"out-%06d.png".to_string()),
                "{:?} read something else",
                step.deliverable
            );
        }
    }

    #[test]
    fn a_treated_still_exports_its_poster_from_the_treated_frame() {
        let treated = Input::TreatedStill(PathBuf::from("/tmp/bake/treated-000000.png"));
        let poster_only = Formats {
            mp4: false,
            webm: false,
            poster: true,
        };

        let plan = plan(
            &treated,
            "hero",
            poster_only,
            false,
            Medium::Still,
            ExportSize::Web,
        )
        .unwrap();
        let args = args_for(&plan, Deliverable::Poster);

        assert!(args.contains(&"/tmp/bake/treated-000000.png".to_string()));
        assert!(!args.join(" ").contains(&format!("min({MAX_WEB_WIDTH},iw)")));
    }

    #[test]
    fn rewind_still_works_on_a_treated_clip() {
        let args = args_for(
            &plan(
                &treated_frames(),
                "hero",
                ALL,
                true,
                Medium::Clip,
                ExportSize::Web,
            )
            .unwrap(),
            Deliverable::Mp4,
        );
        let graph = args
            .iter()
            .position(|arg| arg == "-filter_complex")
            .map(|at| args[at + 1].clone())
            .expect("rewind should build a filter graph");

        assert!(graph.contains("reverse"));
        assert!(!graph.contains(&format!("min({MAX_WEB_WIDTH},iw)")));
    }

    #[test]
    fn an_existing_export_of_the_same_candidate_is_replaced_rather_than_refused() {
        let plan = plan(&clip(), "hero", ALL, false, Medium::Clip, ExportSize::Web).unwrap();

        for step in &plan.steps {
            assert_eq!(step.args.first().map(String::as_str), Some("-y"));
        }
    }

    /// The steps run with the destination as their working directory, so a name
    /// carrying a separator would write outside the folder the user picked.
    #[test]
    fn a_name_cannot_leave_the_folder_it_was_exported_to() {
        let plan = plan(
            &clip(),
            "../../etc/passwd",
            ALL,
            false,
            Medium::Clip,
            ExportSize::Web,
        )
        .unwrap();

        for step in &plan.steps {
            assert!(!step.file_name.contains('/'));
            assert!(!step.file_name.contains(".."));
        }
    }

    #[test]
    fn a_project_name_becomes_a_file_name_rather_than_being_refused() {
        assert_eq!(safe_base_name("Atlas / hero"), "Atlas-hero");
        assert_eq!(safe_base_name("  spaced  out  "), "spaced-out");
        assert_eq!(safe_base_name("hero_2 — final"), "hero_2-final");
        // Nothing legal left is still a file, rather than a dotfile called
        // `.mp4` that Finder will not show anyone.
        assert_eq!(safe_base_name("／／"), "export");
        assert_eq!(safe_base_name(""), "export");
    }

    #[test]
    fn a_file_says_what_it_is_from_its_extension() {
        assert_eq!(medium_of(Path::new("a/gen-1.mp4")), Medium::Clip);
        assert_eq!(medium_of(Path::new("a/gen-1.WEBM")), Medium::Clip);
        assert_eq!(medium_of(Path::new("a/gen-1.png")), Medium::Still);
        assert_eq!(medium_of(Path::new("a/gen-1.jpeg")), Medium::Still);
        // No extension at all is a picture as far as this is concerned — the
        // safe way round, since the refusal it triggers costs nothing and a
        // wrongly-assumed clip would be a graph ffmpeg cannot run.
        assert_eq!(medium_of(Path::new("a/gen-1")), Medium::Still);
    }
}
