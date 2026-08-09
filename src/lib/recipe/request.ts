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
import type { AspectId, ParamValue, StageParams, StageRecipe } from './types'

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
  readonly params: StageParams
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
  const params: Record<string, ParamValue> = {}

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
  //
  // And `seed`, for the same reason from the other direction: a recipe records
  // the seed it was sent with (see `sentRecipe`), so restoring one puts that
  // number in `params` — where, carried through, it would keep pinning the seed
  // after the user had unpinned it. `recipe.seed` is the only thing that decides.
  for (const [key, value] of Object.entries(recipe.params)) {
    if (declaresParam(model, key) && key !== model.imageParam && key !== SEED) {
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
    params[SEED] = recipe.seed.value
  }

  return {
    modelId: model.id,
    params: { ...params, ...aspectRequestFields(model, aspect) },
  }
}

/** Not a registry field: every model that takes one spells it this way. */
const SEED = 'seed'

/**
 * The recipe as it was actually submitted — what gets persisted (AC10).
 *
 * The frozen draft is not that recipe on its own. Three things are decided
 * between freezing it and the HTTP call, all of them here rather than in the
 * form: our defaults for fields the user never touched, the project's locked
 * ratio as this model's own geometry field, and the seed where one was pinned.
 * A recipe missing them is not re-runnable — it says "16:9 somehow" where the
 * request said `{width: 1344, height: 768}` — and re-runnability is the premise
 * the whole recipe model rests on (PRD §1).
 *
 * The draft keeps its own parameters, untouched: it is the form, and the form
 * shows what the user set rather than what we resolved on their behalf. This is
 * the copy that travels with the job and comes back on arrival (#24).
 */
export function sentRecipe(
  recipe: StageRecipe,
  request: ModelRequest
): StageRecipe {
  return { ...recipe, params: request.params }
}
