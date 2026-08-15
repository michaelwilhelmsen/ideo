# ADR 0004 — The index carries derived presentation data

**Status:** Accepted
**Date:** 2026-08-15
**Issue:** #42

## Context

The SQLite index summarises projects: id, name, aspect, timestamps, a
generation count, a directory. It holds nothing per generation, and it points at
no files. Its guarantee is that deleting it is a non-event — it rebuilds from
the manifests on disk, which are the source of truth (#23).

A project card needs a picture. Pointing it at the original asset is the obvious
move and the wrong one: the style stage emits 4.7–5.0 MB PNGs, so a grid of
twenty cards decodes on the order of a hundred megabytes to draw small pictures,
and a finished clip currently renders as an autoplaying video element — twenty
of which is twenty decoders.

The index has to store _something_ for the card to point at either way, because
it holds no per-generation data today. So the question is only whether that
pointer names an original or a purpose-built thumbnail.

## Decision

Thumbnails are generated when a result is collected, written beside the asset,
and the index stores the path.

Images are resized in Rust, reusing the decode/resize path that already exists
for shrinking inputs before they are sent. Video posters are captured in the
webview — a frame drawn to a canvas and handed back to be saved — because the
alternative is an ffmpeg-class dependency for one frame.

The index also gains what the card needs to order and label itself, including a
notion of recency defined by the newest generation rather than by the project's
`updated_at` — a project should not lead the grid because it was renamed.

## Consequences

- The rebuild guarantee **extends to thumbnails**. They are derived data: delete
  them, or delete the index, and both come back from the manifests and assets.
  Nothing in a thumbnail may be unrecoverable.
- Assets are now written in two places for one result — the original and its
  thumbnail. Anything that measures or cleans up a project's footprint has to
  know about both, or it will report a size that does not match the folder and
  offer to reclaim files it cannot see.
- The webview-side video capture is the fragile part of this decision: it needs
  a real video element, a seek, and a round trip, triggered by collection rather
  than by anything the user did. If it proves unreliable, the documented
  fallback is originals with `preload="metadata"` for video — which fixes the
  decoder problem and leaves the image-size problem standing.
