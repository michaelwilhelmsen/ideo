/**
 * The editor reducer — every transition the three-stage editor can make.
 *
 * Pure by construction: no ids are minted and no seeds are rolled in here. The
 * caller passes them in on the action, which is what makes "same pinned seed,
 * one changed fragment" reproducible rather than approximately reproducible
 * (PRD §4.3).
 *
 * The registry is a constructor argument rather than part of the state,
 * because it is repo-committed data (PRD §5) that no action can change.
 */

import { modelById, reconcileParams, type ModelCapabilities } from './registry'
import { upstreamOf } from './selectors'
import { STAGE_ORDER } from './types'
import type {
  EditorState,
  Generation,
  ParamValue,
  Project,
  ProjectSummary,
  StageKind,
  StageRecipe,
} from './types'

/**
 * One model call the caller has already minted an id and a seed for.
 *
 * For a stage with a real model behind it the seed is the one fal *used* and
 * the asset is the file it produced — both are facts by the time this is
 * dispatched, which is why the generation is minted after the call rather than
 * before it. A stage still on fixtures passes a rolled seed and no asset.
 */
export interface PlannedRun {
  readonly id: string
  readonly seed: number
  readonly asset: string | null
}

/**
 * A model call that has already happened, somewhere else.
 *
 * Unlike {@link PlannedRun} this carries its own recipe rather than taking the
 * draft's, because it may have been submitted before the last quit (#24) — by
 * which time the draft in the sidebar says something else entirely, and a
 * generation that adopted it would be describing the wrong image.
 */
export interface CompletedRun {
  readonly id: string
  readonly stage: StageKind
  readonly recipe: StageRecipe
  /** What the model used, or `null` when it has no seed to report. */
  readonly seed: number | null
  readonly asset: string | null
}

/** The editor with nothing open — where the app now starts. */
export function emptyEditorState(): EditorState {
  return {
    summaries: [],
    project: null,
    directory: null,
    activeStage: 'source',
    showRejected: false,
  }
}

export type EditorAction =
  /** The project list arrived from the index. */
  | {
      readonly type: 'setSummaries'
      readonly summaries: readonly ProjectSummary[]
    }
  /** A manifest finished loading — this is what "open a project" means now. */
  | {
      readonly type: 'openProject'
      readonly project: Project
      readonly directory: string
    }
  /** The open project was deleted, or there was never one to open. */
  | { readonly type: 'closeProject' }
  | { readonly type: 'selectStage'; readonly stage: StageKind }
  | {
      readonly type: 'setPrompt'
      readonly stage: StageKind
      readonly prompt: string
    }
  | {
      readonly type: 'choosePreset'
      readonly stage: StageKind
      readonly presetId: string | null
    }
  | {
      readonly type: 'chooseModel'
      readonly stage: StageKind
      readonly modelId: string
    }
  | {
      readonly type: 'setParam'
      readonly stage: StageKind
      readonly key: string
      readonly value: ParamValue
    }
  | {
      readonly type: 'setOption'
      readonly stage: StageKind
      readonly key: string
      readonly value: ParamValue
    }
  | {
      readonly type: 'pinSeed'
      readonly stage: StageKind
      readonly value: number
    }
  | { readonly type: 'unpinSeed'; readonly stage: StageKind }
  | {
      readonly type: 'runStage'
      readonly stage: StageKind
      readonly runs: readonly PlannedRun[]
      readonly at: number
    }
  /**
   * Jobs that finished, collected off the job store (#24). Separate from
   * `runStage` because these already have their recipe, their seed and their
   * file — there is nothing left to plan.
   */
  | {
      readonly type: 'recordGenerations'
      readonly entries: readonly CompletedRun[]
      readonly at: number
    }
  | { readonly type: 'selectGeneration'; readonly generationId: string }
  | {
      readonly type: 'setVerdict'
      readonly generationId: string
      readonly verdict: Generation['verdict']
    }
  | { readonly type: 'restoreRecipe'; readonly generationId: string }
  | { readonly type: 'toggleShowRejected' }

export type EditorReducer = (
  state: EditorState,
  action: EditorAction
) => EditorState

