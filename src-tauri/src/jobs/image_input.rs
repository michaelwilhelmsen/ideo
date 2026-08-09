//! Getting the input image to fal (#28).
//!
//! Nothing restyles until the source reaches the provider, and `docs/research/
//! models-gaps.md` settled how: **inline base64 data URI**, because it is the one
//! transfer confirmed to work against every image field surveyed, and because
//! the two-step storage upload's wire protocol is still unverified. If hero-size
//! payloads ever blow the ceiling, that upload lands behind this same seam.
//!
//! Two things are deliberate about where the bytes travel. They never touch the
//! webview: the frontend names a *generation*, and Rust — the side that already
//! owns the project folder and the API key — resolves it to a file and encodes
//! it. And they are injected after the registry's parameters are built, so the
//! request body still comes from the one capability table (PRD §5) while the
//! field's *value* comes from the side holding the disk.
//!
//! The other half of this module is a refusal. On `nano-banana-*/edit` the
//! `image_urls` field is not required, so a style run with no source would not
//! fail — it would quietly succeed as text-to-image, charge for it, and hand back
//! a picture of something else entirely. So a style submit with no resolvable
//! input is rejected here, before the key is fetched and long before the charge.
//!
//! Since #29 the animate stage is under the same rule, and the argument only
//! gets stronger: a video model handed no start frame produces a clip of
//! whatever the motion prompt says, at up to $0.47 a second.
//!
//! And since #30 a run may name more than one image field, because that is what
//! a seamless loop is: the same still as both the first and the last frame (PRD
//! §4.5). The list is the frontend's — which fields exist and what they are
//! called is the registry's business, not this side's — and the only thing this
//! module adds is that a still named twice is read and encoded once.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;

use super::fal::{GenerationError, GenerationErrorReason, InputImageProblem};
use crate::projects::import::sniff_format;
use crate::projects::store::asset_path;

/// The stages that transform somebody else's image, and therefore cannot run
/// without one: style restyles a source, animate moves a still.
///
/// Matched as strings because the stage crosses the boundary as one — the
/// vocabulary is the frontend's (`StageKind`), not Rust's. Listed rather than
/// inverted from `source` so that a stage added later has to be thought about
/// once rather than inheriting a refusal nobody chose for it.
const INPUT_STAGES: [&str; 2] = ["style", "animate"];

fn requires_input(stage: &str) -> bool {
    INPUT_STAGES.contains(&stage)
}

/// The ceiling on an inlined image.
///
/// `models-gaps.md` §4 found no documented limit for a base64 payload; 10 MB raw
/// is the largest input any surveyed model accepts (Kling's own cap), and it
/// becomes ~13.3 MB once encoded. Above that a submit is worth refusing locally
/// rather than discovering as a 4xx from a body we chose to send.
const MAX_INLINE_BYTES: u64 = 10 * 1024 * 1024;

/// How a model's image field is shaped — the one thing knowing its *name* does
/// not tell you.
///
/// The style stage splits on this: the FLUX family takes a single `image_url`
/// string, Qwen and Nano Banana take an `image_urls` **array**. A string where an
/// array is required is a 422 at the paid step with no visual signal that the
/// parameter shape, rather than the prompt, was the problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImageParamShape {
    Url,
    UrlArray,
}

/// Which image goes where, as the frontend names it.
///
/// The generation id rather than a path or bytes: the frontend knows *which
/// candidate* the stage is working from and nothing about the folder, and the
/// field name and shape are the registry's answer (PRD §5) rather than
/// something Rust should hold a second copy of.
///
/// One of these per *field*, not per image — a loop names the same generation
/// twice, under `imageParam` and under `endFrameParam` (#30).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub generation_id: String,
    /// The model's own field name, from the registry's `imageParam` or
    /// `endFrameParam`.
    pub param: String,
    pub shape: ImageParamShape,
}

