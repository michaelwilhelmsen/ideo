/**
 * The capability registry, and the rules the UI derives from it.
 *
 * PRD §5: fal has no capability-discovery API, so what each model supports is
 * declared by hand. PRD §10.1 says what the UI does when a capability is
 * missing — headline features are shown disabled with a reason, plumbing is
 * hidden — and this module is the single place that decision is made, so no
 * component has to remember which is which.
 *
 * Pure. No React, no fixtures, no strings a user reads (reasons are i18n keys).
 */

import { aspectById, ASPECTS, isAspectId } from './aspects'
import type {
  AspectId,
  ParamValue,
  PixelSize,
  StageKind,
  StageParams,
  StageRecipe,
} from './types'

/**
 * Which preset variant a model wants (PRD §5, §6).
 *
 * `tags` exists because Qwen-Image 2 has a real `negative_prompt` and reads as
 * a keyword list; every other model surveyed is instruction-driven prose.
 */
export type PromptStyle = 'prose' | 'tags'

/**
 * How a model's image field is shaped — the thing knowing its *name* does not
 * tell you.
 *
 * The style stage splits on it: the FLUX family takes a single `image_url`
 * string, Qwen and Nano Banana an `image_urls` **array**. Sending a string where
 * an array is required is a 422 at the one step that costs money, with no visual
 * signal that the parameter shape rather than the prompt was wrong (#28).
 *
 * Derived from the field name rather than declared per model, because on fal the
 * name *is* the declaration — the plural is the array. `validateRegistry` refuses
 * an image field whose name is not in the table below, so a model with a
 * differently-named image input is a startup crash that asks for its shape
 * rather than a guess that ships.
 *
 * Taken from the generated bindings rather than declared here, exactly as
 * `ProjectSummary` is (`docs/developer/tauri-commands.md`: "no manual sync
 * between Rust and TypeScript"). The shape travels to Rust on every image-to-
 * image submit, so Rust's `ImageParamShape` is the wire form and a second
 * hand-written copy of it is a rename away from a 422 nobody can see coming.
 */
import type { ImageParamShape } from '@/lib/tauri-bindings'

export type { ImageParamShape }

const IMAGE_PARAM_SHAPES: Readonly<Record<string, ImageParamShape>> = {
  image_url: 'url',
  image_urls: 'urlArray',
  // The animate stage's start frame (#29). Three names for one idea across the
  // eight video endpoints surveyed — `image_url` on Seedance, Kling O3, Luma,
  // Veo's image-to-video and LTX; `start_image_url` on Kling O1 and FLUX 3;
  // `first_frame_url` on Veo's first/last-frame variant — and all three take a
  // single URL. That disagreement is the registry's whole case (PRD §9.1).
  start_image_url: 'url',
  first_frame_url: 'url',
  // The animate stage's end frame (#30), which a seamless loop fills with the
  // start still all over again. Two names for it — `last_frame_url` on Veo's
  // first/last-frame endpoint and `end_image_url` everywhere else — and both
  // single URLs, but recorded rather than assumed for the same reason as above.
  end_image_url: 'url',
  last_frame_url: 'url',
}

/**
 * How an image field is shaped, or `null` when there is no field or no
 * recorded shape for its name.
 *
 * Takes the field name rather than the model, because a model has two of them —
 * `imageParam` and `endFrameParam` — and they are the same question asked twice.
 */
export function imageParamShape(param: string | null): ImageParamShape | null {
  if (param === null) return null
  return IMAGE_PARAM_SHAPES[param] ?? null
}

/**
 * How a duration value has to be serialised.
 *
 * Three idioms across the surveyed field, and sending the wrong primitive is a
 * 422 (PRD §5, §9.1): Kling and flux-3 take bare integers, Veo takes `"8s"`,
 * Luma takes `"5s"`. `durations` is stored verbatim as strings regardless —
 * this field says what to turn them into on the wire.
 */
export type DurationFormat = 'integer' | 'string' | 'secondsSuffixed'

/**
 * Numeric bounds on an explicit `{width, height}`, read from `x-fal` and the
 * schema prose (`docs/research/model-schemas.md`).
 *
 * `multipleOf` is never below 16 in this registry even where a model declares
 * none: PRD §12 found fal snapping 1280×720 to 1280×704, which changed the
 * ratio the project had locked. Choosing multiples ourselves is how the lock
 * survives the request.
 */
