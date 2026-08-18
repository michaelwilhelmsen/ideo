/**
 * The ported ShaderGradient programs, as source strings.
 *
 * Three families × three forms, from `ruucm/shadergradient` (MIT). They are
 * committed here rather than pulled from the npm package because the package
 * ships exactly one vertex/fragment pair in its `dist/` — the families are a
 * source-only distinction, and building against the published bundle means
 * shipping one look and calling it three.
 *
 * ## What was changed on the way in, and why
 *
 * The upstream shaders are written against three <= 0.150 and do not compile
 * against the version this app pins. Three edits, all mechanical:
 *
 * 1. `#include <uv2_*>` deleted. Those chunks were removed after r150. They
 *    only ever carried lightmap and AO UVs, which none of these shaders read,
 *    so the deletion is not a behaviour change.
 * 2. `<encodings_fragment>` renamed to `<colorspace_fragment>`, which is what
 *    it became in r152.
 * 3. `#include <envmap_pars_fragment>` deleted from the three glass fragments.
 *    It declares exactly two things — `reflectivity` and `varying vec3
 *    vReflect` — and glass declares both itself, so under `USE_ENVMAP` the
 *    program has each twice and does not compile. Nothing is lost: what glass
 *    reads from the env map (`envMap`, `envMapIntensity`) comes from
 *    `<envmap_common_pars_fragment>` on the line above. Upstream never hit this
 *    because it never set `USE_ENVMAP` on the material itself, which is also
 *    why its glass never refracted anything until `renderer.ts` started
 *    declaring the define — see the material comment there.
 *
 * `check-shader-chunks.mjs` catches (1): a chunk that stopped existing. It
 * cannot catch (3), a chunk that still exists and now says something the
 * shader already said — that one is only visible at link time.
 *
 * Nothing else is touched — the maths is upstream's, so a look here and the
 * same preset on shadergradient.co are the same picture.
 *
 * `scripts/check-shader-chunks.mjs` holds that first edit honest across three
 * upgrades. It matters more than it looks: `resolveIncludes` throws at
 * *program-compile* time, which is the first frame after a look switch rather
 * than startup, so an unresolvable chunk is one look silently going black on a
 * machine nobody tested.
 */

import cosmicPlaneFrag from './glsl/cosmic-plane.fragment.glsl?raw'
import cosmicPlaneVert from './glsl/cosmic-plane.vertex.glsl?raw'
import cosmicSphereFrag from './glsl/cosmic-sphere.fragment.glsl?raw'
import cosmicSphereVert from './glsl/cosmic-sphere.vertex.glsl?raw'
import cosmicWaterFrag from './glsl/cosmic-waterPlane.fragment.glsl?raw'
import cosmicWaterVert from './glsl/cosmic-waterPlane.vertex.glsl?raw'
import defaultsPlaneFrag from './glsl/defaults-plane.fragment.glsl?raw'
import defaultsPlaneVert from './glsl/defaults-plane.vertex.glsl?raw'
import defaultsSphereFrag from './glsl/defaults-sphere.fragment.glsl?raw'
import defaultsSphereVert from './glsl/defaults-sphere.vertex.glsl?raw'
import defaultsWaterFrag from './glsl/defaults-waterPlane.fragment.glsl?raw'
import defaultsWaterVert from './glsl/defaults-waterPlane.vertex.glsl?raw'
import glassPlaneFrag from './glsl/glass-plane.fragment.glsl?raw'
import glassPlaneVert from './glsl/glass-plane.vertex.glsl?raw'
import glassSphereFrag from './glsl/glass-sphere.fragment.glsl?raw'
import glassSphereVert from './glsl/glass-sphere.vertex.glsl?raw'
import glassWaterFrag from './glsl/glass-waterPlane.fragment.glsl?raw'
import glassWaterVert from './glsl/glass-waterPlane.vertex.glsl?raw'

/**
 * The three gradient families.
 *
 * A closed list for the same reason {@link EffectShader} is one: each entry is
 * a pair of programs somebody wrote, and a value with nothing behind it is a
 * look that renders nothing.
 */
export const GRADIENT_FAMILIES = ['defaults', 'cosmic', 'glass'] as const

export type GradientFamily = (typeof GRADIENT_FAMILIES)[number]

/**
 * The mesh a family is drawn on — upstream's `type`, and a knob rather than
 * three more looks.
 *
 * `plane` is subdivided on one axis only (`1 × 192`), which is what makes it
 * fold like a hanging curtain instead of a grid. That asymmetry is upstream's
 * and is the whole difference between `plane` and `waterPlane`.
 */
export const GRADIENT_FORMS = ['plane', 'waterPlane', 'sphere'] as const

export type GradientForm = (typeof GRADIENT_FORMS)[number]

export interface GradientProgram {
  readonly vertex: string
  readonly fragment: string
}

const PROGRAMS: Readonly<
  Record<GradientFamily, Readonly<Record<GradientForm, GradientProgram>>>
> = {
  defaults: {
    plane: { vertex: defaultsPlaneVert, fragment: defaultsPlaneFrag },
    waterPlane: { vertex: defaultsWaterVert, fragment: defaultsWaterFrag },
    sphere: { vertex: defaultsSphereVert, fragment: defaultsSphereFrag },
  },
  cosmic: {
    plane: { vertex: cosmicPlaneVert, fragment: cosmicPlaneFrag },
    waterPlane: { vertex: cosmicWaterVert, fragment: cosmicWaterFrag },
    sphere: { vertex: cosmicSphereVert, fragment: cosmicSphereFrag },
  },
  glass: {
    plane: { vertex: glassPlaneVert, fragment: glassPlaneFrag },
    waterPlane: { vertex: glassWaterVert, fragment: glassWaterFrag },
    sphere: { vertex: glassSphereVert, fragment: glassSphereFrag },
  },
}

export function programFor(
  family: GradientFamily,
  form: GradientForm
): GradientProgram {
  return PROGRAMS[family][form]
}

export function isGradientFamily(value: unknown): value is GradientFamily {
  return (GRADIENT_FAMILIES as readonly unknown[]).includes(value)
}

export function isGradientForm(value: unknown): value is GradientForm {
  return (GRADIENT_FORMS as readonly unknown[]).includes(value)
}
