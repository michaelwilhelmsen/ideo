//! Shared types and validation functions for the Tauri application.

use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::LazyLock;

/// Default shortcut for the quick pane
pub const DEFAULT_QUICK_PANE_SHORTCUT: &str = "CommandOrControl+Shift+.";

/// Maximum size for recovery data files (10MB)
pub const MAX_RECOVERY_DATA_BYTES: u32 = 10_485_760;

/// Upper bound on the stored onboarding version (PRD §7).
///
/// Completion is a version integer rather than a boolean so a step added later
/// can re-prompt existing users. The cap only rejects nonsense written by hand
/// into `preferences.json` — a version from the future would silently suppress
/// every future step.
pub const MAX_ONBOARDING_VERSION: u32 = 1_000;

/// Pre-compiled regex pattern for filename validation.
/// Only allows alphanumeric characters, dashes, underscores, and a single extension.
pub static FILENAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .expect("Failed to compile filename regex pattern")
});

// ============================================================================
// Preferences
// ============================================================================

/// Application preferences that persist to disk.
/// Only contains settings that should be saved between sessions.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppPreferences {
    pub theme: String,
    /// Global shortcut for quick pane (e.g., "CommandOrControl+Shift+.")
    /// If None, uses the default shortcut
    pub quick_pane_shortcut: Option<String>,
    /// User's preferred language (e.g., "en", "es", "de")
    /// If None, uses system locale detection
    pub language: Option<String>,
    /// Highest onboarding version the user has been walked through (PRD §7).
    /// `0` means "never onboarded", which is also what a preferences file
    /// written before this field existed deserialises to.
    #[serde(default)]
    pub onboarding_version: u32,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            quick_pane_shortcut: None, // None means use default
            language: None,            // None means use system locale
            onboarding_version: 0,     // 0 means never onboarded
        }
    }
}

// ============================================================================
// Recovery Errors
// ============================================================================

/// Error types for recovery operations (typed for frontend matching)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
pub enum RecoveryError {
    /// File does not exist (expected case, not a failure)
    FileNotFound,
    /// Filename validation failed
    ValidationError { message: String },
    /// Data exceeds size limit
    DataTooLarge { max_bytes: u32 },
    /// File system read/write error
    IoError { message: String },
    /// JSON serialization/deserialization error
    ParseError { message: String },
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecoveryError::FileNotFound => write!(f, "File not found"),
            RecoveryError::ValidationError { message } => write!(f, "Validation error: {message}"),
            RecoveryError::DataTooLarge { max_bytes } => {
                write!(f, "Data too large (max {max_bytes} bytes)")
            }
            RecoveryError::IoError { message } => write!(f, "IO error: {message}"),
            RecoveryError::ParseError { message } => write!(f, "Parse error: {message}"),
        }
    }
}

// ============================================================================
// Validation Functions
// ============================================================================

/// Validates a filename for safe file system operations.
/// Only allows alphanumeric characters, dashes, underscores, and a single extension.
pub fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.chars().count() > 100 {
        return Err("Filename too long (max 100 characters)".to_string());
    }

    if !FILENAME_PATTERN.is_match(filename) {
        return Err(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed"
                .to_string(),
        );
    }

    Ok(())
}

/// Validates string input length (by character count, not bytes).
pub fn validate_string_input(input: &str, max_len: usize, field_name: &str) -> Result<(), String> {
    let char_count = input.chars().count();
    if char_count > max_len {
        return Err(format!("{field_name} too long (max {max_len} characters)"));
    }
    Ok(())
}

/// Validates theme value.
pub fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err("Invalid theme: must be 'light', 'dark', or 'system'".to_string()),
    }
}

/// Validates a stored onboarding version.
pub fn validate_onboarding_version(version: u32) -> Result<(), String> {
    if version > MAX_ONBOARDING_VERSION {
        return Err(format!(
            "Invalid onboarding version: must be at most {MAX_ONBOARDING_VERSION}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Preferences written before onboarding existed must still load, and must
    /// read as "never onboarded" rather than as "already done".
    #[test]
    fn preferences_without_an_onboarding_version_default_to_zero() {
        let prefs: AppPreferences =
            serde_json::from_str(r#"{"theme":"dark","quick_pane_shortcut":null,"language":null}"#)
                .expect("legacy preferences should still parse");

        assert_eq!(prefs.onboarding_version, 0);
    }

    #[test]
    fn a_stored_version_survives_a_round_trip() {
        let prefs = AppPreferences {
            onboarding_version: 3,
            ..AppPreferences::default()
        };
        let json = serde_json::to_string(&prefs).expect("serialises");
        let back: AppPreferences = serde_json::from_str(&json).expect("deserialises");

        assert_eq!(back.onboarding_version, 3);
    }

    #[test]
    fn rejects_a_version_from_the_future() {
        assert!(validate_onboarding_version(0).is_ok());
        assert!(validate_onboarding_version(MAX_ONBOARDING_VERSION).is_ok());
        assert!(validate_onboarding_version(MAX_ONBOARDING_VERSION + 1).is_err());
    }
}