export function createEditorReducer(
  registry: readonly ModelCapabilities[]
): EditorReducer {
  return function editorReducer(state, action) {
    switch (action.type) {
      case 'setSummaries':
        return { ...state, summaries: action.summaries }

      case 'openProject':
        return {
          ...state,
          project: action.project,
          directory: action.directory,
          // Land on the stage the project has actually got to, so opening an
          // untouched project does not start on a stage it cannot run.
          activeStage: furthestStage(action.project),
        }

      case 'closeProject':
        return { ...state, project: null, directory: null }

      case 'selectStage':
        return { ...state, activeStage: action.stage }

      case 'toggleShowRejected':
        return { ...state, showRejected: !state.showRejected }

      case 'setPrompt':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          prompt: action.prompt,
        }))

      case 'choosePreset':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          presetId: action.presetId,
        }))

      case 'chooseModel':
        return editDraft(state, action.stage, draft => {
          if (draft.modelId === action.modelId) return draft
          const model = modelById(registry, action.modelId)
          return {
            ...draft,
            modelId: action.modelId,
            // Our defaults fill whatever the new model does not inherit — never
            // the API's, which are actively wrong for restyling (PRD §6.3).
            params: reconcileParams(model, draft.params),
            // A model with no seed field cannot honour a pin. Dropping it here
            // keeps the draft from claiming a reproducibility it does not have.
            seed: model.supportsSeed ? draft.seed : { mode: 'roll' },
          }
        })

      case 'setParam':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          params: { ...draft.params, [action.key]: action.value },
        }))

      case 'setOption':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          options: { ...draft.options, [action.key]: action.value },
        }))

      case 'pinSeed':
        return editDraft(state, action.stage, draft =>
          modelById(registry, draft.modelId).supportsSeed
            ? { ...draft, seed: { mode: 'pinned', value: action.value } }
            : draft
        )

      case 'unpinSeed':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          seed: { mode: 'roll' },
        }))

      case 'runStage':
        return editProject(state, project =>
          runStage(registry, project, action)
        )

      case 'recordGenerations':
        return editProject(state, project =>
          withCollectedGenerations(project, action.entries, action.at)
        )

      case 'selectGeneration':
        return editProject(state, project => {
          const generation = project.generations.find(
            g => g.id === action.generationId
          )
          if (generation === undefined) return project
          return {
            ...project,
            selection: {
              ...project.selection,
              [generation.stage]: generation.id,
            },
          }
        })

      case 'setVerdict':
        return editProject(state, project => ({
          ...project,
          // Rewrite in place: a rejected candidate stays in the list, keeps its
          // label, and keeps its recipe (PRD §10.3). Nothing is removed here.
          generations: project.generations.map(generation =>
            generation.id === action.generationId
              ? { ...generation, verdict: action.verdict }
              : generation
          ),
        }))

      case 'restoreRecipe':
        return editProject(state, project =>
          restoreRecipe(project, action.generationId)
        )
    }
  }
}

/**
 * Submit the current draft.
 *
 * The draft is *copied* onto each generation with the upstream pointer
 * resolved. That copy is the whole point: the sidebar form keeps moving, and a
 * generation has to stay re-runnable regardless.
 */
function runStage(
  registry: readonly ModelCapabilities[],
  project: Project,
  action: Extract<EditorAction, { type: 'runStage' }>
): Project {
  const draft = project.drafts[action.stage]
  const model = modelById(registry, draft.modelId)

  const frozen = freezeRecipe(project, action.stage)
  if (frozen === null) return project

  // A pinned seed makes every candidate in a batch identical, so a pin
  // collapses the batch to one. Four copies of the same image is not a choice.
  const runs =
    draft.seed.mode === 'pinned' ? action.runs.slice(0, 1) : action.runs

  let ordinal = nextOrdinal(project, action.stage)

  const created = runs.map((run): Generation => {
    const seed = draft.seed.mode === 'pinned' ? draft.seed.value : run.seed

    return {
      id: run.id,
      stage: action.stage,
      recipe: frozen,
      // Recorded even when rolled — a result you like is worthless if you
      // cannot pin what produced it (PRD §4.3). Null only when the model has
      // no seed at all, which is the honest way to say "not reproducible".
      seed: model.supportsSeed ? seed : null,
      verdict: 'unrated',
      createdAt: action.at,
      ordinal: ordinal++,
      asset: run.asset,
    }
  })

  if (created.length === 0) return project

  return {
    ...project,
    generations: [...project.generations, ...created],
    // A fresh run selects its first candidate, so the preview is never blank
    // after a click. Downstream stages keep pointing at what they already
    // consumed — nothing further along is invalidated.
    selection: { ...project.selection, [action.stage]: created[0]?.id ?? null },
  }
}

/**
 * The draft as it would be submitted right now: a copy, with the upstream
 * pointer resolved. `null` when the stage has nothing to work from.
 *
 * Exported because a submitted job carries this to Rust and gets it back when
 * it lands (#24). Freezing it in two places would mean a resumed generation
 * could describe itself differently from a fresh one.
 */
