# Effects

The fourth tab: a **look** applied to a generation, previewed live in WebGL2, and
persisted as a **treatment** on the candidate it was applied to (#36).

Diffusion models are bad at exactly the effects that are trivial and
deterministic in a pixel shader. This is where we stop asking them.

## The shape

**A tab, not a stage.** No model, no seed, no price, no queue, no batch of four,
no verdicts — so "generate four and pick one" is the wrong interaction. Widening
`StageKind` would reach `readDrafts`, `modelById`, `DEFAULT_MODEL_IDS` and
`validateRegistry`, none of which a modelless tab can answer. Instead
`EditorState` carries two extra fields:

| Field             | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `effectsOpen`     | Whether the effects panel is the one on screen                |
| `treatmentTarget` | The candidate it is pinned to, or `null` to follow the canvas |

`selectedNodeId` means "which node's form the sidebar edits" (ADR 0005). The pin
is sticky so a selection change elsewhere cannot move you onto a different
generation's treatment mid-edit.

**The picture is in the main pane; the knobs are in the right sidebar.** That is
the layout the canvas keeps, so which column to reach for never changes.
`EffectsParameters` replaces `NodeParameters` while the panel is open — an effect
has no model, no seed and no price, so a node's form under the knobs would be a
form about something you are not looking at. The export panel stays put, because
export is available whatever is selected and is what a treatment is for.

Both panes are siblings in the layout rather than parent and child, so they
share `useTreatmentTarget()` rather than passing the target down through a
component that owns neither.

**What it treats is chosen, not inherited.** `useTreatmentTarget` offers every
node's current `pick` as `choices`, and the header renders them as a switch —
"halftone the still" and "halftone the clip" are different jobs done in the same
place. Unpinned, it falls to the **selected node's** pick, then to the last node
with anything to show. Following a _tab_ meant opening Effects from the source tab
silently treated the source while a finished clip sat one tab away, and since a
treatment is stored per generation, the knobs you turned landed on a candidate you
were not looking at. The canvas makes "what you were looking at" answerable, which is
why the selected node now sits second rather than last. This is not cosmetic —
`valuesForMedium` substitutes blue noise for error diffusion on a clip, so the two
targets do not offer the same knobs.

"Treat this" survives for the case the switch cannot reach: a candidate node can be
double-clicked even when it is not its node's pick, and the switch deliberately lists
only picks.

## A look

One authored effect with knobs — **not a stack the user assembles**. That is
load-bearing: a duotone pass followed by a dither pass produces nothing, because
the first leaves no tonal information for the second to distribute. With one
authored look per entry the shader does the whole thing correctly by
construction, and every look in the library produces something.

Two declarations, in two places, kept honest by one check:

- **The shader** is ours, keyed by `EffectShader`, and it is code. A fork cannot
  invent one.
- **The knobs** are data, in `src/lib/effects/looks.json`, declared once per
  look. That single declaration drives the rendered control
  (`EffectKnobs.tsx`), the validation of a hand-edited fork
  (`coerceKnobValue`), and the shader's uniform binding (`u_<key>`).

`SHADER_KNOBS` names which keys each shader reads, and the loader refuses a look
that declares a knob its shader has never heard of or omits one it needs. That
is a _coupling_ check, not a second declaration.

Two looks may share a shader with different defaults — that is the growth path.
The first library ships one look per shader because six looks is what #36
promises.

### Adding a look

1. Add an entry to `looks.json` naming an existing `shader`, with exactly that
   shader's knobs.
2. Add `effects.knob.<key>` and `effects.option.<key>.<value>` strings to
   `/locales/*.json` if it uses a knob or option nothing else does.

That is all. No form, no validator, no binding code.

### Adding a shader

1. Write the fragment body in `gl/shaders.ts`, reading `u_<key>` per knob.
2. Add the id to `EFFECT_SHADERS` and its knob keys to `SHADER_KNOBS`.
3. Add at least one look that names it — a shader nothing names is unreachable,
   and a test says so.

## A treatment

`Generation.treatment` — resolved knob values, plus the look's id, plus a
`lookModified` flag. The same provenance pattern `StageRecipe` uses with
`presetId` / `presetModified`, and for the same reason: a record that resolves
against a mutable library at read time is not a record.

Deliberately **outside `recipe`**: a recipe is the frozen record of what was sent
to a model, and an effect was never sent to anything.

Values are **resolved**, never references. A colour knob whose default names the
palette role `ink` is stored as the hex it resolved to, so editing the project's
palette cannot reach back into an image somebody already approved — the same
argument #46 settled for `{{primary}}`.

It has its own reader in `lib/effects/treatment.ts` rather than going through
`readParams`, which drops what it does not recognise by design. The failure mode
that reader would cause is silent: the project reopens looking like nobody ever
treated anything.

A treatment is **not** validated against the library on the way in — a look can
be forked, renamed, or live in a folder this build has not loaded. Values are
held to their knobs at render time (`resolveTreatment`), where a wrong value has
a consequence.

## Where a look renders

**WebGL2 in the webview, for the preview and the bake.** One program, so the
exported file cannot disagree with what was on screen. WebGPU is not an option:
three webview engines ship and GLSL ES 3.00 is the baseline everywhere.

No WebGL2 disables the tab with a reason. There is no CPU fallback for the
shader looks — that would mean porting six effects to a second implementation
which only runs on machines we do not have.

**The one exception: Floyd–Steinberg and Atkinson.** Error diffusion decides each
pixel from pixels already decided, which a fragment shader cannot express. Those
go to `src-tauri/src/effects/`, **stills only**, and come back as a PNG (a
full-resolution frame is ~11 MB raw; dithered output compresses hard). On a clip
they are disabled with the reason attached — _error diffusion crawls between
frames; blue noise holds still_ — rather than hidden or silently substituted.

Being the exception ends there. They meet the export cap and follow the
export size like every other look, and the size is decided in
`commands::effects` rather than in either caller: it reads the asset's header
and calls the same `bake::shipped_size` the bake does, on the same file, so the
frame arrives at exactly the resolution `begin_bake` promised. The cap belongs
at the command because it is export policy and `effects::render` is pixels; it
does not belong in the request because the effects tab cannot answer it — a
`Generation` records no dimensions, so the tab would have to decode the source
in the webview to learn a number Rust is holding the bytes for. Both callers
name an `ExportSize` instead, which is what the shader path names too. Resampling
happens in linear light and before the reduction, which is the same requirement
as everywhere else on this page: luminance is a linear combination of linear
channels, so averaging the plane and averaging the pixels give the same number,
and averaging sRGB bytes would darken every edge it touched. It is area-averaged
rather than bilinear, because the tone a dither distributes has to be the tone of
the whole area rather than of a sample near the middle of it.

**Blue noise** is the video-safe substitute: a void-and-cluster mask, fully
parallel and temporally stable by construction. Generated by us
(`scripts/generate-blue-noise.mjs` → `gl/blue-noise.ts`, deterministic seed)
rather than lifted from a published set, whose terms are usually vague or
non-commercial and this texture ends up in files users ship commercially.

## Colour

Both paths work in **linear light** and must agree within a byte.

- The GPU gets sRGB→linear free from `SRGB8_ALPHA8` sampling, which is also
  _correctly filtered_ in linear space. Every shader encodes on the way out,
  because the drawing buffer is sRGB.
- The CPU path uses the exact IEC 61966-2-1 transfer plus a sqrt-indexed
  4096-entry encode table, lifted from `spikes/post-effects/src/color.rs` —
  which #52 measured as the most expensive _mandatory_ step in the whole set.

If the two disagreed, a duotone would visibly shift the moment somebody switched
from an ordered kernel to a diffusion one: same inks, same image, no
explanation.

The pipeline is #52's verdict in both paths: **dither the luminance to an
N-level mask, then map the mask to inks.** Reduction and dither are one fused
pass, not two.

## Baking it into an export

A bake is a conversation, because the shader is in the webview and the encoder
is in Rust:

1. `begin_bake` makes a scratch folder under app data, works out the **export
   resolution**, and — for a clip — has ffmpeg decode every frame into it at
   that size.
2. The webview renders each frame through the same program that drew the
   preview and posts the PNG back with `write_baked_frame`.
3. `finish_bake` encodes every deliverable from the treated frames and clears
   the folder.

**Rendered at the export resolution, not before it.** Exports cap the long edge
at 1920 by default; a pattern rendered before that scaling is destroyed
by it, so the frames are extracted already capped and `Input::Treated*` tells
`plan()` not to scale them again. `shipped_size` computes the same dimensions
the untreated filter graph would produce, because turning a treatment on must
not silently resize the deliverable.

**Bigger exports scale the pattern with them (#58).** The export size is a
choice (`docs/developer/export.md`), and `ExportSize::pattern_scale` turns it into
`uScale` — how many output pixels one _look_ pixel is worth. Every shader
divides its pattern coordinates by it (`patternCoord()`, or a cell multiplied on
the way out), so a 2× export is the same screen resolved by four times the
pixels rather than a screen twice as fine. That is what lets the preview go on
drawing at the web width and still be telling the truth about the file.

**The two kernels answer the same way, in two grids rather than a uniform.**
`render_treated_still` takes an `ExportSize` like everything else and turns it
into a `Grid`: the luminance plane is resampled to the **look** size — the web
width, which is what the tab previews — the dither runs there, and the decided
frame is magnified onto the **shipped** size nearest-neighbour. That is
`pattern_scale` by other means: a look pixel becomes a 2×2 block at `double`, or
one and two output pixels in turn at a fractional `native`, which is what a
nearest-neighbour magnification by 1.333 is. Nearest and never a filter — every
pixel is already an ink, and a second tap would average two of them into a
colour the reduction exists to have removed. Diffusing straight onto the shipped
grid would be the finer screen #58 rejected; resampling after the dither would
blur the dots it just decided.

**Frames cross by disk.** ~11 MB per raw frame is gigabytes for a five-second
clip; source frames load through Tauri's asset protocol and treated ones come
back as PNG, which dithered output compresses hard.

**Progress and cancel belong to the webview**, and there is no event channel for
either. The frame count is known before the first frame and the webview is doing
the per-frame work, so a determinate bar and a cancel that actually stops are
just properties of the loop it is already running (`lib/effects/bake.ts`, pure
and tested without a canvas).

**Temp survives a crash** because nothing relies on running at exit: every bake
lives under one directory and `bake::sweep` empties it at startup.

**A toggle, on by default.** "Give me the clean plate" is a real need — comparing,
or handing the untreated image to someone else — and without the toggle the only
way to get one would be to destroy the treatment. All deliverables carry the
treatment or none do: a clean poster advertising a dithered video is a lie about
the file it represents.

## Testing

Four seams, all of them pre-existing shapes:

| Seam               | File                            | Covers                                                                 |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| The library loader | `lib/effects/looks.test.ts`     | Bad ranges, unknown shaders, forks that must not take the library down |
| The treatment      | `lib/effects/treatment.test.ts` | Manifest round-trip, #53 seeding, knob validation                      |
| The reducer        | `lib/recipe/reducer.test.ts`    | Pinning, choosing, nudging, never re-seeding over an edit              |
| The CPU kernel     | `src-tauri/src/effects/`        | Diffusion stencils, the fused pass, the colour transfer                |
| The export plan    | `src-tauri/src/export/plan.rs`  | The treated path's steps, resolution and deliverable set               |
| The frame loop     | `lib/effects/bake.test.ts`      | Determinate progress, a cancel that stops                              |

### The colour parity gap, stated plainly

#36's "Done when" asks that _"GPU and CPU colour agree within the tested
tolerance"_, asserted on a golden image. **That golden image does not exist
yet.** What exists instead:

- `color.rs` pins the Rust transfer exhaustively over all 256 bytes.
- `inks.test.ts` pins the TypeScript transfer to the same numbers.
- `gl/shaders.test.ts` asserts every shader carries the exact IEC 61966-2-1
  constants and the sRGB luminance weights — so a shader quietly rewritten as
  `pow(x, 1/2.2)` fails CI.

That is agreement _by construction and by coupling check_, not agreement
measured on pixels. The measured version needs a GPU, so it is local-only work
still outstanding.

**The acknowledged gap: shader output has no automated seam.** There is no GPU on
a CI runner, so whether the six looks are any good is golden images run locally
plus the maintainer's eye. Do not compensate by testing the shader through a
mock — a mocked shader proves the mock works. What CI _can_ check is in
`gl/shaders.test.ts`: the blue-noise mask, and that every option list is in the
order the shader indexes it.
