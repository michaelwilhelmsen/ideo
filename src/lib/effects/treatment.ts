/**
 * What a treatment *is*, and how it survives being written down.
 *
 * A treatment is the fourth thing a generation carries, and deliberately not
 * part of its `recipe`: a recipe is the frozen record of what was sent to a
 * model, and an effect was never sent to anything. It is chosen *while looking
 * at the result*, which is the whole reason #36 is a tab and not a stage.
 *
 * **Values plus the look's id plus a modified flag** — the same provenance
 * pattern `StageRecipe` already uses with `presetId` / `presetModified`, and for
 * the reason `presets.ts` states in its own header: a record that resolves
 * against a mutable library at read time is not a record. Storing only a
 * reference means editing a look silently changes generations you already
 * approved; storing only values loses the ability to say "this is Riso halftone,
 * nudged".
 *
 * ## Why this has its own reader
 *
 * `readParams` in `manifest.ts` keeps scalars and a `PixelSize` and **silently
 * drops everything else**, by design — it is guarding what goes on the wire to a
 * model. A treatment is not on that wire, and its failure mode if it were read
 * that way is the one #36 calls out by name: the field disappears and the
 * project reopens looking like nobody ever treated anything. So the values are
 * read here, structurally, with no reference to the library at all.
 *
 * **Not validated against the library on the way in**, and that is the point. A
 * look can be forked, renamed, edited, or live in app data this build has not
 * loaded yet; refusing a treatment because its look is not in memory would lose
 * the record over a file that is merely elsewhere. Values are held to their
 * knobs at the moment something *renders* them ({@link resolveTreatment}), which
 * is where a wrong value has a consequence.
 */

import { isRecord } from '@/lib/recipe/json'
import type { Palette } from '@/lib/recipe/palette'
import type { DitherKernel, LevelPlacement, Preset } from '@/lib/recipe/presets'
import type { Treatment } from '@/lib/recipe/types'
import {
  coerceKnobValue,
  defaultKnobValue,
  defaultKnobValues,
  isDiffusionKernel,
  lookById,
  type EffectsLook,
  type KnobValue,
} from './looks'

export type { Treatment }

/** A treatment from an untrusted document, or `null` if this is not one. */
export function readTreatment(document: unknown): Treatment | null {
  if (!isRecord(document)) return null
  if (typeof document.lookId !== 'string' || document.lookId === '') return null

  return {
    lookId: document.lookId,
    values: readKnobValues(document.values),
    // Only `true` counts, so a hand-edited `"yes"` does not become one.
    lookModified: document.lookModified === true,
  }
}

/**
 * The values as they were written, keeping every scalar.
 *
 * Nothing is checked against a knob here — see the module comment. What *is*
 * checked is that a value is a scalar at all, because the three scalar types are
 * the whole of {@link KnobValue} and anything else is a document that was never
 * ours.
 */
function readKnobValues(value: unknown): Readonly<Record<string, KnobValue>> {
  if (!isRecord(value)) return {}

  const values: Record<string, KnobValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string' ||
      (typeof entry === 'number' && Number.isFinite(entry)) ||
      typeof entry === 'boolean'
    ) {
      values[key] = entry
    }
  }
  return values
}

/** The document a manifest holds — a plain mirror, so a round trip is a copy. */
export function writeTreatment(treatment: Treatment): Record<string, unknown> {
  return {
    lookId: treatment.lookId,
    values: treatment.values,
    lookModified: treatment.lookModified,
  }
}

/**
 * A treatment's values, held to the look that is about to render them.
 *
 * Every knob the look declares gets a value: the treatment's where it holds one
 * the knob can accept, and the look's own default where it does not. A value for
 * a knob the look no longer has is dropped — a fork that removed a control is
 * not a reason to bind a uniform nothing reads.
 *
 * This is where a hand-edited manifest is caught, and it is caught *quietly*: a
 * slider outside its range clamps and a bad colour falls back, because the
 * alternative is a tab that refuses to open over one number. The loud refusal
 * belongs to the library loader, where a bad value is a bad *declaration*.
 */
export function resolveTreatment(
  treatment: Treatment,
  look: EffectsLook,
  palette: Palette
): Readonly<Record<string, KnobValue>> {
  const values: Record<string, KnobValue> = {}

  for (const knob of look.knobs) {
    const held = coerceKnobValue(knob, treatment.values[knob.key])
    values[knob.key] = held ?? defaultKnobValue(knob, palette)
  }

  return values
}

/**
 * A fresh treatment for a look, with every knob at its authored default.
 *
 * `lookModified` starts false and only a knob turn sets it — which is why
 * choosing a look is not itself a modification.
 */
export function treatmentFor(look: EffectsLook, palette: Palette): Treatment {
  return {
    lookId: look.id,
    values: defaultKnobValues(look, palette),
    lookModified: false,
  }
}

