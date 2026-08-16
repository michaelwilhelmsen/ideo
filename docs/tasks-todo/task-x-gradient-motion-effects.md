# Task x — Gradient motion effects

> **In progress on branch `feat/gradient-motion-effects`.** Nothing committed;
> `main` is untouched. Not runnable yet — nothing dispatches to the new backend.

Add ShaderGradient's three shader families to the effects library as animated
looks that composite over footage.

## State

Done, type-checks under `noUncheckedIndexedAccess`, lints clean, **not visually
verified** (AGENTS.md rule 8 — no dev server):

| File                                   | What                                     |
| -------------------------------------- | ---------------------------------------- |
| `src/lib/effects/three/programs.ts`    | 18 ported shaders, family × form         |
| `src/lib/effects/three/environment.ts` | `RoomEnvironment` → `CubeTexture`        |
| `src/lib/effects/three/composite.ts`   | 8 blend modes, upstream's contract       |
| `src/lib/effects/three/renderer.ts`    | the renderer, behind `EffectsRenderer`   |
| `scripts/check-shader-chunks.mjs`      | guards `#include`s across three upgrades |

`EffectFrame` gained optional `time`. `three@0.185.1` + types added.

**Every "why" is in the module headers of those files.** They are written to be
read; do not re-derive the reasoning from here.

## Remaining

1. **Declare the looks** — `gradientDefaults` / `gradientCosmic` /
   `gradientGlass` in `EFFECT_SHADERS` + `SHADER_KNOBS`, entries in
   `looks.json`, i18n strings, and the fork in `createEffectsRenderer` that
   picks the backend. **Do this first and standalone (no layering)** — it is
   what makes the branch launchable so glass can be profiled.
2. **Time wiring** — preview from elapsed, bake from `index / fps`. Also make
   the still cache in `use-effects-preview.ts:177` opt out per look: a motion
   look on a still currently renders once and freezes.
3. **`Treatment.overlay`** — optional `{ lookId, values, lookModified }`;
   absent means old manifests read unchanged. Composition chains two
   `EffectsRenderer`s — the treatment renderer's canvas becomes the gradient
   renderer's source, which `EffectSource` already permits. Needs an ADR
   amending the no-stack decision in `looks.ts`, scoped to generative overlays.
4. **Tests + `npm run check:all`.**

## Decisions already settled — do not reopen

- **Geometry is a knob** (`form`: plane / waterPlane / sphere), not three looks.
- **Do not cap glass preview resolution** until it has been measured.
- **Two WebGL contexts**, one per backend, both long-lived. This is not what
  `gl/renderer.ts`'s context-exhaustion warning is about.
- **Blend maths in display space**, not linear light — these formulas are
  _defined_ on display-referred values, and their soft light is Pegtop's, not
  W3C's.
- **Three families only.** `base/` is dev scaffolding; `positionMix/` for
  plane and waterPlane is 22 lines of unlit `c1*x + c2*y + c3*z`.

## Facts about the reference that cost three wrong attempts

Established by reading the source, after two rebuilds were discarded for looking
wrong:

- **One noise call, not fBm.** `distortion = 0.75 * cnoise(0.43 * position *
uNoiseDensity + t)`. Stacking octaves turns it into water caustics.
- **Strength is huge, density is barely above 1** (uStrength 3–4, uDensity ~1.2).
  A big slow wave.
- **Roll, not tilt.** Half the presets leave `rotationX` at 0 and do everything
  with `rotationZ` (50°, 225°, 235°, −90°, −60°).
- **The camera is jammed against the mesh.** 10 units across, camera 2.4–4.4
  away, 45° lens → ~3 units on screen → one or two noise periods fill the frame.
  Sphere presets zoom 9–17× instead. This is what "big shapes" means numerically.
- **Glass does not use three's transmission.** It does its own `refract()` with
  chromatic aberration against `envMap` via `textureCube` — hence the
  `CubeTexture` rather than PMREM, or `#ifdef ENVMAP_TYPE_CUBE` compiles to the
  branch that never runs and glass silently loses refraction.

## Re-obtaining the reference

The clone lives in the session scratchpad and does not survive a context clear:

```bash
git clone --depth 1 https://github.com/ruucm/shadergradient /tmp/shadergradient
```

Shaders at `packages/shadergradient/src/shaders/<family>/<form>/`. Ported
copies in this repo already have the two required edits applied (`uv2_*`
includes deleted, `encodings_fragment` → `colorspace_fragment`); see the header
of `programs.ts`.

The ten presets' real numbers are in the live site bundle, not the repo:
`curl -s https://shadergradient.co | grep -oE 'https://framerusercontent[^"]+\.mjs'`
then grep the largest for `cAzimuthAngle`.
