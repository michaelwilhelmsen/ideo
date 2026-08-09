//! The user's own preset library (#28, PRD §6).
//!
//! App-level rather than per-project, and outside the repository: a preset the
//! user forked is theirs, so an update to the committed built-ins must never be
//! able to clobber it. One file per preset, so a hand-edit or a sync conflict
//! costs one look rather than the library.
//!
//! **Rust stays dumb about what a preset means.** The document crosses as opaque
//! JSON and is written back byte-for-byte, exactly as a project manifest is
//! (`projects::store`): the schema lives in TypeScript (`src/lib/recipe/
//! presets.ts`), which is also the side that validates it, and a shape declared
//! in two languages drifts. What Rust owns is the part TypeScript cannot vouch
//! for — that the id is a file name and not a path.

pub mod store;