export interface DimensionConstraints {
  readonly multipleOf: number
  readonly minEdge: number
  readonly maxEdge: number
  readonly minPixels: number
  readonly maxPixels: number
  /** Longest edge over shortest, e.g. `3` for gpt-image-2's ≤ 3:1. */
  readonly maxRatio: number | null
}

/**
 * How a model is told what shape to produce — three idioms, not two.
 *
 * `readonly AspectId[]` was the old shape and it could not hold the largest
 * group of image models, the ones taking explicit `{width, height}` under
 * numeric constraints. Recording those as a ratio list answers
 * `modelAvailability` correctly by accident while discarding everything the
 * request builder needs: a different field name, a different value shape, and
 * the arithmetic that decides whether a ratio is legal at a chosen size.
 *
 * - `ratioEnum` — a fixed list. Keyed by *our* `AspectId` and valued by the
 *   provider's own token, because the two are not the same string: `21:9` on
 *   FLUX Kontext, `landscape_16_9` on an `image_size` enum. A ratio absent
 *   from the record is a ratio the model cannot serve.
 * - `freeDimensions` — any ratio inside the bounds, sent as `{width, height}`.
 * - `inheritsFromSource` — no size field at all; geometry comes from the input
 *   image, so every project ratio is servable and nothing is sent.
 */
export type AspectSupport =
  | {
      readonly kind: 'ratioEnum'
      readonly param: string
      readonly values: Readonly<Partial<Record<AspectId, string>>>
    }
  | {
      readonly kind: 'freeDimensions'
      readonly param: string
      readonly constraints: DimensionConstraints
    }
  | { readonly kind: 'inheritsFromSource' }

/** PRD §10.2 — approximate, and dated so staleness is visible. */
export interface Price {
  readonly amount: number
  /**
   * What `amount` buys. `megapixel` is billed rounded up, `second` multiplies
   * by the chosen duration — see `estimateCost`.
   */
  readonly unit: 'image' | 'megapixel' | 'second'
  /** ISO date the rate was read on. Shown to the user, never hidden. */
  readonly verifiedOn: string
}

/**
 * The registry fields the UI and the request builder derive from — PRD §5's
 * table, less the fields nothing reads yet.
 *
 * `stage` reuses the UI's names (source/style/animate) rather than §5's
 * (image/restyle/video) so there is one vocabulary on screen.
 */
export interface ModelCapabilities {
  readonly id: string
  readonly label: string
  readonly provider: 'fal'
  readonly stage: StageKind
  /** PRD §5 — which preset variant this model's prompt wants. */
  readonly promptStyle: PromptStyle
  /** PRD §4.4/§10 — how the locked project ratio reaches this model. */
  readonly aspects: AspectSupport
  /**
   * The field the input image goes in, or null on a model that takes none.
   *
   * Read from the live schemas (`docs/research/model-schemas.md`) like every
   * other name here, and read rather than guessed for a reason: the style stage
   * splits three ways on it. The FLUX family takes a single `image_url`; Qwen
   * and Nano Banana take an `image_urls` *array*. Sending the wrong one is a 422
   * at the paid step, and there is no visual signal that it was the parameter
   * name and not the prompt.
   *
   * Null on the source stage, where there is no input image at all, and never
   * null anywhere else: an animate row's start frame is the still being animated
   * (#29), and a video model with nowhere to put it would generate a clip of
   * whatever the prompt said instead — at video prices.
   */
  readonly imageParam: string | null
  /** PRD §4.3 — gates seed recording *and* pinning. */
  readonly supportsSeed: boolean
  /** The API field name, or null. Named differently on every model (§5). */
  readonly strengthParam: string | null
  readonly negativePromptParam: string | null
  /** PRD §4.5 — the presence of this field is what makes looping offerable. */
  readonly endFrameParam: string | null
  /**
   * Whether the schema makes that end frame **mandatory** (#29).
   *
   * A separate answer from having the field, and the two are not the same
   * capability: `blackforestlabs/flux-3/first-last-frame-to-video` and
   * `fal-ai/veo3.1/first-last-frame-to-video` both refuse a submit that names
   * only a start frame. Since #30 there is always a second frame to send — the
   * start still again — so those rows run like any other animate model and what
   * this field decides is that their loop cannot be switched *off*:
   * `controlAvailability` answers `forced` rather than `available`.
   *
   * `false` on every row with no end frame at all, which `validateRegistry`
   * enforces — "requires the field it does not have" is not a state.
   */
  readonly endFrameRequired: boolean
  readonly durationParam: string | null
  /** Verbatim from the schema enum, as strings. See `durationFormat`. */
  readonly durations: readonly string[]
  /** Null exactly when `durationParam` is. */
  readonly durationFormat: DurationFormat | null
  readonly resolutionParam: string | null
  readonly resolutions: readonly string[]
  /**
   * Fields no registry column names but *this* model still understands — the
   * `generate_audio: false` of PRD §9, which is billed and unwanted on a hero
   * loop that has no sound.
   *
   * Per model rather than a shared whitelist, and that is the whole point. A
   * global list of "extras every model might have" makes `validateRegistry`'s
   * undeclared-default check and the request builder's filter blind for every
   * name on it: a `guidance_scale` default on a model with no such field would
   * pass validation and ship in the body, which is a 422 at the paid step.
   * Empty means the model does not have any — read the schema before adding.
   */
  readonly extraParams: readonly string[]
  /** Ours, never the API's (PRD §5, §6.3). Keyed by API field name. */
  readonly defaults: StageParams
  readonly price: Price | null
  readonly notes: string
}