/// Puts the input images into a request body, or refuses the run.
///
/// Called before the key is fetched and before a concurrency slot is taken: a
/// run that cannot find its source is not worth a keychain prompt, let alone a
/// queue position.
///
/// A list rather than one image since #30: a seamless loop is the *same* still
/// sent twice, once as the start frame and once as the end frame under whatever
/// the model calls it (`end_image_url`, or `last_frame_url` on Veo). Which
/// fields those are is the registry's answer and arrives already decided; all
/// this side does is resolve each named generation and write it in.
///
/// Each generation is read and encoded **once** however many fields point at
/// it. A hero still is megabytes before base64 and a third again after, so
/// encoding the loop's two frames separately would double both the work and the
/// memory — and, worse, would measure the same file twice against the inline
/// ceiling, refusing a 6 MB still that is well inside it.
pub fn prepare(
    root: &Path,
    project_id: &str,
    stage: &str,
    inputs: &[ImageInput],
    params: &mut Value,
) -> Result<(), GenerationError> {
    if inputs.is_empty() {
        // Not "assume text-to-image": these stages exist to transform an image,
        // so having none is the failure and not a mode.
        if requires_input(stage) {
            log::error!("a {stage} run for project {project_id} named no input image");
            return Err(unusable(InputImageProblem::NoneNamed));
        }
        return Ok(());
    }

    // Every refusal before any write, so a body is either fully prepared or
    // untouched: a request carrying a start frame and no end frame would be a
    // paid call for a clip that does not loop. That is why the field names are
    // checked here rather than inside `inject` — a blank second field would
    // otherwise fail *after* the first one had been written in.
    check(inputs, params)?;
    let encoded = encode_once(root, project_id, inputs)?;

    let Some(fields) = params.as_object_mut() else {
        // Unreachable: `check` refused a non-object above.
        return Err(not_an_object());
    };

    for input in inputs {
        let Some(uri) = encoded.get(input.generation_id.as_str()) else {
            // Unreachable: `encode_once` has an entry per named generation.
            return Err(GenerationError::with_detail(
                GenerationErrorReason::RequestRejected,
                "an input image was named but never encoded",
            ));
        };
        inject(fields, input, uri);
    }

    Ok(())
}

/// Everything that can refuse the run before a single byte is read.
///
/// Split out so injection cannot fail halfway. The two answers here are the
/// only ones `inject` used to give, and both are about the *request* rather
/// than the images: a body that is not an object has nowhere to put a field,
/// and a field with no name is a registry row that never should have shipped.
fn check(inputs: &[ImageInput], params: &Value) -> Result<(), GenerationError> {
    if !params.is_object() {
        return Err(not_an_object());
    }

    for input in inputs {
        if input.param.trim().is_empty() {
            log::error!("The model named no field to put the image in");
            return Err(unusable(InputImageProblem::NoField));
        }
    }

    Ok(())
}

fn not_an_object() -> GenerationError {
    GenerationError::with_detail(
        GenerationErrorReason::RequestRejected,
        "model parameters were not an object",
    )
}

/// Each named generation as a data URI, one entry per *generation* rather than
/// per field.
///
/// The deduplication is the point rather than an optimisation. A loop names one
/// still under two fields (#30); reading it twice would hold two copies of a
/// hero-size image and two base64 strings a third larger again, and would put
/// the same file past the inline ceiling on the second pass of a size check it
/// had already passed.
fn encode_once<'a>(
    root: &Path,
    project_id: &str,
    inputs: &'a [ImageInput],
) -> Result<HashMap<&'a str, String>, GenerationError> {
    let mut encoded: HashMap<&'a str, String> = HashMap::new();

    for input in inputs {
        let id = input.generation_id.as_str();
        if !encoded.contains_key(id) {
            encoded.insert(id, data_uri(&read_image(root, project_id, id)?)?);
        }
    }

    Ok(encoded)
}

/// The image one generation produced, as bytes.
fn read_image(
    root: &Path,
    project_id: &str,
    generation_id: &str,
) -> Result<Vec<u8>, GenerationError> {
    let path = asset_path(root, project_id, generation_id)
        .map_err(|e| {
            log::error!("Could not look for the input image of {generation_id}: {e}");
            unusable(InputImageProblem::Unreadable)
        })?
        .ok_or_else(|| {
            log::error!("Generation {generation_id} has no image on disk");
            unusable(InputImageProblem::NotOnDisk)
        })?;

    // Before the read, not after: the point of a ceiling is that the oversized
    // file is never held in memory.
    let size = std::fs::metadata(&path)
        .map_err(|e| {
            log::error!("Could not measure the input image {}: {e}", path.display());
            unusable(InputImageProblem::Unreadable)
        })?
        .len();

    if size > MAX_INLINE_BYTES {
        log::error!(
            "The input image {} is {size} bytes, over the {MAX_INLINE_BYTES} an inlined image may be",
            path.display()
        );
        return Err(unusable(InputImageProblem::TooLarge {
            bytes: size as f64,
            limit: MAX_INLINE_BYTES as f64,
        }));
    }

    std::fs::read(&path).map_err(|e| {
        log::error!("Could not read the input image {}: {e}", path.display());
        unusable(InputImageProblem::Unreadable)
    })
}

