//! Getting the input image to fal (#28).
//!
//! Nothing restyles until the source reaches the provider. That was an inline
//! base64 data URI until #50 — the one transfer `models-gaps.md` could confirm
//! at the time — and it put the whole image *inside* the submit body. A
//! seamless loop names one still under two fields, so a styled PNG travelled
//! twice and made the body ~13 MB, which timed out before fal answered. The
//! bytes now go to fal's storage first (`super::storage`) and the body carries
//! two URLs, which cost the same whether there is one field or two.
//!
//! Two things are deliberate about where the bytes travel. They never touch the
//! webview: the frontend names a *generation*, and Rust — the side that already
//! owns the project folder and the API key — resolves it to a file and uploads
//! it. And the URLs are injected after the registry's parameters are built, so
//! the request body still comes from the one capability table (PRD §5) while
//! the field's *value* comes from the side holding the disk.
//!
//! The work is in two halves for one reason: **everything that can refuse must
//! refuse before the key is fetched**. `resolve` reads, shrinks and validates
//! with no key and no network, so a run that was never going to work costs no
//! keychain prompt; `attach` needs the key and does the uploading. Holding a
//! `ResolvedInputs` is the proof that the first half is done.
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
//! module adds is that a still named twice is read, shrunk and uploaded once.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;

use super::downscale;
use super::fal::{GenerationError, GenerationErrorReason, InputImageProblem};
use super::storage;
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

/// The ceiling on an input image, measured on the file as it sits on disk.
///
/// The number has not moved since #28 but its justification has, and #50 is
/// where that mattered. It used to be a guess about how large a base64 body
/// could get away with being; there is no body to overload now. What is left is
/// the real constraint underneath it: **10 MB is the largest input any surveyed
/// model accepts** — Kling's own documented cap — so a file over it is refused
/// by the model whatever route it takes to get there. Refusing here costs a
/// stat call; discovering it after an upload costs the upload.
///
/// Checked before `downscale::apply` rather than after, deliberately. A 40 MB
/// PNG would shrink to well under the cap, but the point of a ceiling is that
/// the oversized file is never decoded into memory in the first place.
const MAX_INPUT_BYTES: u64 = 10 * 1024 * 1024;

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

/// Reads what a run needs off disk, or refuses it.
///
/// Every refusal lives here, and here is before the key is fetched and before a
/// concurrency slot is taken: a run that cannot find its source is not worth a
/// keychain prompt, let alone a queue position. Nothing in this function
/// touches the network.
///
/// A list rather than one image since #30: a seamless loop is the *same* still
/// sent twice, once as the start frame and once as the end frame under whatever
/// the model calls it (`end_image_url`, or `last_frame_url` on Veo). Which
/// fields those are is the registry's answer and arrives already decided; all
/// this side does is resolve each named generation.
///
/// Each generation is read **once** however many fields point at it. That was
/// worth doing when it saved a second base64 encoding of a hero-size still; it
/// is worth more now that it saves a second upload, and it is still what stops
/// the same file being measured twice against the ceiling and refused at 6 MB.
pub fn resolve(
    root: &Path,
    project_id: &str,
    stage: &str,
    inputs: &[ImageInput],
    params: &Value,
) -> Result<ResolvedInputs, GenerationError> {
    if inputs.is_empty() {
        // Not "assume text-to-image": these stages exist to transform an image,
        // so having none is the failure and not a mode.
        if requires_input(stage) {
            log::error!("a {stage} run for project {project_id} named no input image");
            return Err(unusable(InputImageProblem::NoneNamed));
        }
        return Ok(ResolvedInputs::default());
    }

    // Every refusal before anything is sent, so a body is either fully prepared
    // or untouched: a request carrying a start frame and no end frame would be
    // a paid call for a clip that does not loop. That is why the field names
    // are checked here rather than inside `inject` — a blank second field would
    // otherwise fail *after* the first one had been written in.
    check(inputs, params)?;

    Ok(ResolvedInputs {
        images: read_once(root, project_id, inputs)?,
    })
}

/// Everything the run needs off disk, before a key has been fetched.
///
/// The point of the type is the ordering it enforces. Holding one of these
/// means every refusal has already happened — the file exists, it is a format
/// we know, it is inside the ceiling — so the keychain prompt and the upload
/// that follow are only reached by a run that was going to work.
#[derive(Debug, Default)]
pub struct ResolvedInputs {
    /// Generation id → the bytes to send for it, read and shrunk exactly once
    /// however many fields point at it.
    images: HashMap<String, Vec<u8>>,
}

