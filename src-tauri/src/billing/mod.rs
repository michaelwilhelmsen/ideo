//! fal's billing events — what a request actually cost (ADR 0003).
//!
//! The first client against fal's *platform* API rather than its queue, and a
//! different host from `jobs::fal` for that reason. It is here rather than in
//! `jobs` because it is not about a job: a job is a thing in flight, and this
//! answers a question about work that finished, possibly months ago, possibly
//! on another machine signed into the same account.
//!
//! Authenticated in Rust like every other fal call, so the key never reaches
//! the webview (PRD §3.1).
//!
//! Three of fal's limits shape everything below, all confirmed against
//! <https://fal.ai/docs/platform-apis/v1/models/billing-events>:
//!
//! - the date range is capped at **90 days**, which is why the window is
//!   clamped here rather than trusted from the caller;
//! - results are cursor-paginated, so one answer is a loop and not a call;
//! - `start` defaults to 24 hours ago, so an absent range is silently a very
//!   small one — the caller always names both ends.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::time::Duration;

const BILLING_EVENTS_URL: &str = "https://api.fal.ai/v1/models/billing-events";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// fal's hard cap on how far back one query may reach.
const WINDOW_MS: f64 = 90.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// fal's maximum page size. Asked for explicitly: a reconciliation covering
/// three months of work wants the fewest round trips it can have.
const PAGE_LIMIT: u32 = 10_000;

/// A backstop on the cursor loop, not a coverage limit: at `PAGE_LIMIT` events
/// a page, this is a million billing events — far past anything a design tool
/// produces in 90 days, and the only thing standing between a cursor that never
/// says it is done and a loop that never ends.
const MAX_PAGES: usize = 100;

/// What fal charged for one request.
///
/// Two fields out of the eleven the endpoint returns. The rest — the endpoint
/// id, the discount breakdown, the auth method — describe a request we already
/// have a recipe for; this exists to answer "what did that actually cost", and
/// carrying more would be a second, worse copy of the manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BillingCharge {
    /// fal's own id for the call — the only thing a generation can be joined
    /// on, which is why it is persisted at collection (ADR 0003).
    pub request_id: String,
    /// `cost_total`, in USD. fal bills in dollars wherever the account is.
    pub cost_usd: f64,
}

/// One page of billing events, and where the next one starts.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub charges: Vec<BillingCharge>,
    /// `None` when this is the last page — either because `has_more` said so,
    /// or because there is no cursor to ask with, which amounts to the same
    /// thing and must not be read as "start again from the beginning".
    pub next_cursor: Option<String>,
}

/// One page's JSON, as charges.
///
/// Pure, so the shape fal returns is testable without a network. An event
/// missing either field is skipped rather than failing the page: a record we
/// cannot join or cannot price contributes nothing, and refusing the other
/// 9,999 over it would strand a whole reconciliation pass.
pub fn read_page(body: &str) -> Result<Page, String> {
    let document: Value = serde_json::from_str(body)
        .map_err(|e| format!("fal's billing events were not JSON: {e}"))?;

    let events = document
        .get("billing_events")
        .and_then(Value::as_array)
        .ok_or("fal's billing events had no billing_events array")?;

    let charges = events
        .iter()
        .filter_map(|event| {
            Some(BillingCharge {
                request_id: event.get("request_id")?.as_str()?.to_string(),
                cost_usd: event.get("cost_total")?.as_f64()?,
            })
        })
        .collect();

    // Both halves have to agree before another call is made. `has_more` with no
    // cursor is a page we cannot ask for, and a cursor without `has_more` is one
    // fal has said not to.
    let has_more = document
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next_cursor = document
        .get("next_cursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_string);

    Ok(Page {
        charges,
        next_cursor: if has_more { next_cursor } else { None },
    })
}

/// Follows the cursor to the end, whatever is doing the fetching.
///
/// Generic over the fetch so the pagination itself is testable — the part that
/// can loop forever, drop a page or re-ask for the first one is the part with
/// no network in it.
pub async fn collect_pages<F, Fut>(mut fetch: F) -> Result<Vec<BillingCharge>, String>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<Page, String>>,
{
    let mut charges = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let page = fetch(cursor.clone()).await?;
        charges.extend(page.charges);

        match page.next_cursor {
            // A partial answer is worse than none here: the caller advances a
            // watermark on success, and a truncated pass would mark a span
            // reconciled that never was.
            Some(next) => cursor = Some(next),
            None => return Ok(charges),
        }
    }

    Err("fal's billing events did not stop paginating".to_string())
}

