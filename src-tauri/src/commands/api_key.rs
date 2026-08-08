//! fal.ai API key entry, keychain storage and validation.
//!
//! The key lives in the OS keychain and is only ever read inside this module —
//! no command returns it, so it never reaches JavaScript, the DOM or
//! `preferences.json`. Validation is a real network call: a format check would
//! happily accept a revoked key and tell the user something false.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

/// Keychain service name. Together with the account below this identifies the
/// single entry the app owns; changing either orphans existing saved keys.
const KEYRING_SERVICE: &str = "ideo";
const KEYRING_ACCOUNT: &str = "fal-api-key";

/// Free validation endpoint (verified 2026-08-08): `200` plus a bare number for
/// a valid key, `401` for a bad, malformed or absent one, and no charge.
/// Note the underscore — the hyphenated `user-balance` returns 404.
const BALANCE_URL: &str = "https://rest.alpha.fal.ai/billing/user_balance";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A fal key is 69 characters (`uuid:hex32`). The cap only guards against
/// absurd input — the real check is the network call, not the shape.
const MAX_KEY_LEN: usize = 200;

/// What a validation attempt established. `Rejected` (the key is bad) and
/// `Unreachable` (we never got an answer) are deliberately separate: only the
/// first means the user needs to paste a different key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KeyCheckOutcome {
    /// The key works.
    Valid,
    /// The key was refused — wrong, revoked or malformed.
    Rejected,
    /// No key is stored.
    Missing,
    /// The check never completed — offline, DNS failure, timeout.
    Unreachable,
    /// The endpoint answered something we don't recognise.
    Unexpected,
}

/// Result of a validation attempt. Never contains the key itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct KeyCheck {
    pub outcome: KeyCheckOutcome,
    /// Account balance in USD, when the endpoint returned one. Doubles as a
    /// low-funds signal before expensive jobs.
    pub balance: Option<f64>,
    /// HTTP status, for `Unexpected` only.
    pub status: Option<u16>,
}

impl KeyCheck {
    fn new(outcome: KeyCheckOutcome) -> Self {
        Self {
            outcome,
            balance: None,
            status: None,
        }
    }
}

/// Trims a pasted key and rejects input that could never be a key.
/// Deliberately not a format check — see the module docs.
fn normalize_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();

    if key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    if key.chars().count() > MAX_KEY_LEN {
        return Err(format!("API key too long (max {MAX_KEY_LEN} characters)"));
    }

    // Internal whitespace or control characters mean a mis-paste, and would
    // also be rejected outright as an HTTP header value.
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("API key cannot contain spaces or line breaks".to_string());
    }

    Ok(key.to_string())
}

/// Maps an HTTP response to an outcome. Pure, so the classification is testable
/// without a network.
fn classify_status(status: u16, body: &str) -> KeyCheck {
    match status {
        200 => KeyCheck {
            balance: body.trim().parse::<f64>().ok(),
            ..KeyCheck::new(KeyCheckOutcome::Valid)
        },
        // Only 401 is verified as "bad key". A 403 could equally be a gateway
        // or WAF block, and calling that a bad key would send the user hunting
        // for a new one — exactly the false answer this check exists to avoid.
        401 => KeyCheck::new(KeyCheckOutcome::Rejected),
        other => KeyCheck {
            status: Some(other),
            ..KeyCheck::new(KeyCheckOutcome::Unexpected)
        },
    }
}

/// Asks fal whether this key works. Free — reads the account balance.
async fn validate_key(key: &str) -> KeyCheck {
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => {
            log::error!("Could not build the HTTP client: {e}");
            return KeyCheck::new(KeyCheckOutcome::Unreachable);
        }
    };

    let response = client
        .get(BALANCE_URL)
        .header("Authorization", format!("Key {key}"))
        .send()
        .await;

    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            classify_status(status, &body)
        }
        Err(e) => {
            // Log the transport failure, never the key.
            log::warn!("fal key validation could not reach the API: {e}");
            KeyCheck::new(KeyCheckOutcome::Unreachable)
        }
    }
}

/// Message handed to the user when the keychain itself misbehaves. The real
/// error goes to the log — see error-handling.md.
const KEYCHAIN_UNAVAILABLE: &str = "Could not reach the keychain";

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| {
        log::error!("Could not open the keychain entry: {e}");
        KEYCHAIN_UNAVAILABLE.to_string()
    })
}

