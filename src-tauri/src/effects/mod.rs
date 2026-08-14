//! The one part of #36 that is not a shader.
//!
//! Every look in the effects library renders in the webview, in WebGL2, so that
//! the exported file cannot disagree with what was on screen. Floyd–Steinberg
//! and Atkinson are the deliberate exception: error diffusion decides each pixel
//! from pixels already decided, which a fragment shader cannot express at all.
//! Two of #53's four recipes declare Atkinson, and it has a specific look —
//! sparse, high-contrast, Mac-classic — that nothing else reproduces.
//!
//! **Stills only.** The pattern crawls between frames, which the research flags
//! as the single most objectionable failure mode; blue noise is the video-safe
//! substitute and it is a texture lookup in the shader, not a thing this module
//! has an opinion about. The tab disables these two on a clip with the reason
//! attached rather than hiding them or silently substituting.
//!
//! What crosses the boundary is a **PNG**, not raw pixels: a full-resolution
//! frame is ~11 MB raw and dithered output compresses hard, so the encode pays
//! for itself several times over on the way through IPC.
//!
//! The colour transfer here and the `SRGB8_ALPHA8` sampling the GPU gets free
//! are held to each other within a byte. Without that a duotone would visibly
//! shift the moment somebody switched kernel — same inks, same image, no
//! explanation.

pub mod color;
pub mod diffusion;
pub mod render;
