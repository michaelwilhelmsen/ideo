# ADR 0003 — Cost is estimated at submit and reconciled against fal

**Status:** Accepted
**Date:** 2026-08-15
**Issue:** #42

## Context

The app has always shown cost as an *estimate*: a static price table, dated with
the day each price was read, multiplied by the request's basis. It is presented
honestly — a leading tilde, the word "approximate", and the verification date —
and it exists to tell you what a click is about to cost before you make it.

Showing cost per project on the overview is a different question. That number
is not a forecast; it is a claim about money already spent. An estimate stamped
in amber will never reconcile against the fal invoice, and the gap between them
is exactly the thing a per-project cost is meant to answer.

fal exposes per-request billing: a billing-events endpoint returning records
keyed by `request_id`, carrying `cost_total` as a real USD figure. Three limits
matter. The date range is **capped at 90 days**. It lives on a different host
from the queue. And we currently destroy the only link to it — `request_id`
lives on the job row, and claiming a collected job takes that row off the books.

## Decision

Cost is recorded twice, at different confidences.

1. **At submit**, the estimate is stamped onto the generation, using the price
   table as it read that day. History stops moving when prices drift.
2. **Later**, actual charges are fetched from fal's billing events and replace
   the estimate for that generation. Reconciliation runs when the overview
   opens, against a persisted watermark of the last successful reconcile, so a
   user who has been away catches up in one call.

`request_id` is persisted onto the generation so there is something to join on.

A displayed total is exact only when **every** generation in it is reconciled.
Otherwise it keeps the tilde the app already uses for estimates. A generation
that can be neither estimated nor reconciled — a token-priced model, older than
the billing window — contributes nothing to the sum and is named, so that
"unknown" and "free" never look the same.

## Consequences

- The 90-day cap means estimates are **permanent** for old work, not merely a
  fallback for a failed call. A project untouched for three months keeps its
  tilde forever.
- Reconciliation is best-effort by construction: no API key, no network, or a
  failed call leaves the estimate in place and the watermark unmoved. The
  overview must be usable when it never succeeds.
- Token-priced models gain a cost they never had. There is no per-image number
  to estimate from, but there is a real charge to reconcile to — within the
  window.
- This introduces the first client against fal's platform API rather than the
  queue. Authenticated calls stay in Rust, as all of them do, so the key does
  not reach the webview.
