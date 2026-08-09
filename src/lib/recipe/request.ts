/**
 * The request body, built from the registry rather than from memory.
 *
 * This is where #25's registry stops being documentation and starts being the
 * thing that decides what goes on the wire. Before it, Rust hardcoded one model
 * id and one `image_size` shape; a second model would have needed a second
 * branch in Rust, and a third a third.
 *
 * The split with Rust is deliberate. **What** to send is a registry question
 * and lives here, where the registry is; **whether we are allowed to send it**
 * — a key, a folder, a well-formed endpoint id — stays in Rust, which is the
 * side holding the key and doing the spending. Rust receives a model id and an
 * opaque parameter object and validates the shape of both without needing to
 * know that Luma spells duration `"5s"`.
 *
 * Pure, and therefore checkable: given a model, a locked ratio and a recipe,
 * the body is a value a test can assert on rather than a thing that only
 * happens when someone spends money.
 */

import {
  aspectRequestFields,
  declaresParam,
  serializeDuration,
  type ModelCapabilities,
} from './registry'
import type { AspectId, StageRecipe } from './types'

/** A JSON value as a fal request body holds one. */
export type RequestValue =
  | string
  | number
  | boolean
  | { readonly width: number; readonly height: number }

/** One submission, as far as anything before the HTTP call is concerned. */
export interface ModelRequest {
  readonly modelId: string
  /**
   * Everything except the prompt, keyed by the model's own field names.
   *
   * The prompt is carried separately because it is the one field every model
   * shares and the one Rust refuses on its own account — an empty prompt is a
   * paid call for nothing.
   */
  readonly params: Readonly<Record<string, RequestValue>>
}

/**
 * The body for one generation on one model.
 *
 * Order matters: our defaults first, then the draft on top, so a parameter the
 * user never touched carries *our* choice and not the provider's (PRD §5,
 * §6.3). The aspect fields come last because the project's ratio is locked and
 * is not the draft's to override (PRD §4.4).
 *
 * Throws when the model cannot serve the ratio. That is unreachable through the
 * UI — `modelAvailability` refuses such a model at selection time (PRD §10) —
 * which is exactly why it throws rather than falling back to something
 * plausible: a fallback would submit and charge for the wrong shape.
 */
export function buildRequest(
  model: ModelCapabilities,
  aspect: AspectId,
  recipe: StageRecipe
): ModelRequest {
  const params: Record<string, RequestValue> = {}

  for (const [key, value] of Object.entries(model.defaults)) {
    params[key] = value
  }

  // A draft can name a field this model does not have — it was persisted by a
  // build with a different registry, or the model was swapped after the draft
  // was written. fal rejects unknown fields, so they are dropped here rather
  // than at the paid step.
  //
  // The image field is dropped too, whatever a draft says about it. What goes in
  // it is a whole image (#28), read and encoded on the Rust side from the
  // generation the recipe names — so a value here could only be a stale URL from
  // a hand-edited manifest, and it would be silently restyling the wrong picture.
  for (const [key, value] of Object.entries(recipe.params)) {
    if (declaresParam(model, key) && key !== model.imageParam) {
      params[key] = value
    }
  }

  if (model.durationParam !== null) {
    const chosen = params[model.durationParam]
    if (chosen !== undefined) {
      params[model.durationParam] = serializeDuration(model, String(chosen))
    }
  }

  // PRD §4.3 — a pinned seed is what makes "one fragment changed" a comparison
  // rather than a re-roll. On a model with no seed field there is nothing to
  // pin, and sending one would be a 422.
  if (model.supportsSeed && recipe.seed.mode === 'pinned') {
    params.seed = recipe.seed.value
  }

  return {
    modelId: model.id,
    params: { ...params, ...aspectRequestFields(model, aspect) },
  }
}
