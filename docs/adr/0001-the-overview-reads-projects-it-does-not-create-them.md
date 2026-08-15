# ADR 0001 — The overview reads projects, it does not create them

**Status:** Accepted
**Date:** 2026-08-15
**Issue:** #42

## Context

The app's front door was to become an overview of results rather than the
three-panel editor. The question underneath that is whether a generation can
exist before the project that holds it.

Today it cannot, and deliberately so. A job is keyed by project id, its result
is written into `<project>/assets/`, and the manifest that records the recipe
lives beside it. Disk is the source of truth (#23), and the project folder is
what "disk" means.

An overview where you type a prompt and generate — with a project minted
implicitly behind you, or a generation living somewhere that is not a project
yet — inverts that. It is a coherent design, but it is a change to project
identity, not a new view.

## Decision

The overview is a **reader**. It shows projects that already exist, and their
work. Project creation stays explicit.

Prompt-first entry — typing a prompt with no project chosen, and a project
appearing around it — is a separate decision, recorded separately if it is ever
taken. The quick pane belongs to that decision rather than to the overview: its
natural design is precisely the inversion this ADR declines.

## Consequences

- The overview needs no change to storage, to job keying, or to the manifest.
  What it needs is navigation, a cross-project view of work, and presentation
  data. Those are the subject of the other ADRs here.
- The friction the overview was partly meant to remove — choosing a project
  before your first prompt — **remains**. This is the known cost. If it proves
  to be the real complaint, this ADR is the one to reopen, and reopening it
  means revisiting #23's model rather than adjusting a view.
- Because creation stays explicit, the _New project_ action needs a home on the
  overview once the sidebar that used to host it is gone.