/// Every charge fal recorded in a window, clamped to what it will answer.
///
/// The clamp is deliberate and silent: 90 days is fal's rule, not a preference,
/// and a caller asking for a year is asking for something that does not exist.
/// What that costs is spelled out in ADR 0003 — work older than the window is
/// permanently unreconcilable, and keeps its estimate rather than waiting.
pub async fn charges_between(
    key: &str,
    start_ms: f64,
    end_ms: f64,
) -> Result<Vec<BillingCharge>, String> {
    let end = end_ms;
    let start = start_ms.max(end - WINDOW_MS).min(end);

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not build the billing client: {e}"))?;

    let start_at = iso8601_utc(start);
    let end_at = iso8601_utc(end);

    collect_pages(|cursor| {
        let client = client.clone();
        let start_at = start_at.clone();
        let end_at = end_at.clone();

        async move {
            let mut request = client
                .get(BILLING_EVENTS_URL)
                .header("Authorization", format!("Key {key}"))
                .query(&[
                    ("start", start_at.as_str()),
                    ("end", end_at.as_str()),
                    ("limit", &PAGE_LIMIT.to_string()),
                ]);

            if let Some(cursor) = cursor.as_deref() {
                request = request.query(&[("cursor", cursor)]);
            }

            let response = request.send().await.map_err(|e| {
                // The transport failure, never the key.
                log::warn!("Could not reach fal's billing events: {e}");
                "Could not reach fal's billing events".to_string()
            })?;

            let status = response.status();
            let body = response.text().await.unwrap_or_default();

            if !status.is_success() {
                // A plain key is not necessarily allowed here — the endpoint is
                // documented as admin-scoped. That reads as a refusal like any
                // other: the pass fails, the watermark stays, the estimates
                // stand.
                log::warn!("fal refused the billing events request: {status}");
                return Err(format!("fal refused the billing events request: {status}"));
            }

            read_page(&body)
        }
    })
    .await
}

/// Milliseconds since the epoch as the `YYYY-MM-DDTHH:MM:SSZ` fal asks for.
///
/// Hand-rolled rather than pulling in a date library for one format call. The
/// civil-from-days conversion is Howard Hinnant's, which is the same arithmetic
/// every such library does underneath.
fn iso8601_utc(ms: f64) -> String {
    let total_seconds = (ms / 1000.0).floor() as i64;
    let days = total_seconds.div_euclid(86_400);
    let seconds = total_seconds.rem_euclid(86_400);

    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60,
    )
}