/// Reads the stored key. Crate-visible on purpose — the key must not leave
/// Rust, so other modules making authenticated fal calls go through this rather
/// than asking the frontend for it.
pub(crate) fn stored_key() -> Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            log::error!("Could not read the key from the keychain: {e}");
            Err(KEYCHAIN_UNAVAILABLE.to_string())
        }
    }
}

/// Whether a key is stored. Local only — no network, no key returned.
#[tauri::command]
#[specta::specta]
pub fn has_fal_api_key() -> Result<bool, String> {
    Ok(stored_key()?.is_some())
}

/// Validates a pasted key and stores it in the keychain if it works.
///
/// A key that fails validation is not stored, so a saved key is always one that
/// worked at least once. Saving over an existing key replaces it.
#[tauri::command]
#[specta::specta]
pub async fn save_fal_api_key(key: String) -> Result<KeyCheck, String> {
    let key = normalize_key(&key)?;

    let check = validate_key(&key).await;

    if check.outcome != KeyCheckOutcome::Valid {
        log::info!("fal key not saved, validation outcome: {:?}", check.outcome);
        return Ok(check);
    }

    keychain_entry()?.set_password(&key).map_err(|e| {
        log::error!("Could not save the key to the keychain: {e}");
        KEYCHAIN_UNAVAILABLE.to_string()
    })?;

    log::info!("fal key validated and saved to the keychain");
    Ok(check)
}

/// Re-validates the stored key against the live API.
#[tauri::command]
#[specta::specta]
pub async fn check_fal_api_key() -> Result<KeyCheck, String> {
    let Some(key) = stored_key()? else {
        return Ok(KeyCheck::new(KeyCheckOutcome::Missing));
    };

    let check = validate_key(&key).await;
    log::info!("stored fal key check outcome: {:?}", check.outcome);
    Ok(check)
}

/// Removes the stored key. Succeeds when there was nothing to remove.
#[tauri::command]
#[specta::specta]
pub fn clear_fal_api_key() -> Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) => {
            log::info!("fal key cleared from the keychain");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            log::error!("Could not clear the key from the keychain: {e}");
            Err(KEYCHAIN_UNAVAILABLE.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_surrounding_whitespace() {
        assert_eq!(normalize_key(" abc \n").unwrap(), "abc");
    }

    #[test]
    fn normalize_rejects_blank_input() {
        assert!(normalize_key("").is_err());
        assert!(normalize_key("   ").is_err());
    }

    #[test]
    fn normalize_rejects_embedded_whitespace() {
        assert!(normalize_key("ab cd").is_err());
        assert!(normalize_key("ab\ncd").is_err());
    }

    #[test]
    fn normalize_rejects_absurdly_long_input() {
        assert!(normalize_key(&"a".repeat(MAX_KEY_LEN + 1)).is_err());
    }

    #[test]
    fn ok_with_bare_number_is_valid_with_balance() {
        let check = classify_status(200, "9.9416");
        assert_eq!(check.outcome, KeyCheckOutcome::Valid);
        assert_eq!(check.balance, Some(9.9416));
    }

    #[test]
    fn ok_with_unparsable_body_is_still_valid() {
        let check = classify_status(200, "");
        assert_eq!(check.outcome, KeyCheckOutcome::Valid);
        assert_eq!(check.balance, None);
    }

    #[test]
    fn unauthorized_is_rejected() {
        assert_eq!(classify_status(401, "").outcome, KeyCheckOutcome::Rejected);
    }

    #[test]
    fn forbidden_is_not_claimed_to_be_a_bad_key() {
        // Only 401 was verified as "bad key"; 403 could be a gateway block.
        assert_eq!(
            classify_status(403, "").outcome,
            KeyCheckOutcome::Unexpected
        );
    }

    #[test]
    fn other_statuses_are_unexpected_and_carry_the_code() {
        let check = classify_status(500, "boom");
        assert_eq!(check.outcome, KeyCheckOutcome::Unexpected);
        assert_eq!(check.status, Some(500));
    }

    #[test]
    fn rejected_is_distinguishable_from_unreachable() {
        assert_ne!(
            classify_status(401, "").outcome,
            KeyCheckOutcome::Unreachable
        );
    }
}