/// A `data:<mime>;base64,…` URI, with the media type read from the bytes.
///
/// Sniffed rather than taken from the extension, exactly as the import does: a
/// `.png` holding a JPEG would otherwise be announced to fal as something it is
/// not, which is a 4xx on a body we chose.
fn data_uri(bytes: &[u8]) -> Result<String, GenerationError> {
    if bytes.is_empty() {
        log::error!("The input image file holds no bytes");
        return Err(unusable(InputImageProblem::Unreadable));
    }

    let format = sniff_format(bytes).ok_or_else(|| {
        log::error!("The input image is not a PNG, JPEG or WebP");
        unusable(InputImageProblem::UnsupportedFormat)
    })?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(format!("data:{};base64,{encoded}", format.mime()))
}

/// Writes the URI into the body under the model's own field name and shape.
///
/// Infallible, which is the whole of the atomicity claim: everything that could
/// refuse has already refused in `check`, so once the first field is written
/// the rest are certain to follow.
fn inject(fields: &mut Map<String, Value>, input: &ImageInput, uri: &str) {
    let value = match input.shape {
        ImageParamShape::Url => json!(uri),
        ImageParamShape::UrlArray => json!([uri]),
    };

    // Overwrites rather than merges: whatever a persisted draft claimed about
    // this field, the image being sent is the one the stage is working from.
    fields.insert(input.param.clone(), value);
}