/// Uploads each resolved image and writes the URLs into the body (#50).
///
/// The images travel here rather than inside the submit. A seamless loop names
/// one still under two fields, and a data URI would have put the whole encoded
/// image in the body twice; a URL is the same handful of bytes both times, so
/// the second field is free.
pub async fn attach(
    key: &str,
    inputs: &[ImageInput],
    resolved: ResolvedInputs,
    params: &mut Value,
) -> Result<(), GenerationError> {
    if resolved.images.is_empty() {
        return Ok(());
    }

    let mut urls: HashMap<String, String> = HashMap::new();
    for (id, bytes) in resolved.images {
        let name = upload_name(&id, &bytes);
        let url = storage::upload(key, bytes, &name).await?;
        urls.insert(id, url);
    }

    inject_urls(inputs, &urls, params)
}

/// Writes one URL per field, with no upload of its own.
///
/// Split from `attach` so the thing #30 actually promises — the same still
/// under both the first and the last frame — is provable without a network.
fn inject_urls(
    inputs: &[ImageInput],
    urls: &HashMap<String, String>,
    params: &mut Value,
) -> Result<(), GenerationError> {
    let Some(fields) = params.as_object_mut() else {
        // Unreachable: `check` refused a non-object in `resolve`.
        return Err(not_an_object());
    };

    for input in inputs {
        let Some(url) = urls.get(input.generation_id.as_str()) else {
            // Unreachable: there is an entry per named generation.
            return Err(GenerationError::with_detail(
                GenerationErrorReason::RequestRejected,
                "an input image was named but never uploaded",
            ));
        };
        inject(fields, input, url);
    }

    Ok(())
}