/** Every control the stage panels can render. */
export type ControlId =
  | 'seed'
  | 'strength'
  | 'negativePrompt'
  | 'duration'
  | 'resolution'
  | 'loop'
  | 'rewind'

/**
 * PRD §10.1. `disabled` keeps the control on screen with a reason, so the tool
 * never looks like it lacks the feature someone picked it for; `hidden` drops
 * it, because nobody needs to be told a model has no negative-prompt field.
 *
 * `forced` is the fourth answer #30 needed and the one neither of the others
 * could give: on the first/last-frame endpoints the end frame is *required*, so
 * every run of them loops. `available` would offer a switch that changes
 * nothing, `disabled` would read as "this model cannot loop", and `hidden`
 * would hide the one capability those rows are chosen for. So the control is
 * shown in the state it is genuinely in — on, unclickable, with the reason
 * beside it.
 */
export type ControlAvailability =
  | { readonly state: 'available' }
  | { readonly state: 'forced'; readonly reasonKey: string }
  | { readonly state: 'disabled'; readonly reasonKey: string }
  | { readonly state: 'hidden' }

const AVAILABLE: ControlAvailability = { state: 'available' }
const HIDDEN: ControlAvailability = { state: 'hidden' }

/**
 * Whether a control is offered, and how it fails.
 *
 * Seed pinning is treated as headline rather than plumbing. It is the one
 * control the whole recipe premise rests on (PRD §1, §4.3) — silently hiding
 * it on a seedless model would mean a recipe that quietly does not re-run.
 */
export function controlAvailability(
  model: ModelCapabilities,
  control: ControlId
): ControlAvailability {
  switch (control) {
    case 'seed':
      return model.supportsSeed
        ? AVAILABLE
        : { state: 'disabled', reasonKey: 'editor.reason.noSeed' }

    // PRD §4.5, built in #30: looping is the start still sent a second time as
    // the end frame, so the field's existence is the whole capability.
    case 'loop':
      if (model.endFrameParam === null) {
        return { state: 'disabled', reasonKey: 'editor.reason.noEndFrame' }
      }
      // The two first/last-frame endpoints refuse a submit that names only a
      // start frame, so their runs are loops whether or not anybody asked.
      // Locked on rather than merely on: a switch that can be turned off would
      // promise a non-looping run those rows cannot serve.
      return model.endFrameRequired
        ? { state: 'forced', reasonKey: 'editor.reason.alwaysLoops' }
        : AVAILABLE

    // Rewind is ffmpeg, not the model (PRD §4.5), so no registry column gates
    // it and no model can rule it out — every clip can be played backwards.
    // Live since #31 built the ping-pong pass.
    //
    // Note what this deliberately does *not* consult: whether ffmpeg is
    // installed. The switch records an intent into the recipe, and an intent
    // outlives the machine it was recorded on — a project made where ffmpeg is
    // installed must not read differently when it is opened where it is not.
    // The missing binary is surfaced where it actually bites, in the export
    // panel, with the install prompt attached.
    case 'rewind':
      return AVAILABLE

    case 'duration':
      return model.durations.length === 0
        ? { state: 'disabled', reasonKey: 'editor.reason.noDuration' }
        : AVAILABLE

    // Plumbing: absent means gone, not greyed out.
    case 'strength':
      return model.strengthParam === null ? HIDDEN : AVAILABLE
    case 'negativePrompt':
      return model.negativePromptParam === null ? HIDDEN : AVAILABLE
    case 'resolution':
      return model.resolutionParam === null ? HIDDEN : AVAILABLE
  }
}

