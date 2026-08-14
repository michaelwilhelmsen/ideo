//! Throwaway spike code for #52 — **not** a library, and nothing in `src-tauri`
//! may depend on it.
//!
//! #52 asks two measure-then-decide questions that #36 cannot honestly answer
//! by reasoning:
//!
//! 1. Does duotone quantise first, or colourise last? Two shipped preset notes
//!    say one thing, the research reasons toward the other, and **both orders
//!    claim the other produces mud** — which is why this needs an image.
//! 2. What is preview latency, actually? The "sub-100ms" figure in the research
//!    is an extrapolation from a 2008-era paper's 8K×8K/4s CPU number, flagged
//!    `[UNVERIFIED]`, with no benchmark at our sizes.
//!
//! Two binaries answer them: `duotone-ab` renders the pictures and `bench`
//! fills in the table. The verdict on question 1 is deliberately **not** made
//! here — #52 says hand it back undecided.
//!
//! The one thing this crate is careful about, despite being throwaway, is the
//! working space: get the linear-light conversion wrong and both arms of the
//! A/B are wrong in the same direction and the comparison proves nothing. See
//! [`color`].

pub mod color;
pub mod diffusion;
pub mod dither;
pub mod kernels;
pub mod orders;
pub mod palette;

/// The images the A/B and the benchmark run on.
///
/// These are the app's own generated outputs, read from the local project
/// store rather than copied into the repo — they are user material, and #52
/// wants "a real image", not a stand-in. Each covers one of the three source
/// categories the ticket asks for.
pub struct Source {
    pub slug: &'static str,
    pub kind: &'static str,
    pub path: &'static str,
}

/// Where the three sources live on this machine.
///
/// Hardcoded, and that is the honest thing for a spike: these exact files are
/// what the numbers and the pictures were produced from, so naming them is part
/// of the record. Anyone re-running this elsewhere edits this list — there is no
/// flag, because a spike that silently ran on different images than the ones its
/// report names would be worse than one that will not run at all.
pub const DEFAULT_SOURCES: &[Source] = &[
    Source {
        slug: "photographic",
        kind: "photographic — continuous tone, one very large smooth gradient (the wall), hard shadow edge",
        path: "projects/be3a349a-c1db-43eb-95ac-5e2608e163ba/assets/5e9a605d-0b7f-4b02-87fd-b482d405e004.jpg",
    },
    Source {
        slug: "highkey",
        kind: "high-key / blown-out — the `*-highkey` recipes' own territory, almost all of it above the midpoint",
        path: "projects/be3a349a-c1db-43eb-95ac-5e2608e163ba/assets/afae7c2a-0084-4cdb-8d29-93bb6ed7a6e7.png",
    },
    Source {
        slug: "flatgraphic",
        kind: "flat graphic — large even areas, hard edges, saturated non-neutral hues",
        path: "projects/9adfde2f-0bf3-4300-bbfe-99862348a105/assets/a5b950a5-2f34-497e-bc30-f2f8e78b6e0e.jpg",
    },
];

/// The root the paths above are relative to.
pub fn default_source_root() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/com.ideo.app")
}
