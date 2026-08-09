/**
 * An image the user brought in, as the recipe model holds it (#27).
 *
 * The issue's requirement is convergence: a picked or dropped image has to be
 * "indistinguishable from a generated one downstream". So an upload is a
 * `Generation` like any other — same stage, same ordinal sequence, same
 * `asset` field, same verdicts — and every downstream selector, the manifest
 * round-trip and the cleanup pass go on working without learning a new shape.
 *
 * What has to differ is one honest fact: no model made it. That is recorded as
 * a *reserved model id* rather than a new field on `StageRecipe`, for two
 * reasons. A new field would have to be understood by every build that ever
 * reads the manifest, and an older one would silently treat the upload as a
 * generation it could re-run. A reserved id, by contrast, round-trips through
 * `readRecipe` untouched (it only asks that `modelId` is a string), so the
 * manifest version does not move — and any build that does not know the marker
 * fails loudly at `modelById` rather than quietly re-running the wrong thing.
 *
 * The id is namespaced with a scheme no provider uses, so it cannot ever
 * collide with a real fal endpoint path.
 */

import type { StageRecipe } from './types'

/** The reserved `modelId` that means "these pixels came off the user's disk". */
export const UPLOAD_MODEL_ID = 'ideo:upload'

/**
 * The recipe an upload carries.
 *
 * Deliberately inert: no prompt, no preset, no seed to pin. An upload is not
 * re-runnable and the recipe says so rather than implying a reproducibility it
 * does not have — the same honesty `seed: null` buys for a seedless model
 * (PRD §4.3).
 *
 * `fileName` is the user's own name for the file, kept as an option so the
 * candidate can say where it came from. In `options` rather than `params`
 * because it is ours and no API has heard of it — the request builder never has
 * to know to strip it out.
 */
export function uploadRecipe(fileName: string): StageRecipe {
  return {
    modelId: UPLOAD_MODEL_ID,
    prompt: '',
    presetId: null,
    presetModified: false,
    seed: { mode: 'roll' },
    params: {},
    options: { fileName },
    inputGenerationId: null,
  }
}

/** Whether this recipe describes an upload rather than a model call. */
export function isUploadRecipe(recipe: StageRecipe): boolean {
  return recipe.modelId === UPLOAD_MODEL_ID
}

/**
 * The user's name for an uploaded file, when there is one.
 *
 * Read defensively: the manifest is untrusted input (PRD §3.2), and a
 * hand-edited one can put anything in `options`.
 */
export function uploadFileName(recipe: StageRecipe): string | null {
  const name = recipe.options.fileName
  return typeof name === 'string' && name !== '' ? name : null
}