/// Days since 1970-01-01 as a calendar date, proleptic Gregorian.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };

    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn page(events: &str, has_more: bool, cursor: &str) -> String {
        format!(r#"{{"billing_events":[{events}],"has_more":{has_more},"next_cursor":"{cursor}"}}"#)
    }

    #[test]
    fn a_page_reads_as_the_charges_it_carries() {
        let page = read_page(&page(
            r#"{"request_id":"req-1","endpoint_id":"fal-ai/flux","cost_total":0.04},
               {"request_id":"req-2","cost_total":0.0}"#,
            false,
            "",
        ))
        .unwrap();

        assert_eq!(
            page.charges,
            vec![
                BillingCharge {
                    request_id: "req-1".to_string(),
                    cost_usd: 0.04,
                },
                // Zero is a real charge, and not the same answer as no record.
                BillingCharge {
                    request_id: "req-2".to_string(),
                    cost_usd: 0.0,
                },
            ]
        );
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn an_event_we_cannot_join_or_price_is_skipped_rather_than_failing_the_page() {
        let page = read_page(&page(
            r#"{"endpoint_id":"fal-ai/flux","cost_total":0.04},
               {"request_id":"req-2"},
               {"request_id":"req-3","cost_total":0.02}"#,
            false,
            "",
        ))
        .unwrap();

        assert_eq!(page.charges.len(), 1);
        assert_eq!(page.charges[0].request_id, "req-3");
    }

    #[test]
    fn a_cursor_is_only_followed_when_fal_says_there_is_more() {
        // `has_more` and a cursor have to agree, or a pass either stops early
        // or asks for a page fal has already said does not exist.
        let more = read_page(&page(r#"{"request_id":"a","cost_total":1.0}"#, true, "abc")).unwrap();
        assert_eq!(more.next_cursor, Some("abc".to_string()));

        let done = read_page(&page(
            r#"{"request_id":"a","cost_total":1.0}"#,
            false,
            "abc",
        ))
        .unwrap();
        assert_eq!(done.next_cursor, None);

        let no_cursor =
            read_page(r#"{"billing_events":[],"has_more":true,"next_cursor":null}"#).unwrap();
        assert_eq!(no_cursor.next_cursor, None);
    }

    #[test]
    fn a_response_that_is_not_a_page_is_an_error_rather_than_an_empty_answer() {
        // An empty answer would advance the watermark over a span nothing was
        // read from.
        assert!(read_page("not json").is_err());
        assert!(read_page(r#"{"detail":"Unauthorized"}"#).is_err());
    }

    #[tokio::test]
    async fn every_page_is_followed_to_the_end() {
        let asked: RefCell<Vec<Option<String>>> = RefCell::new(Vec::new());

        let charges = collect_pages(|cursor| {
            asked.borrow_mut().push(cursor.clone());
            async move {
                Ok(match cursor.as_deref() {
                    None => Page {
                        charges: vec![BillingCharge {
                            request_id: "req-1".to_string(),
                            cost_usd: 0.01,
                        }],
                        next_cursor: Some("page-2".to_string()),
                    },
                    Some("page-2") => Page {
                        charges: vec![BillingCharge {
                            request_id: "req-2".to_string(),
                            cost_usd: 0.02,
                        }],
                        next_cursor: Some("page-3".to_string()),
                    },
                    _ => Page {
                        charges: vec![BillingCharge {
                            request_id: "req-3".to_string(),
                            cost_usd: 0.03,
                        }],
                        next_cursor: None,
                    },
                })
            }
        })
        .await
        .unwrap();

        let ids: Vec<&str> = charges.iter().map(|c| c.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-1", "req-2", "req-3"]);
        assert_eq!(
            *asked.borrow(),
            vec![None, Some("page-2".to_string()), Some("page-3".to_string())]
        );
    }

    #[tokio::test]
    async fn a_failed_page_fails_the_pass_rather_than_returning_what_it_had() {
        // The caller advances a watermark on success. Half an answer here would
        // mark a span reconciled that was never read.
        let result = collect_pages(|cursor| async move {
            match cursor {
                None => Ok(Page {
                    charges: vec![BillingCharge {
                        request_id: "req-1".to_string(),
                        cost_usd: 0.01,
                    }],
                    next_cursor: Some("page-2".to_string()),
                }),
                Some(_) => Err("offline".to_string()),
            }
        })
        .await;

        assert_eq!(result, Err("offline".to_string()));
    }

    #[tokio::test]
    async fn a_cursor_that_never_ends_stops_rather_than_looping_forever() {
        let result = collect_pages(|_| async move {
            Ok(Page {
                charges: Vec::new(),
                next_cursor: Some("again".to_string()),
            })
        })
        .await;

        assert!(result.is_err());
    }

    #[test]
    fn a_timestamp_crosses_as_the_iso_string_fal_asks_for() {
        assert_eq!(iso8601_utc(0.0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1_700_000_000_000.0), "2023-11-14T22:13:20Z");
        // A leap day, which is the arithmetic worth checking.
        assert_eq!(iso8601_utc(1_709_164_800_000.0), "2024-02-29T00:00:00Z");
    }
}
