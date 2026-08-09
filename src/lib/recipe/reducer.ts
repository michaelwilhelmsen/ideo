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

import { composePreset, type StylePreset } from './presets'
import { modelById, reconcileParams, type ModelCapabilities } from './registry'
import { clampBatchSize, upstreamOf } from './selectors'
import { isUploadRecipe, uploadRecipe } from './upload'
import { STAGE_ORDER } from './types'
import type {
  EditorState,
  Generation,
  ParamValue,
  Project,
  ProjectSummary,
  RunRecord,
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
  /**
   * The click these candidates came from — one id across the whole batch
   * (#26). Carried per candidate rather than on the action because a
   * generation has to keep it: the strip groups on the record, not on what the
   * editor happened to know at the time.
   */
  readonly runId: string | null
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
  /**
   * The run it was submitted with, or `null` when this session has no record
   * of one — a job can outlive the app, and the candidate is worth more than
   * the grouping.
   */
  readonly runId: string | null
}

/** The editor with nothing open — where the app now starts. */
export function emptyEditorState(): EditorState {
  return {
    summaries: [],
    project: null,
    directory: null,
    activeStage: 'source',
    showRejected: false,
    runs: [],
  }
}

/**
 * How many answered runs a session keeps.
 *
 * They are a handful of ids each and only the newest unanswered one is ever
 * shown, but a session that runs all day should not grow without bound. Old
 * enough to have scrolled far out of the strip is old enough to stop
 * remembering which click produced it.
 */
