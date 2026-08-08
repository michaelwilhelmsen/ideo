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

import type { AspectId, ParamValue, StageKind, StageParams } from './types'

/**
 * The registry fields the UI actually derives from.
 *
 * Deliberately a subset of PRD §5's table: `durationFormat`, `promptStyle` and
 * friends matter to the request builder, not to the layout question this
 * prototype is answering, and a field nothing reads is a field nothing checks.
 *
 * `stage` reuses the UI's names (source/style/animate) rather than §5's
 * (image/restyle/video) so there is one vocabulary on screen.
 */
export interface ModelCapabilities {
  readonly id: string
  readonly label: string
  readonly provider: 'fal'
  readonly stage: StageKind
  /** PRD §4.4/§10 — which locked project ratios this model can serve. */
  readonly aspects: readonly AspectId[] | 'inheritsFromSource'
  /** PRD §4.3 — gates seed recording *and* pinning. */
  readonly supportsSeed: boolean
  /** The API field name, or null. Named differently on every model (§5). */
  readonly strengthParam: string | null
  readonly negativePromptParam: string | null
  /** PRD §4.5 — the presence of this field is what makes looping offerable. */
  readonly endFrameParam: string | null
  readonly durationParam: string | null
  readonly durations: readonly string[]
  readonly resolutionParam: string | null
  readonly resolutions: readonly string[]
  /** Ours, never the API's (PRD §5, §6.3). Keyed by API field name. */
  readonly defaults: StageParams
  /** PRD §10.2 — approximate, and dated so staleness is visible. */
  readonly price: {
    readonly amount: number
    readonly unit: string
    readonly verifiedOn: string
  } | null
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
 */
export type ControlAvailability =
  | { readonly state: 'available' }
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

    case 'loop':
      return model.endFrameParam === null
        ? { state: 'disabled', reasonKey: 'editor.reason.noEndFrame' }
        : AVAILABLE

    // Rewind is ffmpeg, not the model — it is always on offer (PRD §4.5).
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
 * PRD §10 — a model is validated against the project's locked aspect ratio at
 * *selection* time, so an incompatible model is refused before it can be
 * chosen rather than at submit, after the user has typed a prompt.
 */
export function modelAvailability(
  model: ModelCapabilities,
  aspect: AspectId
): ControlAvailability {
  if (model.aspects === 'inheritsFromSource') return AVAILABLE
  return model.aspects.includes(aspect)
    ? AVAILABLE
    : { state: 'disabled', reasonKey: 'editor.reason.aspectUnsupported' }
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
