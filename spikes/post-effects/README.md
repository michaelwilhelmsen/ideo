# spike: post-effects (#52)

Throwaway spike code. **Not part of the app** — `src-tauri` is its own package with no
workspace, so nothing here is compiled by a normal build, and nothing in `src-tauri` may
depend on it.

It answers the two measure-then-decide questions that [#36](https://github.com/michaelwilhelmsen/ideo/issues/36)
was blocked on:

1. Does duotone quantise first, or colourise last?
2. What is preview latency, actually?

The answers live in [`docs/research/post-effects-measured.md`](../../docs/research/post-effects-measured.md).
This directory is the code that produced them, kept so the numbers can be re-run rather
than taken on trust.

## Running it

```bash
cargo run --release --bin duotone-ab -- --out ~/ideo-spike-52
cargo run --release --bin bench -- --out ~/ideo-spike-52
```

Both read three of the app's own generated outputs from
`~/Library/Application Support/com.ideo.app/projects/` (paths in `src/lib.rs`) and write
everything **outside the repository** — 60 contact sheets, `stats.md` and `latency.md`,
about 400 MB. That output is derived from local user images and is not committed.

`cargo test` is the part worth keeping honest: it holds the sRGB round trip exact over all
256 bytes, pins the published dither constants, and asserts that the parallel error
diffusion is byte-identical to the serial one — without which the parallel timing would be
measuring a different picture.

## What is worth stealing for #36

- `color.rs` — the exact sRGB transfer function, and `SrgbEncodeTable`, which turned out to
  matter more than any kernel choice.
- `dither.rs` — the canonical Bayer, clustered-dot, Floyd–Steinberg and Atkinson constants,
  with `row_lead` derived from the stencil rather than hardcoded.
- `orders.rs` — the two candidate pipelines, and the reason there is a third.

## What is not worth stealing

- `diffusion.rs`'s pipelined parallel path. It is exact, and it is 5× slower than the
  serial loop. It is kept because "we tried it and it lost" is a result, not because
  anything should use it.
- The kernels in `kernels.rs` have no parameters and no video path. They exist to be timed.