export function freezeRecipe(
  project: Project,
  stage: StageKind
): StageRecipe | null {
  const upstream = upstreamOf(stage)
  const inputGenerationId =
    upstream === null ? null : project.selection[upstream]

  // Style and animate need something to work from. Source never does — which
  // is exactly why re-running style leaves the source alone (PRD §4.1).
  if (upstream !== null && inputGenerationId === null) return null

  return { ...project.drafts[stage], inputGenerationId }
}

/**
 * Fold finished jobs into a project.
 *
 * Everything here is already a fact, so nothing is derived from the draft —
 * see {@link CompletedRun}. Ids already present are skipped rather than
 * appended twice: a settled event can arrive alongside the periodic sweep that
 * exists for the events a quit lost, and both would otherwise record the same
 * paid generation. Returns the project unchanged when there is nothing new,
 * which is how the caller knows there is nothing to write.
 *
 * Exported as well as dispatched, because a job can finish for a project that
 * is not the open one (#24) — that manifest is collected off disk rather than
 * through the editor, and both paths have to fold identically.
 */
export function withCollectedGenerations(
  project: Project,
  entries: readonly CompletedRun[],
  at: number
): Project {
  const known = new Set(project.generations.map(generation => generation.id))
  const arriving = entries.filter(entry => !known.has(entry.id))

  if (arriving.length === 0) return project

  const ordinals = new Map<StageKind, number>()
  const created = arriving.map((entry): Generation => {
    const ordinal =
      ordinals.get(entry.stage) ?? nextOrdinal(project, entry.stage)
    ordinals.set(entry.stage, ordinal + 1)

    return {
      id: entry.id,
      stage: entry.stage,
      recipe: entry.recipe,
      seed: entry.seed,
      verdict: 'unrated',
      createdAt: at,
      ordinal,
      asset: entry.asset,
    }
  })

  // The first arrival in each stage is selected, the same way a fresh run
  // selects its first candidate: this is the image the user has been waiting
  // for, possibly across a restart. Later arrivals in the same batch do not
  // keep stealing it, or a four-up would end on whichever finished last.
  const selection = { ...project.selection }
  const claimed = new Set<StageKind>()
  for (const generation of created) {
    if (claimed.has(generation.stage)) continue
    claimed.add(generation.stage)
    selection[generation.stage] = generation.id
  }

  return {
    ...project,
    generations: [...project.generations, ...created],
    selection,
  }
}

/**
 * Load a past generation's recipe back into the draft — the recipe premise
 * (PRD §1) made operable. The upstream selection moves too, otherwise a
 * "restore" would re-run against whatever happens to be selected now.
 */
function restoreRecipe(project: Project, generationId: string): Project {
  const generation = project.generations.find(g => g.id === generationId)
  if (generation === undefined) return project

  const { stage, recipe } = generation
  const upstream = upstreamOf(stage)
  const inputStillExists =
    recipe.inputGenerationId !== null &&
    project.generations.some(g => g.id === recipe.inputGenerationId)

  return {
    ...project,
    drafts: { ...project.drafts, [stage]: recipe },
    selection:
      upstream !== null && inputStillExists
        ? { ...project.selection, [upstream]: recipe.inputGenerationId }
        : project.selection,
  }
}

function editDraft(
  state: EditorState,
  stage: StageKind,
  change: (draft: StageRecipe) => StageRecipe
): EditorState {
  return editProject(state, project => ({
    ...project,
    drafts: { ...project.drafts, [stage]: change(project.drafts[stage]) },
  }))
}

/**
 * Every edit lands on the open project, or on nothing at all. An action that
 * arrives with nothing open is dropped rather than queued — the only way that
 * happens is a click racing a project being closed.
 */
function editProject(
  state: EditorState,
  change: (project: Project) => Project
): EditorState {
  if (state.project === null) return state
  return { ...state, project: change(state.project) }
}

/**
 * The last stage that has produced anything — where opening a project should
 * drop you. Stage order is the pipeline order, so this is "as far as this
 * project has got", not "where you were last time".
 */
function furthestStage(project: Project): StageKind {
  return (
    [...STAGE_ORDER]
      .reverse()
      .find(stage => project.generations.some(g => g.stage === stage)) ??
    'source'
  )
}

/**
 * Ordinals count every generation ever made in the stage, including rejected
 * ones — nothing is deleted, so nothing is reused.
 */
function nextOrdinal(project: Project, stage: StageKind): number {
  return project.generations.filter(g => g.stage === stage).length + 1
}