/**
 * Whether this run ends on the frame it started from (PRD §4.5, #30).
 *
 * Derived at request time rather than stored, because the switch's position and
 * the effective answer disagree in both directions. A model that *requires* an
 * end frame loops with the option off; a model with no end-frame field does not
 * loop with it on. Deriving it is what lets `options.loop` survive a model
 * change untouched — nothing is silently rewritten under the user, the intent
 * is simply not acted on where the model cannot act on it.
 *
 * `options` rather than the whole recipe: this is a question about the two
 * booleans, and the request builder and the input builder both have to agree on
 * the answer.
 */
export function loopsOnEndFrame(
  model: ModelCapabilities,
  options: StageParams
): boolean {
  if (model.endFrameParam === null) return false
  return model.endFrameRequired || options.loop === true
}

/**
 * The largest size at *exactly* this ratio that the constraints allow, or
 * `null` when the ratio cannot be expressed at all.
 *
 * Exactly, not approximately: the project ratio is locked (PRD §4.4) and a
 * request that rounds it is a hero that no longer fits the slot it was made
 * for. So the search walks multiples of the ratio in lowest terms rather than
 * scaling one edge and rounding the other.
 *
 * Largest, because these models bill by megapixel or not at all and a hero is
 * the one image where resolution is the point — but bounded by `maxPixels`, so
 * a generous ceiling never turns into a bill nobody asked for.
 */
export function legalSizeFor(
  constraints: DimensionConstraints,
  aspect: AspectId
): PixelSize | null {
  const { width: a, height: b } = aspectById(aspect)
  const { multipleOf, minEdge, maxEdge, minPixels, maxPixels, maxRatio } =
    constraints

  const longest = Math.max(a, b) / Math.min(a, b)
  if (maxRatio !== null && longest > maxRatio) return null

  // The smallest k for which both edges of k·(a:b) land on the grid. Bounded
  // by `multipleOf` itself — beyond that the residues repeat.
  let step = 0
  for (let k = 1; k <= multipleOf; k += 1) {
    if ((k * a) % multipleOf === 0 && (k * b) % multipleOf === 0) {
      step = k
      break
    }
  }
  if (step === 0) return null

  // Walk down from the largest multiple the edge ceiling permits. Bounded, so
  // a nonsense `maxEdge` cannot spin: `n` only ever decreases.
  const maxN = Math.floor(maxEdge / (step * Math.max(a, b)))

  for (let n = maxN; n >= 1; n -= 1) {
    const width = n * step * a
    const height = n * step * b
    if (Math.min(width, height) < minEdge) break

    const pixels = width * height
    if (pixels > maxPixels) continue
    if (pixels < minPixels) break

    return { width, height }
  }

  return null
}

/**
 * PRD §10 — a model is validated against the project's locked aspect ratio at
 * *selection* time, so an incompatible model is refused before it can be
 * chosen rather than at submit, after the user has typed a prompt.
 *
 * All three idioms answer the same question. A ratio-enum model serves the
 * ratios it lists; a free-dimension model serves any ratio it has a legal size
 * for; a model that inherits its geometry serves whatever the input was.
 */
export function modelAvailability(
  model: ModelCapabilities,
  aspect: AspectId
): ControlAvailability {
  const unsupported: ControlAvailability = {
    state: 'disabled',
    reasonKey: 'editor.reason.aspectUnsupported',
  }

  switch (model.aspects.kind) {
    case 'inheritsFromSource':
      return AVAILABLE
    case 'ratioEnum':
      return model.aspects.values[aspect] === undefined
        ? unsupported
        : AVAILABLE
    case 'freeDimensions':
      return legalSizeFor(model.aspects.constraints, aspect) === null
        ? unsupported
        : AVAILABLE
  }
}

/**
 * The aspect field this model wants, ready to spread into a request body.
 *
 * Empty for a model that inherits its geometry — the absence of a key, not a
 * null value, because fal validates unknown fields.
 */