const RUN_HISTORY = 24

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
  /**
   * A preset was picked — which, for the style stage, *seeds the form* (#28).
   *
   * The preset itself rides on the action rather than being looked up here, for
   * the reason nothing else is minted here either: half the library lives in
   * app data and is loaded by TanStack Query, so the reducer would have to
   * either know about the disk or work from a stale copy of it. `null` is the
   * honest answer for the stages whose libraries are still fixtures — a source
   * or motion preset has no composed prompt to seed with — and for a
   * deselection, which records that nothing is selected and leaves the form
   * exactly as the user left it.
   *
   * Re-seeding after a model switch is this same action with the same preset:
   * seeding is idempotent and always starts the provenance flag clean, which is
   * precisely what "start again from the preset" means.
   */
  | {
      readonly type: 'choosePreset'
      readonly stage: StageKind
      readonly presetId: string | null
      readonly preset: StylePreset | null
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
  /**
   * How many candidates this project's runs of that stage produce (PRD §4.2).
   * Held to the range we would submit, because the action is one keystroke
   * away from a number nobody meant to spend.
   */
  | {
      readonly type: 'setBatchSize'
      readonly stage: StageKind
      readonly size: number
    }
  /**
   * A run started, and these are the candidates it is waiting for (#26).
   *
   * Dispatched by whoever submits — including the sweep that finds jobs a
   * previous launch left running, which adopts them into a run of their own so
   * a resumed batch is watched exactly like a fresh one.
   */
  | {
      readonly type: 'beginRun'
      readonly runId: string
      readonly projectId: string
      readonly stage: StageKind
      readonly generationIds: readonly string[]
      readonly at: number
    }
  /** Candidates that will never arrive: a refused submit, a failed job. */
  | {
      readonly type: 'abandonGenerations'
      readonly generationIds: readonly string[]
    }
  /** Put the grid away without choosing — the run stays in the strip. */
  | { readonly type: 'dismissRun'; readonly runId: string }
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
  /**
   * An image the user brought in, already copied into the project's assets
   * folder by Rust (#27).
   *
   * Deliberately routed through the same fold as a finished job rather than
   * given a path of its own — that is what makes "indistinguishable from a
   * generated one" a property of the code and not a claim in a comment.
   */
  | {
      readonly type: 'recordUpload'
      readonly generationId: string
      /** The bare file name Rust filed it under. */
      readonly asset: string
      /** The user's own name for the file, for the readout. */
      readonly fileName: string
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
          // The runs stay, and so does what has been decided about them: a job
          // goes on running whichever project is in front of you, and a choice
          // made before switching away is still that project's choice.
        }

      case 'closeProject':
        return { ...state, project: null, directory: null }

      case 'selectStage':
        return { ...state, activeStage: action.stage }

      case 'toggleShowRejected':
        return { ...state, showRejected: !state.showRejected }

      // Editing a seeded field is the whole point of seeding — the prompt box is
      // where people find out what the prompt language does (#28) — so this is
      // recorded rather than prevented. `presetModified` is what keeps the
      // recipe honest afterwards about how much of it came from the preset.
      case 'setPrompt':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          prompt: action.prompt,
          presetModified: draft.presetId !== null,
        }))

      // A fresh selection is a fresh seed, so nothing has been changed yet.
      case 'choosePreset':
        return editDraft(state, action.stage, draft =>
          seedFromPreset(registry, draft, action.presetId, action.preset)
        )

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
            // The prompt is deliberately untouched, and so is `presetModified`:
            // switching models keeps whatever the user has written, even when
            // the new model reads a different idiom (#28). The re-seed is
            // *offered* instead — see `presetSeedState`.
          }
        })

      // Strength and the negative prompt are seeded too, so moving one counts —
      // "which preset produced this" is a different claim at 0.8 than at 0.7.
      case 'setParam':
        return editDraft(state, action.stage, draft => ({
          ...draft,
          params: { ...draft.params, [action.key]: action.value },
          presetModified: draft.presetId !== null,
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

      case 'setBatchSize':
        return editProject(state, project => ({
          ...project,
          batchSizes: {
            ...project.batchSizes,
            [action.stage]: clampBatchSize(action.size),
          },
        }))

      // A new run is a new question, so it starts unanswered and unclaimed
      // however the last one ended.
      case 'beginRun':
        return {
          ...state,
          runs: [
            ...forgetOldRuns(state.runs),
            {
              id: action.runId,
              projectId: action.projectId,
              stage: action.stage,
              startedAt: action.at,
              generationIds: action.generationIds,
              abandonedIds: [],
              answered: false,
              claimed: false,
            },
          ],
        }

      case 'abandonGenerations':
        return {
          ...state,
          runs: state.runs.map(run =>
            run.generationIds.some(id => action.generationIds.includes(id))
              ? {
                  ...run,
                  abandonedIds: [
                    ...new Set([...run.abandonedIds, ...action.generationIds]),
                  ].filter(id => run.generationIds.includes(id)),
                }
              : run
          ),
        }

      case 'dismissRun':
        return {
          ...state,
          runs: state.runs.map(run =>
            run.id === action.runId ? { ...run, answered: true } : run
          ),
        }

      case 'runStage':
        return {
          ...editProject(state, project => runStage(registry, project, action)),
          // A fixture stage mints its candidates and selects the first in one
          // go, so its run has been claimed by an arrival before anything else
          // can happen — but not *answered*: the grid still has to be shown,
          // and the user still has to pick from it.
          runs: state.runs.map(run =>
            run.id === action.runs.at(0)?.runId
              ? { ...run, claimed: true }
              : run
          ),
        }

      case 'recordGenerations':
        return withArrivals(state, action.entries, action.at)

      case 'recordUpload':
        return {
          ...editProject(state, project =>
            withCollectedGenerations(
              project,
              [
                {
                  id: action.generationId,
                  stage: 'source',
                  recipe: uploadRecipe(action.fileName),
                  // No model, so no seed — the same honest `null` a seedless
                  // model gets, rather than a number implying a re-run.
                  seed: null,
                  asset: action.asset,
                  runId: null,
                },
              ],
              action.at,
              // Unlike a job arriving, this happened because someone asked for
              // it just now, so it takes the selection whatever else has.
              new Set<StageKind>(['source'])
            )
          ),
          // Bringing an image in is choosing it (#27) — so it answers whatever
          // run is open on the source stage, the same way clicking a candidate
          // does, rather than leaving the grid sitting on top of it.
          ...decidedByUser(state, 'source'),
        }

      case 'selectGeneration':
        return {
          ...editProject(state, project => {
            const generation = project.generations.find(
              candidate => candidate.id === action.generationId
            )
            if (generation === undefined) return project
            return {
              ...project,
              selection: {
                ...project.selection,
                [generation.stage]: generation.id,
              },
            }
          }),
          ...decidedByUser(state, stageOf(state, action.generationId)),
        }

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
 * Pre-fill the form from a preset — the seeding model of #28, in one place.
 *
 * What lands in the box is the *fully composed* prompt, because what is in the
 * box is exactly what is sent: a preset that seeded a fragment and assembled
 * the rest at submit time would be a filter wearing a text field, and the
 * prompt box is where people find out what the prompt language actually does.
 *
 * Three seeded fields, each gated by the registry rather than by the preset:
 *
 * - The prompt, always.
 * - Strength, only where the model has a field for one. The value is already
 *   the model's default or the preset's clamped opinion (`composePreset`).
 * - The negative, only where `negativePromptParam` exists — routed there or
 *   dropped, never folded into the positive prompt (PRD §9). Cleared rather
 *   than left when the new preset has nothing to subtract, or the last
 *   preset's negative would quietly outlive it.
 *
 * A preset that does not speak the model's idiom seeds *nothing* and keeps the
 * user's text. The picker disables that combination with its reason attached,
 * so this is the belt to that braces — and the alternative, seeding the other
 * idiom, is the cross-send the schema exists to prevent (PRD §6.2).
 */
function seedFromPreset(
  registry: readonly ModelCapabilities[],
  draft: StageRecipe,
  presetId: string | null,
  preset: StylePreset | null
): StageRecipe {
  const chosen: StageRecipe = { ...draft, presetId, presetModified: false }
  if (preset === null) return chosen

  const model = modelById(registry, draft.modelId)
  const composed = composePreset(preset, model)
  if (composed === null) return chosen

  const params = { ...draft.params }
  if (model.strengthParam !== null && composed.strength !== null) {
    params[model.strengthParam] = composed.strength
  }
  if (model.negativePromptParam !== null) {
    params[model.negativePromptParam] = composed.negative ?? ''
  }

  return { ...chosen, prompt: composed.prompt, params }
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
      runId: run.runId,
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

/** Which stage a generation belongs to, or `null` if it is not there. */
function stageOf(state: EditorState, generationId: string): StageKind | null {
  return (
    state.project?.generations.find(
      generation => generation.id === generationId
    )?.stage ?? null
  )
}

/**
 * A choice the user made themselves, and what it settles.
 *
 * Every run open on that stage is answered — including runs begun before the
 * click but not yet arrived, and including a click on an old candidate in the
 * strip, which is a statement about what the stage is working from just as
 * much as a click in the grid is. Answered runs put their grid away and stop
 * claiming, so nothing that lands later can undo the click.
 *
 * A run begun *after* this is untouched: asking for new candidates is asking
 * to be shown one.
 */
function decidedByUser(
  state: EditorState,
  stage: StageKind | null
): Pick<EditorState, 'runs'> {
  if (stage === null) return { runs: state.runs }

  return {
    runs: state.runs.map(run =>
      run.stage === stage && run.projectId === state.project?.id
        ? { ...run, answered: true }
        : run
    ),
  }
}

/**
 * Candidates arriving off the job store, and the one question they raise: may
 * this one take the stage's selection?
 *
 * Only when its own run has neither been answered nor already claimed — see
 * {@link RunRecord}. That single rule covers every case: the first arrival
 * claims an undecided stage so the next stage always has an input; the second,
 * third and fourth do not, because the first already decided it; and none of
 * them do once the user has clicked, until a new run asks the question again.
 *
 * A candidate belonging to no known run — one that settled before the sweep
 * could adopt it — is recorded as a run of its own, born answered. It claims
 * the selection, because it is the image someone has been waiting for, and its
 * siblings then join it rather than taking it in turns.
 */
function withArrivals(
  state: EditorState,
  entries: readonly CompletedRun[],
  at: number
): EditorState {
  const before = state.project
  if (before === null) return state

  const runs = [...state.runs]
  const claimable = new Set<StageKind>()

  for (const entry of entries) {
    // Already recorded: a settled event and the sweep can deliver the same job
    // twice, and it decides nothing the second time.
    if (before.generations.some(generation => generation.id === entry.id)) {
      continue
    }

    const owner = runs.findIndex(run => run.generationIds.includes(entry.id))
    const run = runs.at(owner)

    if (run === undefined) {
      const strandedId = strandedRunId(before.id, entry.stage)
      const stranded = runs.findIndex(record => record.id === strandedId)
      const joined = runs.at(stranded)

      // A second stray of the same stage joins the first rather than claiming
      // the selection all over again.
      if (joined !== undefined) {
        runs[stranded] = {
          ...joined,
          generationIds: [...joined.generationIds, entry.id],
        }
        continue
      }

      if (claimable.has(entry.stage)) continue
      claimable.add(entry.stage)
      runs.push(strandedRun(strandedId, before.id, entry, at))
      continue
    }

    if (run.answered || run.claimed) continue
    if (claimable.has(entry.stage)) continue

    claimable.add(entry.stage)
    runs[owner] = { ...run, claimed: true }
  }

  const after = withCollectedGenerations(before, entries, at, claimable)
  if (after === before) return state

  return { ...state, project: after, runs }
}

/**
 * A run nobody recorded, reconstructed from the candidate that turned up.
 *
 * Named after the stage rather than minted, because the reducer mints nothing
 * — and because that is exactly the identity wanted: the *next* stray of the
 * same stage joins this one instead of claiming the selection all over again.
 * Born answered: there was never a grid to answer.
 */
function strandedRunId(projectId: string, stage: StageKind): string {
  return `stranded:${projectId}:${stage}`
}

function strandedRun(
  id: string,
  projectId: string,
  entry: CompletedRun,
  at: number
): RunRecord {
  return {
    id,
    projectId,
    stage: entry.stage,
    startedAt: at,
    generationIds: [entry.id],
    abandonedIds: [],
    answered: true,
    claimed: true,
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
  at: number,
  claimable: ReadonlySet<StageKind>
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
      runId: entry.runId,
    }
  })

  // An arrival takes the stage's selection only where the caller says it may —
  // this is the image the user has been waiting for, possibly across a
  // restart, and the stage after it needs an input whether or not anyone is
  // watching. Who is allowed to claim is not decided here, because it depends
  // on what has happened in the session (see `withArrivals`) and this function
  // also folds results into projects nobody has open.
  //
  // Once per stage per batch, whatever the caller allows: the four candidates
  // of one run must not take it in turns, or the four-up would end on whichever
  // job happened to finish last.
  const selection = { ...project.selection }
  const claimed = new Set<StageKind>()

  for (const generation of created) {
    if (!claimable.has(generation.stage)) continue
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

  // An upload names no model (#27), so there is nothing to load into a form
  // that would produce it again — loading it anyway would leave the draft
  // pointing at a registry entry that does not exist. Refused here rather than
  // hidden in the UI, because the reducer is what the manifest can reach.
  if (isUploadRecipe(recipe)) return project

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

/**
 * Drops the oldest runs once there are more than a session needs.
 *
 * Only *answered* ones. A run the user has not answered is still owed a grid,
 * and one whose jobs are still out there is what stops the sweep adopting them
 * a second time — forgetting either would put a grid back on screen for a
 * question that has already been answered.
 */
function forgetOldRuns(runs: readonly RunRecord[]): readonly RunRecord[] {
  const answered = runs.filter(run => run.answered).length
  if (answered <= RUN_HISTORY) return runs

  let toDrop = answered - RUN_HISTORY
  return runs.filter(run => {
    if (!run.answered || toDrop === 0) return true
    toDrop -= 1
    return false
  })
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