/**
 * One knob turned.
 *
 * A value the knob cannot hold leaves the treatment alone rather than storing
 * something that will be silently replaced at render time — a control that
 * appears to accept a value it then ignores is worse than one that does not
 * move.
 */
export function withKnob(
  treatment: Treatment,
  look: EffectsLook,
  key: string,
  value: KnobValue
): Treatment {
  const knob = look.knobs.find(candidate => candidate.key === key)
  if (knob === undefined) return treatment

  const held = coerceKnobValue(knob, value)
  if (held === null) return treatment
  if (treatment.values[key] === held) return treatment

  return {
    ...treatment,
    values: { ...treatment.values, [key]: held },
    lookModified: true,
  }
}

// ── #53's declarations, arriving in the tab ─────────────────────────────────

/**
 * The treatment a recipe's preset asks for, or `null` if it asks for none.
 *
 * #53 made four recipes' post-treatment machine-readable so #36 would not have
 * to re-derive four intentions from English. This is the reading. It is a
 * **seed, never a lock** — which is exactly what #53 says those fields mean, and
 * why the caller only ever offers this to a generation that has no treatment
 * yet.
 *
 * Which look a kernel seeds is derived rather than mapped: the first look in the
 * library whose `kernel` knob offers that value. A table from kernel to look id
 * would be a fifth place the four recipes are written down, and it would go
 * stale the first time somebody reorders the library.
 *
 * `levelPlacement` is applied to the same look where it has a knob for it, and
 * dropped where it does not — all four recipes leave it `null` today, so this is
 * the mechanism working rather than the mechanism being used.
 */
export function seedTreatmentFrom(
  preset: Preset | null,
  library: readonly EffectsLook[],
  palette: Palette
): Treatment | null {
  if (preset === null || preset.ditherKernel === null) return null

  const look = lookOffering(library, 'kernel', preset.ditherKernel)
  if (look === null) return null

  let treatment = treatmentFor(look, palette)
  treatment = seeded(treatment, look, 'kernel', preset.ditherKernel)
  if (preset.levelPlacement !== null) {
    treatment = seeded(treatment, look, 'levelPlacement', preset.levelPlacement)
  }

  return treatment
}

/**
 * A seeded value, which is deliberately *not* a modification.
 *
 * `withKnob` sets `lookModified`, because a person turned something. Nothing
 * turned anything here — the recipe already said this — so a seeded treatment
 * still reads as the look it names, unnudged.
 */
function seeded(
  treatment: Treatment,
  look: EffectsLook,
  key: string,
  value: DitherKernel | LevelPlacement
): Treatment {
  const turned = withKnob(treatment, look, key, value)
  return { ...turned, lookModified: false }
}

function lookOffering(
  library: readonly EffectsLook[],
  key: string,
  value: string
): EffectsLook | null {
  return (
    library.find(look =>
      look.knobs.some(
        knob =>
          knob.key === key &&
          knob.kind === 'choice' &&
          knob.options.includes(value)
      )
    ) ?? null
  )
}

/** The look a treatment names, from either half of the library. */
export function lookFor(
  treatment: Treatment | null,
  library: readonly EffectsLook[]
): EffectsLook | null {
  if (treatment === null) return null
  return lookById(treatment.lookId, library)
}

// ── What a clip can actually render ─────────────────────────────────────────

/**
 * The values as the *medium* allows them, and whether anything had to move.
 *
 * Error diffusion decides each pixel from pixels already decided, so it has no
 * fragment shader and no place on a clip — the pattern would be re-derived from
 * scratch every frame and crawl, which the research flags as the single most
 * objectionable failure mode. Blue noise is the substitute: a fixed mask, so
 * temporally stable by construction.
 *
 * The substitution is **visible**, which is the whole point. #36 asks for the
 * two kernels to be disabled with a reason and explicitly not "silently
 * substituted (an export that does not match the control on screen)" — and the
 * shader *does* substitute, because any kernel it does not have a matrix for
 * falls through to the noise mask. Disabling the options is only half the
 * guard: a value can still arrive from #53's seeding, from a fork whose default
 * is Atkinson, or from a hand-edited manifest. So the control is shown the
 * value that will actually be rendered, with `substituted` saying why it is not
 * the one the treatment holds.
 *
 * Nothing is written back. The treatment keeps saying Atkinson, because the
 * same candidate treated as a still still means it — the medium is a fact about
 * the file, not a decision about the look.
 */
export function valuesForMedium(
  values: Readonly<Record<string, KnobValue>>,
  isClip: boolean
): {
  readonly values: Readonly<Record<string, KnobValue>>
  readonly substituted: boolean
} {
  const kernel = values.kernel
  if (!isClip || typeof kernel !== 'string' || !isDiffusionKernel(kernel)) {
    return { values, substituted: false }
  }

  return {
    values: { ...values, kernel: VIDEO_SAFE_KERNEL },
    substituted: true,
  }
}

/** What error diffusion becomes on a clip. */
export const VIDEO_SAFE_KERNEL = 'blueNoise'