export function aspectRequestFields(
  model: ModelCapabilities,
  aspect: AspectId
): Readonly<Record<string, string | PixelSize>> {
  switch (model.aspects.kind) {
    case 'inheritsFromSource':
      return {}

    case 'ratioEnum': {
      const token = model.aspects.values[aspect]
      if (token === undefined) {
        throw new Error(
          `Model "${model.id}" cannot produce aspect ratio "${aspect}"`
        )
      }
      return { [model.aspects.param]: token }
    }

    case 'freeDimensions': {
      const size = legalSizeFor(model.aspects.constraints, aspect)
      if (size === null) {
        throw new Error(
          `Model "${model.id}" cannot produce aspect ratio "${aspect}"`
        )
      }
      return { [model.aspects.param]: size }
    }
  }
}

/**
 * A duration as the model's own schema wants it (PRD §5) — the whole reason
 * `durationFormat` exists, since the wrong primitive is a 422.
 */
export function serializeDuration(
  model: ModelCapabilities,
  value: string
): string | number {
  const seconds = durationSeconds(value)

  switch (model.durationFormat) {
    case 'integer':
      if (seconds === null) {
        throw new Error(`Duration "${value}" is not a number on "${model.id}"`)
      }
      return seconds
    case 'secondsSuffixed':
      return value.endsWith('s') ? value : `${value}s`
    case 'string':
      return value.endsWith('s') ? value.slice(0, -1) : value
    case null:
      throw new Error(`Model "${model.id}" has no duration parameter`)
  }
}

/** `"5s"` and `"5"` are both five seconds; anything else is not a duration. */
export function durationSeconds(value: string): number | null {
  const parsed = Number(value.endsWith('s') ? value.slice(0, -1) : value)
  return Number.isFinite(parsed) ? parsed : null
}

/** What a run of this model would cost, as far as anyone can tell. */
export interface CostBasis {
  readonly aspect: AspectId
  /** How many candidates the run produces. */
  readonly batch: number
  /** The chosen duration, verbatim from `durations`. Video only. */
  readonly duration?: string
}

/**
 * PRD §10.2 — an approximate figure before the money is spent, or `null` when
 * there is nothing honest to say.
 *
 * `null` is a real answer here, not a failure: `gpt-image-2` is token-priced
 * and no per-image number exists for it. Showing a made-up one would be worse
 * than showing none, because the whole point of the dated estimate is that the
 * user can tell how much to trust it.
 */
export function estimateCost(
  model: ModelCapabilities,
  basis: CostBasis
): number | null {
  const price = model.price
  if (price === null) return null

  switch (price.unit) {
    case 'image':
      return price.amount * basis.batch

    case 'megapixel': {
      if (model.aspects.kind !== 'freeDimensions') return null
      const size = legalSizeFor(model.aspects.constraints, basis.aspect)
      if (size === null) return null
      // Every megapixel-priced endpoint surveyed bills rounded up.
      const megapixels = Math.ceil((size.width * size.height) / 1_000_000)
      return price.amount * megapixels * basis.batch
    }

    case 'second': {
      const chosen =
        basis.duration ??
        String(model.defaults[model.durationParam ?? ''] ?? '')
      const seconds = durationSeconds(chosen)
      if (seconds === null || seconds <= 0) return null
      return price.amount * seconds * basis.batch
    }
  }
}

/**
 * What one finished candidate cost, from the recipe that produced it
 * (ADR 0003).
 *
 * The submit-time counterpart of {@link estimateCost}, at a batch of one: a
 * candidate is one call, whatever else was submitted alongside it. Separate
 * from the estimate the button shows because that one answers "what is this
 * click about to cost" from a draft, and this one answers "what did this cost"
 * from a fact — and only the second is stamped onto the record.
 *
 * `null` when there is nothing honest to say: a model the registry no longer
 * lists, a token-priced one, or a recipe this build cannot read. Never a
 * guessed zero — a project's total has to be able to say some of it is unknown.
 */
export function stampedCost(
  registry: readonly ModelCapabilities[],
  aspect: AspectId,
  recipe: StageRecipe
): number | null {
  const model = registry.find(entry => entry.id === recipe.modelId)
  if (model === undefined) return null

  const chosen = recipe.params[model.durationParam ?? '']

  return estimateCost(model, {
    aspect,
    batch: 1,
    duration: chosen === undefined ? undefined : String(chosen),
  })
}

