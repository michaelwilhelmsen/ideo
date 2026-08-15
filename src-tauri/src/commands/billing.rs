//! Reading what fal actually charged (ADR 0003).

use crate::billing::{self, BillingCharge};
use crate::commands::api_key;

/// Every charge fal recorded between two moments, in milliseconds since the
/// epoch — the window clamped to fal's 90 days on the way past.
///
/// One call for the whole library rather than one per project: the endpoint is
/// keyed by request id and knows nothing about our folders, so a per-project
/// sweep would be the same pages fetched N times.
///
/// Fails rather than answering emptily when there is no key, which is the same
/// thing an offline machine or a refused request does. That distinction is the
/// caller's whole safety net: a pass that did not read the window must not move
/// the watermark over it.
#[tauri::command]
#[specta::specta]
pub async fn fal_billing_events(start_ms: f64, end_ms: f64) -> Result<Vec<BillingCharge>, String> {
    let key = api_key::stored_key()?.ok_or("No fal API key is stored")?;

    billing::charges_between(&key, start_ms, end_ms).await
}