/// What the file is called once it is fal's.
///
/// The generation id, so a file in fal's storage can be traced back to the
/// candidate it came from, and an extension from the *sniffed* bytes — which
/// after `downscale::apply` is frequently no longer the extension on disk.
fn upload_name(generation_id: &str, bytes: &[u8]) -> String {
    let extension = sniff_format(bytes)
        .map(|format| format.extension())
        .unwrap_or("bin");

    format!("{generation_id}.{extension}")
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
fn read_once(
    root: &Path,
    project_id: &str,
    inputs: &[ImageInput],
) -> Result<HashMap<String, Vec<u8>>, GenerationError> {
    let mut images: HashMap<String, Vec<u8>> = HashMap::new();

    for input in inputs {
        let id = input.generation_id.as_str();
        if images.contains_key(id) {
            continue;
        }

        let bytes = downscale::apply(read_image(root, project_id, id)?);

        if bytes.is_empty() {
            log::error!("The input image file holds no bytes");
            return Err(unusable(InputImageProblem::Unreadable));
        }

        // Checked here rather than at upload time, and this is the last point
        // where it is free: past `resolve` the key has been fetched, so a
        // format we cannot name would cost a keychain prompt to discover.
        if sniff_format(&bytes).is_none() {
            log::error!("The input image is not a PNG, JPEG or WebP");
            return Err(unusable(InputImageProblem::UnsupportedFormat));
        }

        images.insert(id.to_string(), bytes);
    }

    Ok(images)
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

    if size > MAX_INPUT_BYTES {
        log::error!(
            "The input image {} is {size} bytes, over the {MAX_INPUT_BYTES} an inlined image may be",
            path.display()
        );
        return Err(unusable(InputImageProblem::TooLarge {
            bytes: size as f64,
            limit: MAX_INPUT_BYTES as f64,
        }));
    }

    std::fs::read(&path).map_err(|e| {
        log::error!("Could not read the input image {}: {e}", path.display());
        unusable(InputImageProblem::Unreadable)
    })
}

/// Writes the URL into the body under the model's own field name and shape.
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

    /// Where a fabricated upload puts things.
    const UPLOADED: &str = "https://v3.fal.media/files/test/";

    /// `resolve` plus injection, with the upload itself stubbed out.
    ///
    /// The upload is a network call, and none of these tests are about it. What
    /// they *are* about — which field gets which value, and that nothing is
    /// written into the body when anything refuses — is decided entirely on
    /// this side, so one fabricated URL per generation walks the same paths.
    ///
    /// One URL per *generation*, not per field, which is what makes the loop
    /// test below mean anything: two fields naming one still get one URL
    /// because there was one upload.
    fn resolve_and_attach(
        root: &Path,
        project_id: &str,
        stage: &str,
        inputs: &[ImageInput],
        params: &mut Value,
    ) -> Result<(), GenerationError> {
        let resolved = resolve(root, project_id, stage, inputs, params)?;
        if resolved.images.is_empty() {
            return Ok(());
        }

        let urls: HashMap<String, String> = resolved
            .images
            .iter()
            .map(|(id, bytes)| (id.clone(), format!("{UPLOADED}{}", upload_name(id, bytes))))
            .collect();

        inject_urls(inputs, &urls, params)
    }

    #[test]
    fn the_uploaded_name_comes_from_the_bytes_and_not_the_extension() {
        // A JPEG saved as `.png` uploaded as `.png` is served back announced as
        // something it is not. After `downscale::apply` this is the common case
        // rather than the odd one: a re-encoded PNG is a JPEG on a `.png` path.
        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0];

        assert_eq!(upload_name("gen-src-1", &jpeg), "gen-src-1.jpeg");
        assert_eq!(upload_name("gen-src-1", &png()), "gen-src-1.png");
    }

    #[test]
    fn something_that_is_not_an_image_is_refused_before_it_is_uploaded() {
        // A code rather than a sentence, so the frontend can say it in the
        // user's language — and a *different* code per cause, or the message
        // could only ever be the vaguest of the three.
        let root = project_with_source(b"%PDF-1.4", "png");
        let mut params = json!({});

        let refused = resolve_and_attach(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .expect_err("a PDF is not a source image");

        assert_eq!(refused.reason, GenerationErrorReason::InputImageUnusable);
        assert_eq!(
            refused.input_image,
            Some(InputImageProblem::UnsupportedFormat)
        );
        assert_eq!(refused.detail, None, "no English crosses the boundary");
        assert_eq!(params, json!({}), "nothing is written for a refused image");
    }

    #[test]
    fn an_empty_file_is_refused_as_unreadable_rather_than_uploaded_empty() {
        let root = project_with_source(b"", "png");
        let mut params = json!({});

        let refused = resolve_and_attach(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .expect_err("a file with nothing in it is not an image");

        assert_eq!(
            refused.input_image,
            Some(InputImageProblem::Unreadable),
            "an empty file is unreadable, not an unsupported format"
        );
    }

    #[test]
    fn a_single_url_model_gets_a_string() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "strength": 0.7 });

        resolve_and_attach(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .unwrap();

        assert!(params["image_url"].is_string());
        assert!(params["image_url"].as_str().unwrap().starts_with(UPLOADED));
        // Everything the registry built is left alone.
        assert_eq!(params["strength"], json!(0.7));
    }

    #[test]
    fn an_array_model_gets_a_one_element_array() {
        // A string where Qwen and Nano Banana require an array is a 422 at the
        // one step that costs money.
        let root = project_with_source(&png(), "png");
        let mut params = json!({});

        resolve_and_attach(
            root.path(),
            "atlas",
            "style",
            &[input("image_urls", ImageParamShape::UrlArray)],
            &mut params,
        )
        .unwrap();

        let urls = params["image_urls"].as_array().expect("an array");
        assert_eq!(urls.len(), 1);
        assert!(urls[0].as_str().unwrap().starts_with(UPLOADED));
    }

    #[test]
    fn whatever_a_draft_claimed_about_the_image_field_is_replaced() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({ "image_url": "https://example.invalid/stale.png" });

        resolve_and_attach(
            root.path(),
            "atlas",
            "style",
            &[input("image_url", ImageParamShape::Url)],
            &mut params,
        )
        .unwrap();

        assert!(params["image_url"].as_str().unwrap().starts_with(UPLOADED));
    }

    #[test]
    fn a_style_run_with_no_input_is_refused_before_anything_is_spent() {
        // The reason this is a hard failure rather than a fallback: on
        // `nano-banana-*/edit` the image field is optional, so a missing source
        // would silently degrade to text-to-image and charge for it.
        let mut params = json!({});

        let error = resolve_and_attach(Path::new("/nowhere"), "atlas", "style", &[], &mut params)
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

        let error = resolve_and_attach(Path::new("/nowhere"), "atlas", "animate", &[], &mut params)
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

            resolve_and_attach(
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
                    .is_some_and(|url| url.starts_with(UPLOADED)),
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

            resolve_and_attach(
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

            assert!(first.starts_with(UPLOADED), "{start}");
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
        at_the_limit.resize(MAX_INPUT_BYTES as usize, 0);
        std::fs::write(dir.join("gen-src-1.png"), &at_the_limit).unwrap();

        let mut params = json!({});
        resolve_and_attach(
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

        resolve_and_attach(
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

        let error = resolve_and_attach(
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

        resolve_and_attach(Path::new("/nowhere"), "atlas", "source", &[], &mut params).unwrap();

        assert_eq!(params.as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_named_input_with_no_file_on_disk_is_refused() {
        // The candidate exists in the manifest but its job never landed, or the
        // folder was moved out from under us.
        let root = TempDir::new().unwrap();
        let mut params = json!({});

        let error = resolve_and_attach(
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
        oversized.resize(MAX_INPUT_BYTES as usize + 1, 0);
        std::fs::write(dir.join("gen-src-1.png"), &oversized).unwrap();

        let mut params = json!({});
        let error = resolve_and_attach(
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
                bytes: (MAX_INPUT_BYTES + 1) as f64,
                limit: MAX_INPUT_BYTES as f64,
            })
        );
    }

    #[test]
    fn a_model_that_named_no_field_is_refused_rather_than_sent_a_blank_one() {
        let root = project_with_source(&png(), "png");
        let mut params = json!({});

        let error = resolve_and_attach(
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

        let error = resolve_and_attach(
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