/**
 * Carry a draft's parameters across a model change.
 *
 * Values whose field name the new model also understands survive; everything
 * else is replaced by *our* default (PRD §5 — fal's own default for `strength`
 * is 0.95, which discards the input entirely, §6.3). Nothing is auto-switched
 * on the user's behalf beyond this: PRD §10.1's rule is that helpfulness which
 * spends money is not helpful.
 */
export function reconcileParams(
  model: ModelCapabilities,
  params: StageParams
): StageParams {
  const next: Record<string, ParamValue> = { ...model.defaults }

  for (const key of Object.keys(model.defaults)) {
    const carried = params[key]
    if (carried !== undefined) next[key] = carried
  }

  return next
}

/** Look-up with a loud failure — an unknown model id is a registry bug. */
export function modelById(
  registry: readonly ModelCapabilities[],
  id: string
): ModelCapabilities {
  const found = registry.find(model => model.id === id)
  if (found === undefined) {
    throw new Error(`No registry entry for model "${id}"`)
  }
  return found
}

export function modelsForStage(
  registry: readonly ModelCapabilities[],
  stage: StageKind
): readonly ModelCapabilities[] {
  return registry.filter(model => model.stage === stage)
}

/**
 * Fails loudly on a malformed entry, naming it.
 *
 * PRD §5: "Registry entries are correctness, not taste: a wrong capability
 * produces confusing API failures with no visual feedback that you got it
 * wrong." The type system covers the shape; this covers the agreements it
 * cannot express — that `durations` and `durationFormat` appear together, that
 * a ratio token is not the empty string, that two entries do not share an id.
 *
 * Called at module load rather than from a test, so a bad registry is a
 * startup crash rather than a 422 at the paid step.
 */
export function validateRegistry(
  registry: readonly ModelCapabilities[]
): readonly ModelCapabilities[] {
  const seen = new Set<string>()

  for (const model of registry) {
    const fail = (problem: string): never => {
      throw new Error(`Registry entry "${model.id || '(unnamed)'}": ${problem}`)
    }

    if (model.id.trim() === '') fail('has no id')
    if (seen.has(model.id)) fail('is declared twice')
    seen.add(model.id)

    if (model.label.trim() === '') fail('has no label')
    if (model.notes.trim() === '') fail('has no notes')
    if (!STAGES.includes(model.stage))
      fail(`has unknown stage "${model.stage}"`)

    validateAspects(model, fail)

    // The image field decides whether the stage can run at all: a style model
    // with nowhere to put the source cannot restyle it, and a source model given
    // one would be sent a field its schema has never heard of (#28).
    if (model.imageParam !== null && model.imageParam.trim() === '') {
      fail('has an unnamed image parameter')
    }
    if (model.stage === 'style' && model.imageParam === null) {
      fail('is a style model with no image parameter to send the source in')
    }
    // Same rule, same reason, one stage later (#29): the still is the whole
    // input to an animate run, and a video model that never received it would
    // bill for a text-to-video of the motion prompt.
    if (model.stage === 'animate' && model.imageParam === null) {
      fail('is an animate model with no image parameter to send the still in')
    }
    if (model.stage === 'source' && model.imageParam !== null) {
      fail('is a source model, which has no input image')
    }
    // Whether the field is a string or an array decides the request body, and a
    // name nobody has recorded a shape for would be guessed at (#28).
    if (
      model.imageParam !== null &&
      imageParamShape(model.imageParam) === null
    ) {
      fail(
        `sends its image in "${model.imageParam}", whose shape is not recorded`
      )
    }

    // "Requires an end frame it has no field for" is not a state a model can be
    // in, so a row claiming it is a typo rather than a capability.
    if (model.endFrameRequired && model.endFrameParam === null) {
      fail('requires an end frame but names no field to put one in')
    }
    // Same rule as the start frame, one field along (#30): the loop fills this
    // one with a whole image, and a name nobody has recorded a shape for would
    // be guessed at — a 422 at the paid step, on a video call.
    if (
      model.endFrameParam !== null &&
      imageParamShape(model.endFrameParam) === null
    ) {
      fail(
        `takes its end frame in "${model.endFrameParam}", whose shape is not recorded`
      )
    }

    if ((model.durationParam === null) !== (model.durationFormat === null)) {
      fail('must declare durationParam and durationFormat together')
    }
    if (model.durationParam === null && model.durations.length > 0) {
      fail('lists durations but has no durationParam')
    }
    if (model.durationParam !== null && model.durations.length === 0) {
      fail('has a durationParam but lists no durations')
    }
    for (const duration of model.durations) {
      if (durationSeconds(duration) === null) {
        fail(`lists an unparseable duration "${duration}"`)
      }
    }

    if ((model.resolutionParam === null) !== (model.resolutions.length === 0)) {
      fail('must declare resolutionParam and resolutions together')
    }

    for (const extra of model.extraParams) {
      if (extra.trim() === '') fail('lists an unnamed extra parameter')
    }

    // A default nothing reads is a default nobody maintains, and a default for
    // a field the model does not have is a 422 waiting to be sent.
    for (const key of Object.keys(model.defaults)) {
      if (!declaredParams(model).has(key)) {
        fail(`defaults an undeclared parameter "${key}"`)
      }
    }
    const durationDefault = model.defaults[model.durationParam ?? '']
    if (
      model.durationParam !== null &&
      durationDefault !== undefined &&
      !model.durations.includes(String(durationDefault))
    ) {
      fail(
        `defaults duration "${String(durationDefault)}", which is not offered`
      )
    }
    const resolutionDefault = model.defaults[model.resolutionParam ?? '']
    if (
      model.resolutionParam !== null &&
      resolutionDefault !== undefined &&
      !model.resolutions.includes(String(resolutionDefault))
    ) {
      fail(
        `defaults resolution "${String(resolutionDefault)}", which is not offered`
      )
    }

    if (model.price !== null) {
      if (!(model.price.amount > 0)) fail('has a non-positive price')
      if (!ISO_DATE.test(model.price.verifiedOn)) {
        fail(`has an undated price ("${model.price.verifiedOn}")`)
      }
    }
  }

  return registry
}

