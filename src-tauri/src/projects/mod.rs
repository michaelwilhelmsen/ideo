//! Project storage: folders on disk, with a database that only ever agrees
//! with them (PRD §3.2).
//!
//! `store` owns the filesystem, `index` owns the cache of it. Nothing outside
//! this module reads either directly — `commands::projects` is the seam where
//! an `AppHandle` turns into a root path.

pub mod import;
pub mod index;
pub mod store;
