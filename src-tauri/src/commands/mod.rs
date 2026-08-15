//! Tauri command handlers organized by domain.
//!
//! Each submodule contains related commands and their helper functions.
//! Import specific commands via their submodule (e.g., `commands::preferences::greet`).

pub mod api_key;
pub mod billing;
pub mod effects;
pub mod export;
pub mod jobs;
pub mod notifications;
pub mod preferences;
pub mod presets;
pub mod projects;
pub mod quick_pane;
pub mod recovery;