const STAGES: readonly StageKind[] = ['source', 'style', 'animate']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether this model has a field by that name.
 *
 * The request builder's filter: a persisted draft can name anything (a manifest
 * written by a build with a different registry, or hand-edited), and fal
 * rejects a body carrying a field the endpoint has never heard of.
 */
export function declaresParam(model: ModelCapabilities, key: string): boolean {
  return declaredParams(model).has(key)
}

/** Every API field name this entry claims the model understands. */
function declaredParams(model: ModelCapabilities): ReadonlySet<string> {
  const names = [
    model.strengthParam,
    model.negativePromptParam,
    model.imageParam,
    model.endFrameParam,
    model.durationParam,
    model.resolutionParam,
    model.aspects.kind === 'inheritsFromSource' ? null : model.aspects.param,
    // Not a registry field: it is the model's own, and every entry that sends
    // it declares `supportsSeed` instead.
    model.supportsSeed ? 'seed' : null,
  ].filter((name): name is string => name !== null)

  return new Set([...names, ...model.extraParams])
}

function validateAspects(
  model: ModelCapabilities,
  fail: (problem: string) => never
): void {
  const aspects = model.aspects

  if (aspects.kind === 'inheritsFromSource') return

  if (aspects.param.trim() === '')
    fail('has an aspect idiom with no field name')

  if (aspects.kind === 'ratioEnum') {
    const entries = Object.entries(aspects.values)
    if (entries.length === 0) fail('lists no ratios it can serve')
    for (const [id, token] of entries) {
      if (!isAspectId(id))
        fail(`maps a ratio "${id}" this build does not offer`)
      if (typeof token !== 'string' || token.trim() === '') {
        fail(`maps ratio "${id}" to an empty provider token`)
      }
    }
    return
  }

  const c = aspects.constraints
  if (c.multipleOf < 1) fail('has a multipleOf below 1')
  if (c.minEdge < 1 || c.maxEdge < c.minEdge)
    fail('has an impossible edge range')
  if (c.minPixels < 1 || c.maxPixels < c.minPixels) {
    fail('has an impossible pixel range')
  }
  if (c.maxRatio !== null && c.maxRatio < 1) fail('has a maxRatio below 1')

  // A free-dimension model that can serve nothing we offer is a typo in the
  // bounds, not a model worth listing.
  if (ASPECTS.every(a => legalSizeFor(c, a.id) === null)) {
    fail('has constraints that admit none of the curated ratios')
  }
}
