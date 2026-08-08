/**
 * Derived reads over the recipe model. Pure, and deliberately kept out of the
 * reducer — none of this is state, all of it is a question you can ask of the
 * state, and storing the answers is how two copies drift apart.
 */

import type {
  EditorState,
  Generation,
  Project,
  StageKind,
  StageRecipe,
} from './types'
import { STAGE_ORDER } from './types'

/** The stage whose output this stage consumes. `null` for source. */
export function upstreamOf(stage: StageKind): StageKind | null {
  const index = STAGE_ORDER.indexOf(stage)
  return index <= 0 ? null : (STAGE_ORDER[index - 1] ?? null)
}

export function activeProject(state: EditorState): Project {
  const project = state.projects.find(p => p.id === state.activeProjectId)
  if (project === undefined) {
    throw new Error(`No project "${state.activeProjectId}"`)
  }
  return project
}

export function generationsForStage(
  project: Project,
  stage: StageKind
): readonly Generation[] {
  return project.generations.filter(g => g.stage === stage)
}

/**
 * PRD §10.3 — rejected candidates are filtered, never removed, and one toggle
 * brings them back. The currently selected candidate is always visible even
 * when rejected, because hiding what the next stage is consuming is worse than
 * showing a reject.
 */
export function visibleGenerations(
  project: Project,
  stage: StageKind,
  showRejected: boolean
): readonly Generation[] {
  const all = generationsForStage(project, stage)
  if (showRejected) return all
  return all.filter(
    g => g.verdict !== 'rejected' || g.id === project.selection[stage]
  )
}

export function rejectedCount(project: Project, stage: StageKind): number {
  return generationsForStage(project, stage).filter(
    g => g.verdict === 'rejected'
  ).length
}

export function selectedGeneration(
  project: Project,
  stage: StageKind
): Generation | null {
  const id = project.selection[stage]
  if (id === null) return null
  return project.generations.find(g => g.id === id) ?? null
}

export function generationById(
  project: Project,
  id: string | null
): Generation | null {
  if (id === null) return null
  return project.generations.find(g => g.id === id) ?? null
}

/**
 * Whether this generation was made from something other than what its stage's
 * input is now.
 *
 * Independent re-runs (PRD §4.1) mean an old style candidate stays valid after
 * the source is re-rolled — but "valid" and "comparable" are different things,
 * and without saying so the candidate strip becomes a set of pictures with no
 * shared basis.
 */
export function isFromAnotherInput(
  project: Project,
  generation: Generation
): boolean {
  const upstream = upstreamOf(generation.stage)
  if (upstream === null) return false
  return generation.recipe.inputGenerationId !== project.selection[upstream]
}

/** Whether the stage could run right now, and if not, why. */
export function blockedReasonKey(
  project: Project,
  stage: StageKind
): string | null {
  const upstream = upstreamOf(stage)
  if (upstream === null) return null
  if (project.selection[upstream] === null) {
    return `editor.reason.needs.${upstream}`
  }
  return null
}

/**
 * PRD §4.2 — four images, one video. A pinned seed overrides both: every
 * candidate in the batch would be the same picture.
 */
export function batchSizeFor(stage: StageKind, draft: StageRecipe): number {
  if (draft.seed.mode === 'pinned') return 1
  return stage === 'animate' ? 1 : 4
}

/**
 * The two generations a "one fragment changed" comparison is between: the
 * selected one, and the most recent earlier one that shares its seed.
 *
 * This is the pinned-seed claim (PRD §4.3) made checkable — if the seed really
 * isolates the change, these two differ in exactly the fragment that was
 * edited.
 */
export function seedSibling(
  project: Project,
  generation: Generation
): Generation | null {
  if (generation.seed === null) return null

  const siblings = project.generations.filter(
    g =>
      g.id !== generation.id &&
      g.stage === generation.stage &&
      g.seed === generation.seed
  )

  return siblings.at(-1) ?? null
}

/**
 * Which fragments two recipes disagree about.
 *
 * With the seed pinned this should come back with exactly one entry — that is
 * the check PRD §4.3 is asking for, and it is cheap enough to put on screen
 * rather than leave to the eye.
 */
export function diffRecipes(
  left: StageRecipe,
  right: StageRecipe
): readonly {
  readonly key: string
  readonly before: string
  readonly after: string
}[] {
  const leftFields = new Map(recipeSummary(left).map(f => [f.key, f.value]))
  const rightFields = new Map(recipeSummary(right).map(f => [f.key, f.value]))

  return [...new Set([...leftFields.keys(), ...rightFields.keys()])]
    .map(key => ({
      key,
      before: leftFields.get(key) ?? '—',
      after: rightFields.get(key) ?? '—',
    }))
    .filter(field => field.before !== field.after)
}

/**
 * The fragments of a recipe worth putting on screen next to a candidate.
 * Ordered most-to-least likely to be the thing that changed.
 */
export function recipeSummary(
  recipe: StageRecipe
): readonly { readonly key: string; readonly value: string }[] {
  return [
    { key: 'prompt', value: recipe.prompt },
    { key: 'preset', value: recipe.presetId ?? '—' },
    { key: 'model', value: recipe.modelId },
    ...Object.entries(recipe.params).map(([key, value]) => ({
      key,
      value: String(value),
    })),
    ...Object.entries(recipe.options).map(([key, value]) => ({
      key,
      value: String(value),
    })),
  ]
}
