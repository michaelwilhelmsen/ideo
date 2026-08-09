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
//!
//! Two libraries live here, not one (#29): style presets and motion presets are
//! independent — look and movement are orthogonal, so a recipe picks one of
//! each — and they are kept in separate folders so a fork of one can never
//! shadow a fork of the other by sharing an id. Which library is the only thing
//! `store` takes as a parameter, because everything else about the two is
//! identical and a second copy of this module would be a second place to forget
//! to fix a path-traversal bug. It is a `Library` enum rather than the folder
//! name: a name is a path, and threading a path through four functions is how a
//! preset ends up written somewhere this module does not own.

pub mod store;