/// The refusal, as a code the frontend can put into the user's own language.
///
/// The particulars are logged at each call site rather than attached: a path or
/// an `io::Error` is for whoever reads the log, and putting it in front of the
/// user would be an English sentence no locale file can reach (PRD §10.4).
fn unusable(problem: InputImageProblem) -> GenerationError {
    GenerationError::unusable_input(problem)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A real 1×1 PNG header — enough for the sniffer to agree it is one.
    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    fn input(param: &str, shape: ImageParamShape) -> ImageInput {
        ImageInput {
            generation_id: "gen-src-1".to_string(),
            param: param.to_string(),
            shape,
        }
    }

    /// A project folder holding one source image, as either stage would find it.
    fn project_with_source(bytes: &[u8], extension: &str) -> TempDir {
        let root = TempDir::new().unwrap();
        let dir = root.path().join("atlas").join("assets");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("gen-src-1.{extension}")), bytes).unwrap();
        root
    }

    #[test]
    fn a_png_becomes_a_data_uri_naming_its_own_media_type() {
        let uri = data_uri(&png()).unwrap();

        assert!(uri.starts_with("data:image/png;base64,"), "got: {uri}");
        // Round-trips: what fal decodes has to be the file, byte for byte.
        let encoded = uri.split_once("base64,").unwrap().1;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, png());
    }

    #[test]
    fn the_media_type_comes_from_the_bytes_and_not_the_extension() {
        // A JPEG saved as `.png` announced as `image/png` is a 4xx on a body we
        // chose to send.
        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0];

        assert!(data_uri(&jpeg).unwrap().starts_with("data:image/jpeg;"));
    }

    #[test]
    fn something_that_is_not_an_image_is_refused_rather_than_encoded() {
        // A code rather than a sentence, so the frontend can say it in the
        // user's language — and a *different* code per cause, or the message
        // could only ever be the vaguest of the three.
        let refused = data_uri(b"%PDF-1.4").unwrap_err();
        assert_eq!(refused.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(
            refused.input_image,
            Some(InputImageProblem::UnsupportedFormat)
        );
        assert_eq!(refused.detail, None, "no English crosses the boundary");

        assert_eq!(
            data_uri(b"").unwrap_err().input_image,
            Some(InputImageProblem::Unreadable)
        );
    }

    #[test]
    fn a_single_url_model_gets_a_string() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "strength": 0.7 });

        prepare(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .unwrap();

        assert!(params["image_url"].is_string());
        assert!(params["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        // Everything the registry built is left alone.
        assert_eq!(params["strength"], json!(0.7));
    }

    #[test]
    fn an_array_model_gets_a_one_element_array() {
        // A string where Qwen and Nano Banana require an array is a 422 at the
        // one step that costs money.
        let root = project_with_source(&png(), "png");
        let mut params = json!({});

        prepare(
            root.path(),
            "atlas",
            "style",
            &[input("image_urls", ImageParamShape::UrlArray)],
            &mut params,
        )
        .unwrap();

        let urls = params["image_urls"].as_array().expect("an array");
        assert_eq!(urls.len(), 1);
        assert!(urls[0].as_str().unwrap().starts_with("data:image/png;"));
    }

    #[test]
    fn whatever_a_draft_claimed_about_the_image_field_is_replaced() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "image_url": "https://example.invalid/stale.png" });

        prepare(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .unwrap();

        assert!(params["image_url"].as_str().unwrap().starts_with("data:"));
    }

    #[test]
    fn a_style_run_with_no_input_is_refused_before_anything_is_spent() {
        // The reason this is a hard failure rather than a fallback: on
        // `nano-banana-*/edit` the image field is optional, so a missing source
        // would silently degrade to text-to-image and charge for it.
        let mut params = json!({});

        let error = prepare(Path::new("/nowhere"), "atlas", "style", &[], &mut params)
            .expect_err("a style run needs an input image");

        assert_eq!(error.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(error.input_image, Some(InputImageProblem::NoneNamed));
        assert_eq!(params, json!({}));
    }

    #[test]
    fn an_animate_run_with_no_still_is_refused_before_anything_is_spent() {
        // #29 — the same refusal as style, and the money at stake is larger: a
        // video model handed no start frame animates the motion prompt instead,
        // at up to $0.47 a second.
        let mut params = json!({ "duration": "5" });

        let error = prepare(Path::new("/nowhere"), "atlas", "animate", &[], &mut params)
            .expect_err("an animate run needs a still to animate");

        assert_eq!(error.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(error.input_image, Some(InputImageProblem::NoneNamed));
        assert_eq!(params, json!({ "duration": "5" }));
    }

    #[test]
    fn the_still_reaches_a_video_model_under_whichever_name_it_uses() {
        // Three spellings across the eight endpoints — `image_url`,
        // `start_image_url`, `first_frame_url` — all single URLs, and the
        // registry is the only thing that knows which is which.
        for param in ["image_url", "start_image_url", "first_frame_url"] {
            let root = project_with_source(&png(), "png");
            let mut params = json!({ "duration": "5" });

            prepare(
                root.path(),
                "atlas",
                "animate",
                &[input(param, ImageParamShape::Url)],
                &mut params,
            )
            .unwrap();

            assert!(
                params[param]
                    .as_str()
                    .is_some_and(|uri| uri.starts_with("data:image/png;base64,")),
                "{param}"
            );
            assert_eq!(params["duration"], json!("5"), "{param}");
        }
    }

    /// #30 — the seamless loop, as it reaches the wire.
    ///
    /// The whole mechanism is "send the still twice", so these are the
    /// assertions that say it happened: both fields present, both holding the
    /// same picture, under the names the *chosen* model uses rather than a
    /// single spelling.
    #[test]
    fn a_loop_sends_the_same_still_as_both_the_first_and_the_last_frame() {
        // `end_image_url` on Kling, Seedance, Luma, LTX and FLUX 3;
        // `last_frame_url` on Veo. One start-frame spelling per row too.
        for (start, end) in [
            ("start_image_url", "end_image_url"),
            ("first_frame_url", "last_frame_url"),
        ] {
            let root = project_with_source(&png(), "png");
            let mut params = json!({ "duration": "5" });

            prepare(
                root.path(),
                "atlas",
                "animate",
                &[
                    input(start, ImageParamShape::Url),
                    input(end, ImageParamShape::Url),
                ],
                &mut params,
            )
            .unwrap();

            let first = params[start].as_str().expect("a start frame");
            let last = params[end].as_str().expect("an end frame");

            assert!(first.starts_with("data:image/png;base64,"), "{start}");
            // Byte for byte the same frame: a loop that ends on a *different*
            // encoding of the still is the seam this feature exists to remove.
            assert_eq!(first, last, "{start} and {end}");
            assert_eq!(params["duration"], json!("5"));
        }
    }

    #[test]
    fn a_still_at_the_ceiling_still_loops() {
        // The cap is on the file, not on the request: a 10 MB still sent as
        // both frames is one 10 MB read, and refusing it would refuse a loop
        // that is exactly inside the documented limit.
        let root = project_with_source(&png(), "png");
        let dir = root.path().join("atlas").join("assets");
        let mut at_the_limit = png();
        at_the_limit.resize(MAX_INLINE_BYTES as usize, 0);
        std::fs::write(dir.join("gen-src-1.png"), &at_the_limit).unwrap();

        let mut params = json!({});
        prepare(
            root.path(),
            "atlas",
            "animate",
            &[
                input("image_url", ImageParamShape::Url),
                input("end_image_url", ImageParamShape::Url),
            ],
            &mut params,
        )
        .expect("exactly at the ceiling is inside it");

        assert!(params["image_url"].is_string());
        assert!(params["end_image_url"].is_string());
    }

    #[test]
    fn each_field_takes_the_shape_its_own_schema_declares() {
        // The shape travels per field rather than per request, so a run naming
        // one single-URL field and one array-shaped one gets each as declared.
        // Generic names on purpose: this is a unit test of the injection, and
        // no registry row pairs an end frame with an array shape.
        let root = project_with_source(&png(), "png");
        let mut params = json!({});

        prepare(
            root.path(),
            "atlas",
            "style",
            &[
                input("image_url", ImageParamShape::Url),
                input("reference_image_urls", ImageParamShape::UrlArray),
            ],
            &mut params,
        )
        .unwrap();

        assert!(params["image_url"].is_string());
        let referenced = params["reference_image_urls"].as_array().expect("an array");
        assert_eq!(referenced.len(), 1);
        assert_eq!(
            referenced[0].as_str().unwrap(),
            params["image_url"].as_str().unwrap()
        );
    }

    #[test]
    fn nothing_is_injected_when_one_of_several_inputs_cannot_be_read() {
        // Every read happens before any write: half a loop is a paid call for a
        // clip that does not loop.
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "duration": "5" });

        let error = prepare(
            root.path(),
            "atlas",
            "animate",
            &[
                input("image_url", ImageParamShape::Url),
                ImageInput {
                    generation_id: "gen-missing".to_string(),
                    param: "end_image_url".to_string(),
                    shape: ImageParamShape::Url,
                },
            ],
            &mut params,
        )
        .expect_err("the end frame is not on disk");

        assert_eq!(error.input_image, Some(InputImageProblem::NotOnDisk));
        assert_eq!(params, json!({ "duration": "5" }));
    }

    #[test]
    fn a_source_run_has_no_input_and_that_is_not_a_failure() {
        let mut params = json!({ "image_size": { "width": 1280, "height": 720 } });

        prepare(Path::new("/nowhere"), "atlas", "source", &[], &mut params).unwrap();

        assert_eq!(params.as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_named_input_with_no_file_on_disk_is_refused() {
        // The candidate exists in the manifest but its job never landed, or the
        // folder was moved out from under us.
        let root = TempDir::new().unwrap();
        let mut params = json!({});

        let error = prepare(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .expect_err("there is no file to send");

        assert_eq!(error.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(error.input_image, Some(InputImageProblem::NotOnDisk));
        assert!(!params.as_object().unwrap().contains_key("image_url"));
    }

    #[test]
    fn an_oversized_input_is_refused_locally_rather_than_by_fal() {
        let root = project_with_source(&png(), "png");
        let dir = root.path().join("atlas").join("assets");
        let mut oversized = png();
        oversized.resize(MAX_INLINE_BYTES as usize + 1, 0);
        std::fs::write(dir.join("gen-src-1.png"), &oversized).unwrap();

        let mut params = json!({});
        let error = prepare(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .expect_err("too large to inline");

        assert_eq!(error.reason, GenerationErrorReason::InputImageUnusable);
        // The numbers travel too: "too large" is only actionable with the
        // ceiling next to it, and the frontend must not keep its own copy of a
        // limit this side enforces.
        assert_eq!(
            error.input_image,
            Some(InputImageProblem::TooLarge {
                bytes: (MAX_INLINE_BYTES + 1) as f64,
                limit: MAX_INLINE_BYTES as f64,
            })
        );
    }

    #[test]
    fn a_model_that_named_no_field_is_refused_rather_than_sent_a_blank_one() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({});

        let error = prepare(
            root.path(),
            "atlas",
            "style",
            &[input("  ", ImageParamShape::Url)],
            &mut params,
        )
        .unwrap_err();

        assert_eq!(error.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(error.input_image, Some(InputImageProblem::NoField));
        assert_eq!(params, json!({}));
    }

    #[test]
    fn a_blank_field_behind_a_good_one_still_leaves_the_body_untouched() {
        // The atomicity claim where it is easiest to break: the first field is
        // perfectly injectable, so a refusal discovered on the second must not
        // leave a start frame written in on its own — that body would be a paid
        // call for a clip that does not loop.
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "duration": "5" });

        let error = prepare(
            root.path(),
            "atlas",
            "animate",
            &[
                input("image_url", ImageParamShape::Url),
                input("", ImageParamShape::Url),
            ],
            &mut params,
        )
        .unwrap_err();

        assert_eq!(error.input_image, Some(InputImageProblem::NoField));
        assert_eq!(params, json!({ "duration": "5" }));
    }
}
