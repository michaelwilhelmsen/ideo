# Deterministic raster post-processing effects — research

Scope: dithering (Floyd-Steinberg, Atkinson, ordered/Bayer, clustered-dot), colour quantisation
(incl. duotone), halftone screening, film grain, pixelation, posterisation, chromatic aberration,
scanline/CRT, bloom/halation — for a Tauri v2 (Rust backend, React frontend) desktop app that
applies these post-generation to AI-generated images/video.

Search budget: 14 web searches max.

## 1. Algorithm order

### 1a. Duotone + dithering: quantise-then-dither, or dither-then-tint?

Web search did not surface a primary source that names the "duotone mud" failure mode directly
(searched: `duotone dithering order "quantize" then dither vs tint after dither mud`). No
authoritative page addressed this specific ordering question. This is a **gap** — see below.

[UNVERIFIED — reasoned from how error-diffusion dithering works, consistent with general
quantisation/dithering literature, e.g. Wikipedia "Dither" and "Ordered dithering",
https://en.wikipedia.org/wiki/Dither, https://en.wikipedia.org/wiki/Ordered_dithering]:
Error-diffusion and ordered dithering both work by comparing a **luminance/greyscale value**
against a threshold (or diffusing the _quantisation error_ of that comparison) to decide which of
two (or N) output levels to place at each pixel. The correct pipeline for a two-colour duotone is
therefore:

1. Convert the source image to greyscale/luminance.
2. Run the dither algorithm (Floyd-Steinberg/Atkinson/Bayer) against a **1-bit (black/white)
   threshold** — this is standard bilevel dithering, exactly as for print halftoning.
3. Map the two resulting bilevel values (0 and 1) to the two exact duotone hex colours as a last
   step (a simple palette swap / LUT, not a colour-space quantisation).

Doing it the other way round (tinting/blending toward the duotone colours first, i.e. producing a
smooth gradient _in colour space_ between hex A and hex B, and only then running a dithering or
quantisation pass on that RGB gradient) is the failure mode: the disagreement between the (usually
uncorrelated) error-diffusion decisions made independently per channel, or a naive quantiser
operating on a 2-entry RGB palette that isn't perceptually/luminance-ordered, produces incoherent
per-channel noise that reads as flat, low-contrast "mud" instead of clean, high-contrast dither
texture. This matches the general principle repeatedly stated in the quantisation literature that
dithering must operate on the _quantisation error relative to the target palette/threshold_, not
be applied to an already-blended continuous image ([SANNSYNLIG], per general dithering theory,
https://en.wikipedia.org/wiki/Dither).

Practical rule for the implementation: dither to a 1-bit mask using perceptual luminance of the
source, then colourise the mask with the two hex values. This is also how most duotone tools
(Photoshop duotone, standard halftone duotone workflows) are described to work in general
secondary sources on halftone/duotone printing, though no primary spec was found and confirmed by
URL — flagged **[SANNSYNLIG]**, not [DOK].

### 1b. Grain: before or after quantisation/dither?

- AMD GPUOpen's film-grain writeup states grain workflows commonly add noise **in linear light,
  prior to quantisation and conversion to the encoded (sRGB-like) output** — i.e. grain is applied
  before the final quantisation/encoding step, not after
  [SANNSYNLIG — secondary summary of GPUOpen article, "VDR Follow Up – Fine Art of Film Grain",
  https://gpuopen.com/learn/vdr-follow-up-fine-art-of-film-grain/ — not independently re-verified
  by fetching the full page, treat as SANNSYNLIG pending direct read].
- Cloudinary's dithering glossary and the kageru.moe "Adaptive Graining" article both frame grain
  and dithering as solving the _same_ problem (banding from quantisation) via different means:
  dithering adds structured/random noise as part of the quantisation decision itself, while grain
  is a separate noise layer that can substitute for or supplement dedicated debanding dither
  [SANNSYNLIG, https://cloudinary.com/glossary/image-dithering,
  https://blog.kageru.moe/legacy/adaptivegrain.html].
- Practical implication for this app's pipeline: **grain should be composited after colour
  quantisation/dithering**, not before, when grain's purpose is a _film-look_ effect layered on
  top of an already-posterised/dithered image (the opposite of the debanding use-case above, where
  grain substitutes for dither). If grain were applied before a hard quantisation/dither step, the
  quantiser could interpret the grain as image detail and either flatten it away (loss of the grain
  texture) or interact with the error-diffusion kernel to create moiré-like beating between the
  grain's frequency and the dither pattern's frequency. This ordering (quantise/dither → tint →
  grain, or quantise/dither → grain, depending on whether duotone tinting also happens) is
  **[UNVERIFIED]** — inferred, not read from a primary source that discusses this exact app
  scenario. No primary source explicitly answers "grain before or after dither for a stylised
  film-look effect (as opposed to debanding)" — flagged as a **gap**.

## 2. Rust crates

| Crate                  | Covers                                                                                                                                                         | Maintenance                                                                                                                                                                  | Licence                                                                                                    | Notes                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image`                | Decode/encode, buffers, basic pixel ops, resizing                                                                                                              | Active, core of the `image-rs` org, huge download count [DOK, https://crates.io/crates/image]                                                                                | MIT                                                                                                        | Foundation everyone builds on; no dithering/halftone/grain of its own.                                                                                                                                                                                                            |
| `imageproc`            | Geometric transforms, convolutions, morphology, contours, drawing, some filters                                                                                | Active — v0.26.1, released days before this research, 7.2M all-time downloads, MIT, image-rs org [DOK, https://crates.io/crates/imageproc]                                   | MIT                                                                                                        | **No built-in dithering or halftoning** [SANNSYNLIG, per crates.io description and lib.rs page, https://lib.rs/crates/imageproc]. Good base for convolution-style effects (bloom blur, chromatic-aberration channel shifts) but the dither/halftone kernels must be hand-written. |
| `dither`               | Ditherer for static images, several palettes, Floyd-Steinberg family (`floyd`/`steinberg`/`floydsteinberg` aliases)                                            | Present on crates.io, v1.3.10 tag found; **maintenance freshness not directly confirmed** — [SANNSYNLIG only, via crates.io/lib.rs listing, https://crates.io/crates/dither] | Not confirmed — **[IKKE FUNNET — did not open crate page to read licence field]**                          | Narrow scope (error diffusion only, static images).                                                                                                                                                                                                                               |
| `ditherer`             | Bayer-matrix ordered dithering                                                                                                                                 | Found on crates.io [SANNSYNLIG, https://crates.io/crates/ditherer]                                                                                                           | **[IKKE FUNNET]** licence not confirmed                                                                    | Small, single-purpose.                                                                                                                                                                                                                                                            |
| `dithr` (pbkx/dithr)   | Buffer-first dithering **and halftoning**: Bayer 2x2/4x4/8x8/16x16 ordered dithering plus error-diffusion kernels (Floyd-Steinberg, Atkinson listed), `no_std` | GitHub project, v0.3.0 — activity level not verified beyond version number [SANNSYNLIG, https://github.com/pbkx/dithr]                                                       | **[IKKE FUNNET]**                                                                                          | Closest single crate to covering both ordered and error-diffusion dithering + halftoning; worth vendoring/forking given the algorithms are short regardless.                                                                                                                      |
| `oxideav-image-filter` | Pure-Rust single-frame filters: error diffusion (Floyd–Steinberg, Jarvis-Judice-Ninke, Stucki, Sierra variants, Atkinson) + Bayer ordered dithering            | GitHub project; activity/maintenance not verified [SANNSYNLIG, https://github.com/OxideAV/oxideav-image-filter]                                                              | **[IKKE FUNNET]**                                                                                          | Widest kernel coverage found for error diffusion variants — good reference implementation even if not depended on directly.                                                                                                                                                       |
| `exoquant`             | Colour quantisation with a `ditherer::FloydSteinberg` struct — combines palette generation and dithering                                                       | Present on docs.rs [SANNSYNLIG, https://docs.rs/exoquant/latest/exoquant/ditherer/struct.FloydSteinberg.html]                                                                | **[IKKE FUNNET]**                                                                                          | Purpose-built for palette quantisation + dither together — relevant for the N-entry-palette requirement.                                                                                                                                                                          |
| `palette`              | General colour management/conversion: colour spaces (sRGB, linear, Oklab, Lab, HSL, etc.), type-safe conversions                                               | Active, well-known in the Rust colour ecosystem [SANNSYNLIG, https://crates.io/crates/palette]                                                                               | Dual MIT/Apache-2.0 typically for this ecosystem — **[IKKE FUNNET — not confirmed by opening crate page]** | Not a dithering/quantisation library itself; use it for the linear/sRGB colour-space conversions needed correctly (see §5).                                                                                                                                                       |
| `quantette`            | Fast, high-quality image quantisation and palette generation; quantises in **Oklab** for perceptual accuracy, also supports sRGB                               | Present on crates.io, described as part of the image-processing ecosystem [SANNSYNLIG, https://crates.io/crates/quantette]                                                   | **[IKKE FUNNET]**                                                                                          | Directly relevant to "colour quantisation to an N-entry palette" — doing the quantisation in Oklab rather than naive RGB is exactly the perceptual correctness this app needs; check if it also dithers or just generates palettes.                                               |
| `color_quant`          | Reduces images to a ≤256-colour palette (classic median-cut/NeuQuant-style)                                                                                    | Present on crates.io [SANNSYNLIG, https://crates.io/crates/color_quant]                                                                                                      | **[IKKE FUNNET]**                                                                                          | Older, simpler; used internally by the `gif` crate ecosystem historically (not independently confirmed here).                                                                                                                                                                     |
| `palette_extract`      | Palette extraction via a port of Leptonica's modified median-cut                                                                                               | Present on crates.io [SANNSYNLIG, https://crates.io/crates/palette_extract]                                                                                                  | **[IKKE FUNNET]**                                                                                          | For deriving a palette from an image, not for applying a fixed N-colour/duotone palette.                                                                                                                                                                                          |
| `photon-rs`            | Broad general image-filter library (96+ functions): colour corrections, convolutions, channel ops, transforms; compiles native + WASM                          | Actively maintained — "continually receives new filters and updates from fellow contributors" [DOK, https://github.com/silvia-odwyer/photon]                                 | Apache-2.0 [DOK, https://github.com/silvia-odwyer/photon]                                                  | General-purpose Photoshop-style filter library; **not** specifically a dithering/halftone/grain library — would need to check its filter list for anything usable as a starting point (e.g. posterise, noise) rather than relying on it for the core algorithms in scope here.    |

**Gap in coverage:** no actively-maintained, well-documented single crate was found that natively
covers **halftone screening with CMYK rosette/screen-angle support**, **film grain with
luminance-varying density**, **pixelation/mosaic**, **posterisation**, **chromatic aberration**, or
**scanline/CRT/bloom-halation** as first-class operations. These are all short, well-understood
kernels (per-pixel or small-neighbourhood operations) that this project should expect to
hand-write on top of `image`/`imageproc` (for buffer plumbing and convolutions) plus `palette` (for
correct colour-space handling), rather than pull in a dependency for each. This matches the task's
own framing that "these algorithms are short."

## 3. GPU vs CPU

**Error diffusion is fundamentally sequential.** Multiple peer-reviewed sources confirm the
current pixel's dithered value depends on quantisation error propagated from already-processed
neighbours, so naive error diffusion "cannot be efficiently parallelized" and is expensive at
scale [DOK-level consensus across sources: "A Parallel Error Diffusion Implementation on a GPU",
https://escholarship.org/content/qt7b78v752/qt7b78v752_noSplash_b7b84686bf8195e832c0afa9e46c633e.pdf,
and "Optimal Parallel Error-Diffusion Dithering",
https://www.researchgate.net/publication/237675301_Optimal_Parallel_Error-Diffusion_Dithering].

Concrete numbers found:

- One parallel-GPU error-diffusion paper reports an **8K×8K image dithered in ~400ms on a laptop
  Nvidia 8600M GPU**, versus **~4 seconds** for the sequential CPU implementation of the same
  algorithm on the same machine [SANNSYNLIG — summarised from search snippet of "A Parallel Error
  Diffusion Implementation on a GPU", not independently re-verified by opening the full PDF,
  https://www.researchgate.net/publication/211179280_A_Parallel_Error_Diffusion_Implementation_on_a_GPU].
  Note the 8600M is a ~2008-era mobile GPU; this suggests a modern CPU alone, run naively serial,
  would land somewhere on that ~4s-for-64-megapixel curve, i.e. roughly on the order of tens of
  milliseconds per megapixel for a straightforward single-threaded Floyd-Steinberg/Atkinson
  implementation — **[UNVERIFIED extrapolation]**, no direct modern-CPU-only benchmark was found
  for typical desktop-app image sizes (e.g. 1–4 MP preview sizes).
- Reported CPU-vs-GPU speedups for GPU-parallelised error diffusion (using block/pixel-based
  restructuring, not naive per-pixel dependency) are **10–30×** over a two-threaded CPU baseline,
  and separately **30–37×** over a dual-core CPU baseline at ~200 megapixels/second throughput for
  RGB halftoning [SANNSYNLIG, aggregated from search snippets of multiple GPU error-diffusion
  papers found via WebSearch, not independently opened:
  https://www.astesj.com/v05/i06/p79/,
  https://escholarship.org/content/qt7b78v752/qt7b78v752_noSplash_b7b84686bf8195e832c0afa9e46c633e.pdf].

**Practical read for this app [UNVERIFIED — no direct benchmark for the app's actual target
resolutions, e.g. 512–2048px preview thumbnails, was run or found]:** for a _preview-sized_ image
(roughly up to ~1–2 megapixels, which is a plausible interactive-preview size for an AI image
generator), a straightforward single-threaded Rust error-diffusion implementation is very likely
to comfortably clear sub-100ms, based on the order-of-magnitude implied by the 8K×8K/4s CPU
figure above (a 1–2MP image is ~1/32–1/64th the pixel count of 64MP, implying roughly 60–130ms in
the worst case scaled naively, likely much less in practice given branch-free modern code and
cache-friendly buffer sizes at that scale). At full-resolution outputs (many megapixels, e.g.
final export of a 2K–4K generated image), naive serial error diffusion is the more likely place to
miss the 100ms interactive budget, and that is also exactly where GPU parallel restructuring
(block-interlaced/pinwheel schemes, as in "Block Interlaced Pinwheel Error Diffusion",
https://www.researchgate.net/publication/2479822_Block_Interlaced_Pinwheel_Error_Diffusion) starts
to pay off. No exact pixel-count threshold for "stops being interactive" was found in a primary
source calibrated to a modern desktop CPU — flagged as a **gap**; recommend the team benchmark
their own Floyd-Steinberg/Atkinson implementation directly on target hardware rather than relying
on this literature's older GPU-era numbers.

**Ordered/Bayer dithering is embarrassingly parallel** — each output pixel only needs the source
pixel value and a lookup into a small fixed threshold matrix (e.g. 4×4 Bayer), with no dependency
on neighbouring output decisions. This is confirmed by the existence of straightforward one-shot
GPU/WGSL implementations doing exactly this per-fragment with no cross-pixel state
[DOK — architecture visible directly in "webgpu-bayer-ordered-dithering",
https://github.com/anthonyhardman/webgpu-bayer-ordered-dithering, and in the Codrops tutorial
"Building a Real-Time Dithering Shader", https://tympanus.net/codrops/2025/06/04/building-a-real-time-dithering-shader/].
Ordered dithering has no serial dependency, so it needs no special GPU justification for
_correctness_ — it's just that a compute/fragment shader will always be faster than a CPU loop for
this kind of per-pixel-independent op at large image sizes, the same as any other pointwise filter
(posterise, chromatic aberration channel offset, scanline overlay, colour-space conversion).

**Is `wgpu` worth it?** [UNVERIFIED / recommendation, not sourced from a benchmark specific to this
app]: for the _embarrassingly parallel_ effects (ordered/Bayer dithering, clustered-dot halftone
without adaptive per-region error correction, posterisation, chromatic aberration, scanlines,
pixelation, bloom blur, grain compositing), a `wgpu` compute/fragment-shader path is a natural fit
and prior art exists demonstrating exactly these effects in WGSL/WebGPU shaders (dithering
confirmed above; blur/bloom and chromatic aberration are standard post-processing shader staples
in the broader WebGPU/shader community, though no specific WGSL bloom/chromatic-aberration repo was
directly opened in this research pass — **[IKKE FUNNET — did not search separately for
WGSL bloom/halation or WGSL chromatic-aberration repos due to the 14-search budget]**). For
_error-diffusion_ dithering specifically, `wgpu` is not required for correctness (CPU is fine at
preview sizes per above) but could still be worth it purely for full-resolution export
performance if the naive CPU path proves too slow in the team's own benchmark — with the caveat
that a GPU error-diffusion implementation is materially more complex to write correctly (needs a
block-based or wavefront scheme, not a naive port of the sequential algorithm) than the ordered-
dithering shader.

## 4. Video / temporal stability

**Native ffmpeg filters that touch this scope:**

- `noise` filter — adds noise (usable for grain/film-look); supports luma-only application and
  `temporal`/`uniform` flags that change how noise varies frame-to-frame
  [SANNSYNLIG, from FFmpeg filter documentation, https://ffmpeg.org/ffmpeg-filters.html — not
  independently re-confirmed by opening the exact filter section text].
- `geq` (generic equation) filter — can be scripted to synthesize film-grain-like noise via an
  expression (e.g. scaling a noise term by a constant like 0.15), and combined with `dilation`/
  `deflate` to make blobbier grain "clumps" rather than uniform per-pixel noise
  [SANNSYNLIG, per "Creating Vintage Video Filters with FFmpeg", https://zayne.io/articles/vintage-camera-filters-with-ffmpeg,
  and the FFmpeg gist "Ultimate film grain", https://gist.github.com/logiclrd/287140934c12bed1fd4be75e8624c118].
- Confirmed: **there is a native ffmpeg audio dither implementation** (`libswresample/dither.c`,
  used for sample-format conversion) [DOK, https://github.com/FFmpeg/FFmpeg/blob/master/libswresample/dither.c]
  — this is **audio** dithering (bit-depth reduction dither), not an image/video visual
  Floyd-Steinberg/Bayer-style dither filter. The task description's phrase "there IS a native
  ffmpeg dither" most likely refers to this audio dither, or possibly to palette-based dithering
  inside `paletteuse`/`palettegen` (ffmpeg's GIF-style palette pipeline, which does support an
  error-diffusion dither mode for palette mapping) — **[IKKE FUNNET — did not directly confirm
  `paletteuse`'s dither modes by name/URL within the 14-search budget; recommend checking
  `ffmpeg -h filter=paletteuse` directly, as it is documented to support `bayer`, `heckbert`,
  `floyd_steinberg`, `sierra2`, and `sierra2_4a` dither modes from general ffmpeg knowledge, but
  this specific detail was not verified against a fetched primary source in this pass**].
- No native ffmpeg filter was found or confirmed for ordered/clustered-dot halftone screening with
  CMYK rosette angles, film grain with luminance-dependent density, chromatic aberration, or
  scanline/CRT emulation as dedicated named filters — these would need `geq`/custom filter-graph
  composition in ffmpeg, or (more likely, given the app's own Rust backend) decode-to-frames and
  process with the same Rust kernels used for stills, then re-encode.

**Decode-to-frames vs. ffmpeg-native tradeoff [UNVERIFIED — reasoned, not sourced from a direct
comparison]:** since most of the effects in scope (Floyd-Steinberg/Atkinson error diffusion,
Bayer/clustered-dot halftone, duotone quantisation, posterisation) have **no ffmpeg-native filter
equivalent at all**, and the app already needs a hand-written Rust implementation of these kernels
for the still-image path, the pragmatic architecture is: decode video to frames (or process
frame-by-frame via a pipe) with ffmpeg, run the _same_ Rust per-frame kernel used for images, then
re-encode with ffmpeg. Only `noise`/`geq`-based grain and (if confirmed) `paletteuse` dithering
have plausible native-ffmpeg shortcuts, and even those would need to be re-verified against the
app's own colour-managed pipeline (see §5) to match the still-image look.

**Temporal stability — the core problem and mitigation:**

- Confirmed mechanism: "temporal dithering can produce visible artifacts such as twinkling or
  crawling in near-black gradients" when a dither/noise pattern is regenerated independently and
  visibly-differently per frame, and the human eye is particularly sensitive to flicker in the
  ~4–30 Hz range (with peak sensitivity around 15 Hz) [SANNSYNLIG, aggregated from search snippet
  summarising "Temporal Dithering: The Cause of Game Flicker & Eye Strain",
  https://us.ktcplay.com/blogs/technology-hub/what-is-temporal-dithering, and general
  display-dithering literature found via the same query — not independently opened and read in
  full].
- **Standard mitigation found: offset the noise/dither pattern deterministically and smoothly
  across frames rather than regenerating it independently (fully uncorrelated) each frame.**
  Concretely, for shader-based film grain, a per-frame spatial offset applied to the grain texture
  coordinate — driven by a low-discrepancy sequence such as a **Halton sequence with a long
  period (1024 frames cited)** — is reported to work well, because it decorrelates the pattern
  from frame to frame enough to avoid a static "stuck" grain look while avoiding pure random
  jitter, which reads as harsh flicker [SANNSYNLIG, summarised from a search snippet, source
  attribution unclear beyond the snippet itself — **[IKKE FUNNET — could not attribute this
  specific Halton-sequence grain-offset technique to a named primary source within budget; it
  reads consistent with known temporal-AA/dithering jitter-sequence practice (e.g. Halton/R2
  sequences used for TAA jitter), but that broader connection is UNVERIFIED here]**.
- General principle consistent across sources: prefer a **single fixed dither/halftone pattern
  matrix (e.g. one Bayer tile) applied at a _stable_ spatial phase across all frames** — i.e. do
  NOT re-randomize the ordered-dither threshold matrix's phase/offset per frame — combined with,
  for grain specifically, either (a) a deterministically-evolving offset (Halton-style) rather than
  fully independent per-frame noise, or (b) a temporal low-pass / blend of grain across a few
  frames to reduce the frame-to-frame delta. This is the video-post-production equivalent of "grain
  management" tools in professional NLEs, which explicitly exist to prevent grain from looking like
  video noise/crawl — mentioned in the AMD GPUOpen grain article's broader framing of grain as a
  deliberately-designed temporal signal rather than raw independent noise per frame [SANNSYNLIG,
  https://gpuopen.com/learn/vdr-follow-up-fine-art-of-film-grain/].
- For error-diffusion dithering applied per-frame to video specifically: no direct source was
  found addressing "Floyd-Steinberg dither flicker in video" by name — **[IKKE FUNNET — searched
  "video film grain temporal flicker static per-frame dither crawl mitigation", found grain- and
  general-dithering-flicker material but nothing specific to per-frame error-diffusion dither
  crawl]**. By extension of the general principle above, the same fix should apply: avoid
  re-computing an independent full error-diffusion pass with no temporal linkage between frames;
  either keep the diffusion deterministic and identical in method every frame (so _stationary_
  regions of the source video produce an identical dither pattern rather than a new random-looking
  one each frame — error diffusion is deterministic given the same input, so this may already hold
  as long as no per-frame random seed is injected), or apply a stable ordered/Bayer dither instead
  of error diffusion for video specifically, since Bayer's fixed spatial phase is trivially stable
  frame-to-frame by construction. **This substitution (prefer ordered/Bayer over error-diffusion
  for video, precisely because of its embarrassing parallelism and frame-to-frame determinism) is
  an [UNVERIFIED] recommendation of this report, not a claim read from a source.**

## 5. Colour space (linear vs sRGB)

This is the one question where sources are strong and largely converge.

- **Dithering directly on raw sRGB-encoded byte values without linearising first over-brightens
  the result.** Because sRGB is a non-linear (roughly gamma-2.2-ish) encoding, treating a
  midpoint sRGB byte value as "half brightness" and dithering around it is wrong — the true
  perceptual/physical midpoint requires converting to linear light first
  [DOK — direct, specific claim, "Correct sRGB Dithering", http://www.thetenthplanet.de/archives/5367].
- **Correct pipeline, converged across multiple independent write-ups:** convert to linear light →
  perform the error-diffusion (or ordered-dither comparison) in linear space → quantise back,
  choosing the output level that is closest to the input **in linear space** → re-encode to sRGB
  for output. This is stated essentially identically in "Gamma-aware image dithering"
  (https://www.nayuki.io/page/gamma-aware-image-dithering), "Dither and Gamma"
  (https://drj11.wordpress.com/2009/04/03/dither-and-gamma/), and "Dithering in Gamma vs. Linear
  Space" (https://threadlocalmutex.com/?p=93) [SANNSYNLIG — consistent across 3+ independent
  technical sources, none individually re-verified in full by fetching the whole page].
- **What it looks like when done wrong:** dithering in sRGB space directly is reported to make
  results "too bright" / shift the apparent midtone balance, and produces incorrect banding
  correction in gradients — the errors are most visible in **smooth low-frequency gradients**
  (skies, soft studio backgrounds) where the mismatch between the "linear" error being diffused
  and the "non-linear" values being compared shows up as visible discontinuities or an incorrect
  brightness curve, whereas for busy, high-frequency photographic content, the visible difference
  is reported as "negligible" in practice [DOK for the general claim's phrasing,
  http://www.thetenthplanet.de/archives/5367; corroborated as "for high-frequency photographic
  images, visually there's little advantage... though for low-frequency gradients the gain in
  quality is obvious" — SANNSYNLIG summary from search aggregation of the same source set].
- **A practical shortcut some practitioners use:** an approximate gamma exponent (~2.0, vs. the
  true sRGB transfer function) is reported to be visually indistinguishable from the exact sRGB
  conversion for dithering purposes — i.e. an exact sRGB EOTF/OETF round-trip is not strictly
  required, a cheap `pow(x, 2.0)` / `pow(x, 0.5)` approximation is good enough
  [SANNSYNLIG, same source cluster as above, not independently re-verified by opening the full
  page].
- **Counterpoint / nuance found on the _storage_ side (not the dithering-math side):** 8-bit
  _linear_ buffers lose precision in the darks compared to gamma-encoded 8-bit buffers, which is
  why gamma-encoding exists as a perceptually-efficient way to spend limited bits — and dithering
  applied **before final gamma-encoding/quantisation to 8 bits** is exactly the standard technique
  for hiding the resulting banding [SANNSYNLIG, NVIDIA GPU Gems 3 ch. 24 "The Importance of Being
  Linear", https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-24-importance-being-linear,
  and general graphics-gamma literature, https://learnopengl.com/Advanced-Lighting/Gamma-Correction].
  This is not in tension with the point above: the recommendation is still "compute the error-diffusion
  math in linear-light values," it's just that the _final stored/quantised_ representation should
  remain gamma-encoded (sRGB), because that's the perceptually-efficient way to allocate 8 bits per
  channel. In other words: linear for the _comparison/error math_, sRGB-encoded for the _output
  bit-depth allocation_ — these are two different axes, not a contradiction.
- **One dissenting/contextual note found:** a Shadertoy example titled "Dithering should happen in
  sRGB" exists (https://www.shadertoy.com/view/NssBRX), suggesting the practitioner community is
  not unanimous, or that the "correct" answer depends on what's being dithered for (display output
  dithering to reduce banding on an 8-bit panel vs. artistic stylised dithering for a fixed small
  palette/duotone effect may have different correct answers) [IKKE FUNNET — this source's argument
  was not opened/read, its title alone contradicts the majority view above; flagged rather than
  ignored].

**Recommendation for this app:** for the _artistic_ dither/quantisation effects in scope here
(duotone, N-colour posterisation, halftone), do the luminance thresholding / error-diffusion
maths in **linear light**, converting from the generated image's sRGB-ish output first, per the
majority of sources above — but treat this as the default, not an absolute, and keep the
Shadertoy dissent in mind if the linear-space result looks _less_ correct/pleasing for a specific
stylised effect (artistic dithering targeting a fixed 1-bit or N-colour palette is not quite the
same problem as debanding a smooth photographic gradient before an 8-bit display, which is what
most of the strongest sources above are actually about).

## Code sketches

These are standard, well-known kernels reproduced from general/public dithering literature
(Wikipedia "Floyd–Steinberg dithering", "Atkinson dithering", "Ordered dithering") — treat the
matrices/coefficients as [DOK] (they are the canonical published constants), the Rust framing as
[UNVERIFIED] scaffolding written for this report, not copied from a specific crate.

**Floyd–Steinberg error-diffusion kernel** (error distributed to 4 neighbours, /16 total)
[DOK, https://en.wikipedia.org/wiki/Floyd%E2%80%93Steinberg_dithering]:

```text
        X   7/16
3/16  5/16  1/16
```

**Atkinson kernel** (only distributes 6/8 of the error — the rest is deliberately dropped, which is
why Atkinson dither has less "smear" and cleaner highlights/shadows than Floyd-Steinberg)
[DOK, https://en.wikipedia.org/wiki/Atkinson_dithering]:

```text
          X   1/8  1/8
1/8  1/8  1/8
     1/8
```

**Bayer 4×4 ordered-dither threshold matrix** (values are the index/16 threshold to compare a
normalised pixel value against; embarrassingly parallel — no cross-pixel state)
[DOK, https://en.wikipedia.org/wiki/Ordered_dithering]:

```text
 0  8  2 10
12  4 14  6
 3 11  1  9
15  7 13  5
```

```rust
// Ordered/Bayer dithering — pure function of (x, y, pixel value); trivially parallel per-pixel.
const BAYER_4X4: [[u8; 4]; 4] = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
];

fn bayer_threshold(x: u32, y: u32) -> f32 {
    // Normalise to (0, 1), offset by 0.5/16 so 0 and 1 are reachable.
    (BAYER_4X4[(y % 4) as usize][(x % 4) as usize] as f32 + 0.5) / 16.0
}

fn ordered_dither_bilevel(value_linear: f32, x: u32, y: u32) -> bool {
    value_linear > bayer_threshold(x, y)
}
```

```rust
// Duotone: threshold/dither on luminance in linear light, THEN map to the two hex colours last.
fn duotone_pixel(luminance_linear: f32, x: u32, y: u32, dark_hex: [u8; 3], light_hex: [u8; 3]) -> [u8; 3] {
    if ordered_dither_bilevel(luminance_linear, x, y) { light_hex } else { dark_hex }
}
```

## Gaps and uncertainty

- **§1a (duotone order):** no primary source directly discusses "quantise-then-dither vs.
  dither-then-tint" for duotone specifically, or names the resulting artifact "mud." The
  conclusion given is [UNVERIFIED], reasoned from how error-diffusion/ordered dithering
  mathematically works, not read from a source that states it explicitly for duotone. Recommend
  the team verify empirically with a test image before locking in the pipeline order.
- **§1b (grain order):** no primary source addresses grain-before-or-after-dither for a
  _stylised film-look_ effect (as opposed to grain-as-debanding, which is the case the sources
  actually cover). Recommend empirical A/B testing.
- **Licences for several Rust crates** (`dither`, `ditherer`, `dithr`, `oxideav-image-filter`,
  `exoquant`, `palette`, `quantette`, `color_quant`, `palette_extract`) were **not individually
  confirmed** — crates.io/GitHub pages were referenced from search snippets only, not opened and
  read directly, given the 14-search budget. Before depending on any of these, open the crate's
  `Cargo.toml`/README/crates.io licence field directly.
- **Maintenance freshness** (last commit / last publish date) for the smaller crates (`dither`,
  `ditherer`, `dithr`, `oxideav-image-filter`) was not confirmed beyond a version number appearing
  in search results — no "last updated" dates were retrieved, so staleness cannot be flagged
  either way. Treat as unverified until checked directly on crates.io/GitHub.
- **§3 (GPU/CPU threshold):** no benchmark was found for a modern desktop CPU running
  Floyd-Steinberg/Atkinson at the app's actual likely preview resolutions (e.g. 512–2048px). The
  numbers used (8K×8K in ~4s serial on a 2008-era mobile GPU's host CPU) are old and from a
  different hardware era; the interactive-threshold pixel count given in this report is an
  extrapolation, not a measurement. **Recommend the team benchmark their own kernel directly** —
  this is a 20-minute task and would replace speculation with a real number.
- **§4 (ffmpeg `paletteuse` dither modes):** the claim that ffmpeg's `paletteuse` filter supports
  `bayer`/`floyd_steinberg`/`sierra2` dither modes was not verified against a fetched primary
  source in this pass (general ffmpeg knowledge, not confirmed here) — check
  `ffmpeg -h filter=paletteuse` directly.
- **§4 (Halton-sequence grain jitter):** attributed to a search-snippet summary without a clearly
  identified primary source URL; treat this technique as directionally plausible (consistent with
  known TAA/jitter-sequence practice) but not confirmed to a specific citation.
- **No search was run** for WGSL/wgpu prior art specifically for bloom/halation, chromatic
  aberration, scanline/CRT, or clustered-dot/CMYK-rosette halftone shaders — only ordered/Bayer
  dithering WGSL prior art was searched for, per the task's explicit emphasis on that effect. These
  other effects are common enough in the shader/demoscene community that prior art almost
  certainly exists, but it was not located within the 14-search budget.
- Search budget used: 12 of 14 permitted web searches.

## Recommendation

For a Tauri v2 app that needs interactive preview plus a full-quality export path:

1. **Build the core kernels by hand in Rust**, on top of `image` (buffers/codec) + `imageproc`
   (convolutions, geometric ops) + `palette` (correct linear/sRGB conversions). No single
   maintained crate covers this scope; `dithr` and `oxideav-image-filter` are the closest reference
   implementations for error-diffusion/Bayer kernels and are worth reading (or vendoring pieces of)
   even if not taken as a direct dependency. Use `quantette`/`exoquant` for the N-entry-palette
   quantisation step specifically (they already do perceptual/Oklab-aware quantisation, which is
   non-trivial to get right by hand).
2. **Pipeline order:** convert to linear light → do luminance thresholding/error-diffusion/ordered
   dithering math there → for duotone/N-palette, choose output colours as the last step (a plain
   LUT/palette swap on the already-dithered indices) → re-encode to sRGB for storage/display. Apply
   film-grain compositing as a separate, later stage on top of the quantised/dithered result if the
   goal is a stylised film look (not as a debanding aid) — but treat this specific ordering claim
   as unverified and worth a quick visual A/B before shipping.
3. **CPU is very likely fine for interactive preview** at plausible preview resolutions for both
   ordered and error-diffusion dithering; benchmark before assuming a GPU path is needed. Reach for
   `wgpu` first for the pointwise/embarrassingly-parallel effects (ordered dithering, posterise,
   chromatic aberration, scanlines, pixelation, bloom blur) if full-resolution export performance
   demands it — these are easy and safe to parallelise. Only invest in a parallel error-diffusion
   scheme (block/wavefront) if the CPU path is actually measured to miss the export-time budget;
   it is real complexity for a kernel that may not need it at your target resolutions.
4. **For video, prefer ordered/Bayer dithering over error diffusion** where the choice is open,
   because its fixed spatial phase is trivially temporally stable frame-to-frame, sidestepping the
   flicker/crawl problem entirely; if error diffusion is required for the desired look, keep the
   algorithm strictly deterministic (no per-frame random seed) and consider a stabilising jitter
   sequence for any grain layered on top, rather than fully independent per-frame noise. Prefer
   decode-frames-then-process-with-the-same-Rust-kernels over hunting for ffmpeg-native equivalents
   for anything beyond grain/noise, since ffmpeg has no native halftone/duotone/posterise filter.
5. Given the number of [UNVERIFIED]/[SANNSYNLIG] items above, budget time for two concrete
   validations before committing to the architecture: (a) a duotone pipeline-order A/B test on a
   real photo, and (b) a CPU-benchmark of your own Floyd-Steinberg implementation at your actual
   target preview and export resolutions.
