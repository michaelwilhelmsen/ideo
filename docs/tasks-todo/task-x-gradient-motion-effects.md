# Task x — Gradient motion effects

> **In progress on branch `feat/gradient-motion-effects`.** `main` is untouched.
> **Launchable**: the three looks are declared and `createEffectsRenderer`
> dispatches to the gradient backend, so glass can be picked and profiled. It
> does not move yet — that is step 2.

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

1. ~~**Declare the looks**~~ — done, `check:all` clean. Three looks
   (`fx-gradient-wave`, `fx-gradient-cosmic`, `fx-gradient-glass`), colours
   defaulting to the project's `primary`/`secondary`/`accent` roles the way the
   duotone defaults to `ink`/`paper`. What it settled on the way:
   - **`EFFECT_SHADERS` split into `REDUCTIVE_SHADERS` + `GRADIENT_SHADERS`.**
     Not taxonomy — `isGradientShader` is the fork's own predicate, and
     `fragmentSourceFor`'s `Record` must not be asked for a body that does not
     exist.
   - **The canvas is keyed on the backend** in `EffectsTab`. An element holds
     one context for life, so crossing backends needs a new element; the hook's
     existing "bound to _this_ canvas" rebind then does the rest.
   - **`tilt`/`roll` are `angle` knobs, so degrees**, converted in
     `three/renderer.ts`. Upstream's own unit, and what a preset's 225 means.
   - **Glass gets no `density` knob** — its shaders never read `uNoiseDensity`,
     and the coupling check is there to refuse exactly that.
   - **No `amplitude`/`frequency` knobs anywhere**, though `SCALAR_UNIFORMS`
     bridges them: only `defaults-sphere` declares them, so they would be
     controls that do nothing on two of the three forms. Reconsider if the
     sphere turns out to need them.

2. ~~**Time wiring**~~ — done. `movesOverTime` in `looks.ts` answers the still
   cache from the backend rather than from a flag on each look, and the loop
   redraws when it says yes. What it settled on the way:
   - **A clip takes its time from the video's `currentTime`, not from elapsed.**
     The plan said elapsed; elapsed is wrong here. The bake renders frame `i` at
     `i / fps`, which _is_ the `currentTime` the preview drew that frame at, so
     reading the element's clock makes the two agree by construction. Elapsed
     agrees only while nothing goes wrong, and drifts the moment the video
     loops, pauses or decodes slowly — which is the export disagreeing with the
     screen, the one thing the renderer exists to prevent.
   - **A still keeps elapsed**, because it has no clock to borrow and nothing to
     agree with.
   - **Open: which moment a still export captures.** A still has no frame rate
     and one frame, so `time` is 0 and the file is always the first instant of
     the motion, while the preview animates freely past it. Nobody has decided
     what it _should_ be — a phase knob, a scrub, freeze-on-pause — and 0 is the
     placeholder, not the answer. `services/bake.ts` points here.
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
