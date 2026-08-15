# ADR 0002 — Collection is not bound to the open project

**Status:** Accepted
**Date:** 2026-08-15
**Issue:** #42

## Context

A generation outlives the click that started it (#24). Rust writes the job down
before it polls, and the result is _collected_ — written into the project's
manifest — either when a settled event arrives or when a project is opened and
the store is asked what it has been holding.

"Collection happens on open" has been a rule you could reason about. It is also
why a sweep on open makes a quit survivable: opening a project is the one
trigger that does not depend on this session having been running to hear an
event.

The overview breaks the assumption behind that rule. Its cards show projects
that are not open, and the point of the front door is watching results arrive.
A card that only refreshes when you navigate into its project is a status
readout, not an arrival.

Both queries that back this are project-scoped down to the SQL: the job store
selects `WHERE project_id = ?`. There is no way to ask what is running
everywhere.

## Decision

Two changes, together:

1. Jobs can be queried **across all projects**, not only for one.
2. Collection can run for a project that is **not open**. A job settling for a
   closed project is written into that project's manifest, and its card updates.

The rule becomes: collection happens on open **and** while the overview is up.

## Consequences

- The job row remains the source of truth until claimed, so crash-safety is
  unchanged: a result is never lost by being collected from a different place.
- **Collection must be idempotent or serialised.** The same project can now be
  collected by the overview and by being opened at nearly the same moment. This
  is the new hazard this ADR introduces, and it is the one worth a test rather
  than a comment.
- The app now writes to manifests of projects the user is not looking at,
  driven by a view being open. That is a real widening of what a view is allowed
  to do, and it should not be extended further without another decision here.
