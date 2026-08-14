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

| Field             | Meaning                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `effectsOpen`     | Whether the effects tab is the one on screen                      |
| `treatmentTarget` | The candidate the tab is pinned to, or `null` to follow selection |

`activeStage` still means "which stage's form the sidebar edits", and stays a
`StageKind`. The pin is sticky so a selection change elsewhere cannot move you
onto a different generation's treatment mid-edit.

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

## Testing

Four seams, all of them pre-existing shapes:

| Seam               | File                            | Covers                                                                 |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| The library loader | `lib/effects/looks.test.ts`     | Bad ranges, unknown shaders, forks that must not take the library down |
| The treatment      | `lib/effects/treatment.test.ts` | Manifest round-trip, #53 seeding, knob validation                      |
| The reducer        | `lib/recipe/reducer.test.ts`    | Pinning, choosing, nudging, never re-seeding over an edit              |
| The CPU kernel     | `src-tauri/src/effects/`        | Diffusion stencils, the fused pass, the colour transfer                |

**The acknowledged gap: shader output has no automated seam.** There is no GPU on
a CI runner, so whether the six looks are any good is golden images run locally
plus the maintainer's eye. Do not compensate by testing the shader through a
mock — a mocked shader proves the mock works. What CI _can_ check is in
`gl/shaders.test.ts`: the blue-noise mask, and that every option list is in the
order the shader indexes it.
