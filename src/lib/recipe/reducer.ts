/**
 * The editor reducer — every transition the canvas can make.
 *
 * Addressed by **node** since ADR 0005. What was `stage: StageKind` on every
 * draft-editing action is now `nodeId: string`, because a canvas can hold two
 * style steps and a string literal could only ever name one of them.
 *
 * Pure by construction: no ids are minted and no seeds are rolled in here. The
 * caller passes them in on the action, which is what makes "same pinned seed,
 * one changed fragment" reproducible rather than approximately reproducible
 * (PRD §4.3).
 *
 * The registry is a constructor argument rather than part of the state,
 * because it is repo-committed data (PRD §5) that no action can change.
 */

import { treatmentFor, withKnob, type EffectsLook } from '@/lib/effects'
import { isMotionPreset, type MotionPreset } from './motion'
import type { Palette } from './palette'
import {
  composePreset,
  NO_VARIABLE_VALUES,
  type Preset,
  type PresetVariableValues,
} from './presets'
import {
  loopsOnEndFrame,
  modelById,
  reconcileParams,
  stampedCost,
  type ModelCapabilities,
} from './registry'
import {
  clampBatchSize,
  DEFAULT_BATCH_SIZES,
  isEligibleInput,
  nodeIdOf,
  resolvedInputId,
} from './selectors'
import { canConnect, heldModelIds, makeNode, nodeById } from './graph'
import { isUploadRecipe, uploadRecipe } from './upload'
import { needsInput } from './types'
import type {
  DraftNode,
  DraftRecipe,
  EditorState,
  Generation,
  NodePosition,
  ParamValue,
  Project,
  ProjectSummary,
  RunRecord,
  StageKind,
  StageRecipe,
  Treatment,
  TreatmentValue,
} from './types'

/**
 * One model call the caller has already minted an id and a seed for.
 *
 * For a node with a real model behind it the seed is the one fal *used* and
 * the asset is the file it produced — both are facts by the time this is
 * dispatched, which is why the generation is minted after the call rather than
 * before it.
 */
export interface PlannedRun {
  readonly id: string
  /**
   * Which model of the node's fan-out this call went to (ADR 0005).
   *
   * Per candidate rather than on the action, because that is what a fan-out is:
   * one click, one run id, several models. The frozen recipe on each generation
   * names this one and reconciles the shared parameter bag against it.
   */
  readonly modelId: string
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
  /**
   * The frozen recipe, which is also where its node id is —
   * {@link StageRecipe.nodeId}. Nothing on this interface names the node
   * separately, because the recipe is the copy that made the round trip through
   * the job store and a second field would be a second answer.
   */
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
  /**
   * What it cost, in USD, or `null` when there is nothing honest to say
   * (ADR 0003).
   *
   * A fact carried in rather than derived here, like `seed` and `asset`, and
   * for the same reason: the reducer mints nothing. Estimating needs the model
   * registry and the project's ratio, which is the collector's business.
   */
  readonly costUsd: number | null
  /** fal's id for the call, kept before claiming destroys it (ADR 0003). */
  readonly requestId: string | null
}

/** The editor with nothing open — where the app now starts. */
export function emptyEditorState(): EditorState {
  return {
    summaries: [],
    project: null,
    directory: null,
    selectedNodeId: null,
    effectsOpen: false,
    treatmentTarget: null,
    showRejected: false,
    presetVariables: {},
    runs: [],
  }
}

/**
 * What the open project's variable fields say for one node.
 *
 * A project nobody has typed into has no entry at all, and neither does a node
 * — which is the same answer as an empty one. So this is the read every caller
 * wants, and the reason the state holds no row until there is something to put
 * in it.
 */
export function presetVariablesFor(
  state: EditorState,
  projectId: string,
  nodeId: string
): PresetVariableValues {
  return state.presetVariables[projectId]?.[nodeId] ?? NO_VARIABLE_VALUES
}

/**
 * One node's variable fields, as they now read.
 *
 * Written against the open project, because that is the only one whose picker
 * anybody is looking at. With nothing open there is no project to file them
 * under, and the action is dropped rather than filed somewhere.
 */
function withVariables(
  state: EditorState,
  nodeId: string,
  values: PresetVariableValues
): EditorState {
  const projectId = state.project?.id
  if (projectId === undefined) return state

  return {
    ...state,
    presetVariables: {
      ...state.presetVariables,
      [projectId]: {
        ...(state.presetVariables[projectId] ?? {}),
        [nodeId]: values,
      },
    },
  }
}

/** A deleted project's fields, dropped — there is nothing to come back to. */
function withoutVariables(
  state: EditorState,
  projectId: string | undefined
): EditorState['presetVariables'] {
  if (projectId === undefined) return state.presetVariables

  const { [projectId]: _dropped, ...kept } = state.presetVariables
  return kept
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
  /**
   * The node the right sidebar edits — a click on the canvas (ADR 0005).
   *
   * `null` is a real value and not a gap: clicking empty canvas deselects, and
   * the sidebar shows the project's own panel. That is why this replaced
   * `selectStage` rather than being renamed from it — a tab bar always had a
   * current tab, and a canvas does not.
   */
  | { readonly type: 'selectNode'; readonly nodeId: string | null }
  /**
   * A node was added to the canvas.
   *
   * The id and the position both ride on the action, for the reason nothing is
   * minted in here: the reducer stays pure, and `placeNode` is what the caller
   * uses to work out where a node dropped from a "+" on another node goes.
   *
   * `fromNodeId` is wired as the new node's input where its kind takes one, so
   * "add a style node off this source" is one action rather than an add
   * followed by a connect that could fail on its own.
   */
  | {
      readonly type: 'addNode'
      readonly nodeId: string
      readonly kind: StageKind
      readonly position: NodePosition
      readonly fromNodeId: string | null
    }
  /**
   * A node removed, and its candidates with it (ADR 0005).
   *
   * Destructive on purpose and confirmed in the UI: a node is the only place a
   * candidate can live now, so keeping the pictures would leave them with no
   * home on the one surface there is. The **files** stay on disk for the
   * deliberate cleanup pass (PRD §10.3), so nothing is unrecoverable until the
   * user asks for it to be.
   *
   * Anything downstream is detached rather than deleted with it — losing one
   * step of a chain should not cost the rest of the chain.
   */
  | { readonly type: 'deleteNode'; readonly nodeId: string }
  /** Dragged. Positions are the user's work, so they persist. */
  | {
      readonly type: 'moveNode'
      readonly nodeId: string
      readonly position: NodePosition
    }
  /**
   * An edge drawn between two drafts — the gesture ADR 0005 exists for.
   *
   * Validated against `canConnect` in here rather than at the drag, because the
   * action is reachable from a hand-edited manifest as well as from React Flow,
   * and a cycle written by either is a graph nothing downstream would survive.
   */
  | {
      readonly type: 'connectNodes'
      readonly sourceNodeId: string
      readonly targetNodeId: string
    }
  /** An edge removed. The node keeps its draft and stops being runnable. */
  | { readonly type: 'disconnectNode'; readonly nodeId: string }
  /** The user's own name for a step, or `null` to go back to its kind's. */
  | {
      readonly type: 'renameNode'
      readonly nodeId: string
      readonly title: string | null
    }
  | {
      readonly type: 'setPrompt'
      readonly nodeId: string
      readonly prompt: string
    }
  /**
   * A preset was picked, which *seeds the form* — on every stage since #47.
   *
   * The preset itself rides on the action rather than being looked up here, for
   * the reason nothing else is minted here either: half of each library lives in
   * app data and is loaded by TanStack Query, so the reducer would have to
   * either know about the disk or work from a stale copy of it. `null` is the
   * honest answer for a deselection, which records that nothing is selected and
   * leaves the form exactly as the user left it, and for a save, where the form
   * already says what the preset says and only the pointer has to move.
   *
   * Two *shapes* can arrive here, from three libraries, and they are told apart
   * by what they are rather than by the node's kind (`isMotionPreset`): the kind
   * says which control you clicked, and what to seed is a question about the
   * value.
   *
   * Seeded against the node's **primary** model — `modelIds[0]` — and offered
   * by the picker only where every model in the fan-out reads the same idiom
   * (ADR 0005). One prompt box shared by three models cannot be prose for one of
   * them and a keyword list for another.
   *
   * Re-seeding after a model switch is this same action with the same preset:
   * seeding is idempotent and always starts the provenance flag clean, which is
   * precisely what "start again from the preset" means. Changing a template
   * variable is the same action too, with a different `values` — which is what
   * makes a variable field a re-seed rather than a second kind of edit.
   */
  | {
      readonly type: 'choosePreset'
      readonly nodeId: string
      readonly presetId: string | null
      readonly preset: Preset | MotionPreset | null
      /**
       * What the picker's variable fields say (#46), which is also what gets
       * filed under the project — so a pick carries the fields as they stand
       * rather than clearing them: the next scene asks its own questions, and
       * the ones it shares with the last one have been answered already.
       *
       * Absent where the action says nothing about the fields — a re-point
       * after a save, or the motion library, whose presets are one whole prompt
       * with no holes in it. Absent is not empty: clearing them there would
       * strand the prompt they were expanded into.
       */
      readonly values?: PresetVariableValues
    }
  /**
   * A variable field changed without the prompt following it (#46).
   *
   * The other half of `choosePreset`'s `values`: when the box still says what
   * the preset says, a variable edit *is* a re-seed and goes through that
   * action. When the box has been edited by hand it is not — the re-seed is
   * offered rather than forced (#28) — and this records what the field says so
   * the offer, when taken, takes the current answer with it.
   */
  | {
      readonly type: 'setPresetVariables'
      readonly nodeId: string
      readonly values: PresetVariableValues
    }
  /**
   * The models this node fans out to (ADR 0005) — the action that replaced
   * `chooseModel`, and the one this whole change is for.
   *
   * A **set**, not a choice. Picking a second model is not a correction of the
   * first: it is asking for both, on the same prompt, in one click. The old
   * single-model action is the degenerate case of this one and needs no separate
   * path.
   *
   * Held to `MAX_MODELS_PER_NODE` and to at least one entry (`heldModelIds`),
   * because both ends are reachable from a hand-edited manifest and both are
   * expensive in opposite directions.
   */
  | {
      readonly type: 'setModels'
      readonly nodeId: string
      readonly modelIds: readonly string[]
    }
  | {
      readonly type: 'setParam'
      readonly nodeId: string
      readonly key: string
      readonly value: ParamValue
    }
  | {
      readonly type: 'setOption'
      readonly nodeId: string
      readonly key: string
      readonly value: ParamValue
    }
  | {
      readonly type: 'pinSeed'
      readonly nodeId: string
      readonly value: number
    }
  | { readonly type: 'unpinSeed'; readonly nodeId: string }
  /**
   * Which candidate of its input node this node runs from — the input row's
   * click.
   *
   * A refinement of the edge rather than a second edge, and rather than a pick:
   * `DraftNode.pick` means "the candidate *this* node has produced that I have
   * settled on", and choosing which picture to consume is not a claim about the
   * upstream node's own choice at all.
   *
   * `null` hands the node back to the default — the input node's pick, then its
   * newest approved candidate (`resolvedInputId`) — rather than leaving it with
   * nothing to work from.
   */
  | {
      readonly type: 'pinNodeInput'
      readonly nodeId: string
      readonly generationId: string | null
    }
  /**
   * How many candidates one run of this node produces **per model** (PRD §4.2).
   * Held to the range we would submit, because the action is one keystroke
   * away from a number nobody meant to spend — and with fan-out, one keystroke
   * away from four times that.
   */
  | {
      readonly type: 'setBatchSize'
      readonly nodeId: string
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
      readonly nodeId: string
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
  /**
   * A run of one node, as candidates that already exist.
   *
   * Every entry carries its own `modelId`, because one click on a three-model
   * node is one run of three different recipes — the fan-out is expanded by the
   * caller (`planRun`) and frozen per entry in here.
   */
  | {
      readonly type: 'runNode'
      readonly nodeId: string
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
   * What fal says the open project's calls actually cost (#56, ADR 0003).
   *
   * Keyed by `requestId` rather than by generation, because that is what the
   * billing events are keyed by and the pass that fetched them read the whole
   * library's window in one go — it has no idea which of these belong here.
   */
  | {
      readonly type: 'reconcileCosts'
      readonly charges: ReadonlyMap<string, number>
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
      /** The source node it lands on — an upload is a candidate of a node. */
      readonly nodeId: string
      /** The bare file name Rust filed it under. */
      readonly asset: string
      /** The user's own name for the file, for the readout. */
      readonly fileName: string
      readonly at: number
    }
  /** A candidate clicked — this becomes its node's `pick`. */
  | { readonly type: 'selectGeneration'; readonly generationId: string }
  | {
      readonly type: 'setVerdict'
      readonly generationId: string
      readonly verdict: Generation['verdict']
    }
  | { readonly type: 'setPalette'; readonly palette: Palette }
  | { readonly type: 'restoreRecipe'; readonly generationId: string }
  | { readonly type: 'toggleShowRejected' }
  /** The effects panel is the one on screen now (#36). */
  | { readonly type: 'openEffects' }
  /**
   * Back to the canvas.
   *
   * Its own action rather than leaning on `selectNode`'s side effect: closing
   * the panel is not choosing a node, and a caller that had to re-select the
   * node it was already on to get out would be describing the wrong intent.
   * The treatment pin stays — it is about a candidate, not about what is on
   * screen — so reopening lands back where you were.
   */
  | { readonly type: 'closeEffects' }
  /**
   * Treat this candidate, and keep treating it.
   *
   * The pin is what stops a selection change elsewhere in the app moving you
   * onto a different generation's treatment mid-edit. Opens the tab too, because
   * "Treat this" is one gesture and the alternative is a button whose effect is
   * on a tab you cannot see.
   */
  | { readonly type: 'pinTreatment'; readonly generationId: string }
  /** Back to following the selection. */
  | { readonly type: 'unpinTreatment' }
  /**
   * A look was chosen for one candidate — or `null` to leave it untreated.
   *
   * The look rides on the action rather than being looked up here, for the
   * reason `choosePreset` carries its preset: half the library lives in app data
   * behind TanStack Query, so the reducer would have to know about the disk or
   * work from a stale copy of it.
   */
  | {
      readonly type: 'chooseLook'
      readonly generationId: string
      readonly look: EffectsLook | null
    }
  /** One knob turned. The look comes along so the value can be held to it. */
  | {
      readonly type: 'setKnob'
      readonly generationId: string
      readonly look: EffectsLook
      readonly key: string
      readonly value: TreatmentValue
    }
  /**
   * What #53's declarations ask for, offered to a candidate that has none.
   *
   * A **seed, never a lock**: this is refused outright where a treatment already
   * exists, which is what keeps a re-seed from ever overwriting a value the user
   * has touched. The caller may dispatch it on every render without checking —
   * that is the point of putting the rule here rather than in the component.
   */
  | {
      readonly type: 'seedTreatment'
      readonly generationId: string
      readonly treatment: Treatment
    }

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
          // Land on the node the project has actually got to, so opening an
          // untouched project does not start on a node it cannot run.
          selectedNodeId: furthestNodeId(action.project),
          // A pin names a candidate of whichever project was open, so opening
          // another drops it rather than pointing it at nothing.
          treatmentTarget: null,
          // The variable fields stay, filed under the project they belong to:
          // looking at another project is not answering this one's questions
          // again, and coming back to it should find the subject you left.
          // The runs stay, and so does what has been decided about them: a job
          // goes on running whichever project is in front of you, and a choice
          // made before switching away is still that project's choice.
        }

      case 'closeProject':
        // The pin names a candidate of the project that is going away, so it
        // goes with it — a pin that survived would point at nothing.
        return {
          ...state,
          project: null,
          directory: null,
          selectedNodeId: null,
          treatmentTarget: null,
          // Unlike opening another project, this one is *gone* — so its fields
          // go with it rather than waiting for a return that cannot happen.
          presetVariables: withoutVariables(state, state.project?.id),
        }

      case 'selectNode':
        // Selecting a node is asking the sidebar to edit it, and the effects
        // panel is the sidebar's other mode — so this closes it. The treatment
        // pin stays: it is about a candidate, not about what the sidebar shows.
        return { ...state, selectedNodeId: action.nodeId, effectsOpen: false }

      case 'addNode':
        return {
          // Selected on arrival, because adding a node is the first half of
          // filling it in and the sidebar is where that happens.
          ...editProject(state, project => ({
            ...project,
            nodes: [
              ...project.nodes,
              makeNode(
                action.nodeId,
                action.kind,
                action.position,
                // Wired only where it would be legal — `addNode` off a node of
                // an incompatible kind adds an unwired node rather than
                // refusing the whole action.
                action.fromNodeId,
                DEFAULT_BATCH_SIZES[action.kind]
              ),
            ],
          })),
          selectedNodeId: action.nodeId,
          effectsOpen: false,
        }

      case 'deleteNode':
        return withoutNode(state, action.nodeId)

      case 'moveNode':
        return editNode(state, action.nodeId, node => ({
          ...node,
          position: action.position,
        }))

      case 'connectNodes':
        return editProject(state, project =>
          canConnect(project, action.sourceNodeId, action.targetNodeId)
            ? withNode(project, action.targetNodeId, node => ({
                ...node,
                inputNodeId: action.sourceNodeId,
                // The old pin named a candidate of the *previous* input, so it
                // cannot survive the rewire — and leaving it would make
                // `resolvedInputId` fall through in silence rather than
                // following the edge the user just drew.
                pinnedInputId: null,
              }))
            : project
        )

      case 'disconnectNode':
        return editNode(state, action.nodeId, node => ({
          ...node,
          inputNodeId: null,
          pinnedInputId: null,
        }))

      case 'renameNode':
        return editNode(state, action.nodeId, node => ({
          ...node,
          // An empty box means "no name", not a name that is empty — otherwise
          // clearing the field would leave a node with no legible label at all.
          title:
            action.title === null || action.title === '' ? null : action.title,
        }))

      case 'toggleShowRejected':
        return { ...state, showRejected: !state.showRejected }

      // Editing a seeded field is the whole point of seeding — the prompt box is
      // where people find out what the prompt language does (#28) — so this is
      // recorded rather than prevented. `presetModified` is what keeps the
      // recipe honest afterwards about how much of it came from the preset.
      case 'setPrompt':
        return editDraft(state, action.nodeId, draft => ({
          ...draft,
          prompt: action.prompt,
          // The prompt is seeded on every supported model, so this always counts.
          presetModified: modifiedByEdit(draft, true),
        }))

      // A fresh selection is a fresh seed, so nothing has been changed yet.
      case 'choosePreset': {
        const seeded = editDraft(state, action.nodeId, (draft, project) =>
          seedFromPreset(
            registry,
            project.palette,
            draft,
            action.presetId,
            action.preset,
            action.values ?? NO_VARIABLE_VALUES
          )
        )

        // The fields that produced this prose, kept beside it. Absent `values`
        // is not an empty set: a re-point after a save says nothing about the
        // fields, and clearing them would strand the prompt they expanded into.
        return action.values === undefined
          ? seeded
          : withVariables(seeded, action.nodeId, action.values)
      }

      case 'setPresetVariables':
        return withVariables(state, action.nodeId, action.values)

      // Prompt data, not chrome (#46) — and editable after creation precisely
      // because it cannot reach backwards: every recipe already persisted its
      // expanded prose, so this only changes what the next pick seeds.
      case 'setPalette':
        return editProject(state, project => ({
          ...project,
          palette: action.palette,
        }))

      // The fan-out (ADR 0005). One prompt, N models, and the shared parameter
      // bag reconciled against the *primary* one so the sidebar has a coherent
      // set of knobs to show; each frozen copy reconciles again for its own
      // model at run time, so nothing here has to be right for all of them.
      case 'setModels':
        return editDraft(state, action.nodeId, draft => {
          const modelIds = heldModelIds(
            action.modelIds,
            draft.modelIds[0] ?? ''
          )
          if (sameIds(modelIds, draft.modelIds)) return draft

          const primary = modelById(registry, modelIds[0] ?? '')
          const models = modelIds.map(id => modelById(registry, id))

          return {
            ...draft,
            modelIds,
            // Our defaults fill whatever the new primary does not inherit —
            // never the API's, which are actively wrong for restyling (PRD §6.3).
            params: reconcileParams(primary, draft.params),
            // A pin can only be honoured where *every* model in the fan-out has
            // a seed field. Keeping it otherwise would let one half of a
            // comparison claim a reproducibility the other half does not have,
            // which is exactly the claim a pinned seed exists to make.
            seed: models.every(model => model.supportsSeed)
              ? draft.seed
              : { mode: 'roll' },
            // The prompt is deliberately untouched, and so is `presetModified`:
            // changing the fan-out keeps whatever the user has written, even
            // when a new model reads a different idiom (#28). The re-seed is
            // *offered* instead — see `presetSeedState`.
          }
        })

      // Strength and the negative prompt are seeded too, so moving one counts —
      // "which preset produced this" is a different claim at 0.8 than at 0.7.
      // Every other field is the model's rather than the preset's, and moving
      // one says nothing about provenance.
      case 'setParam':
        return editDraft(state, action.nodeId, (draft, _project, node) => ({
          ...draft,
          params: { ...draft.params, [action.key]: action.value },
          presetModified: modifiedByEdit(
            draft,
            isSeededParam(registry, node.kind, draft, action.key)
          ),
        }))

      case 'setOption':
        return editDraft(state, action.nodeId, draft => ({
          ...draft,
          options: { ...draft.options, [action.key]: action.value },
        }))

      case 'pinSeed':
        return editDraft(state, action.nodeId, draft =>
          // Every model in the fan-out, for the reason `setModels` drops a pin:
          // a pinned seed is a claim about what is being held still, and it
          // cannot be half true across a comparison.
          draft.modelIds.every(id => modelById(registry, id).supportsSeed)
            ? { ...draft, seed: { mode: 'pinned', value: action.value } }
            : draft
        )

      case 'unpinSeed':
        return editDraft(state, action.nodeId, draft => ({
          ...draft,
          seed: { mode: 'roll' },
        }))

      case 'pinNodeInput':
        return editNode(state, action.nodeId, (node, project) => ({
          ...node,
          pinnedInputId: pointableInput(project, node, action.generationId),
        }))

      case 'setBatchSize':
        return editNode(state, action.nodeId, node => ({
          ...node,
          batchSize: clampBatchSize(action.size),
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
              nodeId: action.nodeId,
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

      case 'runNode':
        return {
          ...editProject(state, project => runNode(registry, project, action)),
          // A run that mints its candidates and picks the first in one go has
          // been claimed by an arrival before anything else can happen — but not
          // *answered*: the grid still has to be shown, and the user still has
          // to pick from it.
          runs: state.runs.map(run =>
            run.id === action.runs.at(0)?.runId
              ? { ...run, claimed: true }
              : run
          ),
        }

      case 'recordGenerations':
        return withArrivals(state, action.entries, action.at)

      case 'reconcileCosts':
        return editProject(state, project =>
          withReconciledCosts(project, action.charges)
        )

      case 'recordUpload':
        return {
          ...editProject(state, project =>
            withCollectedGenerations(
              project,
              [
                {
                  id: action.generationId,
                  stage: 'source',
                  recipe: uploadRecipe(action.fileName, action.nodeId),
                  // No model, so no seed — the same honest `null` a seedless
                  // model gets, rather than a number implying a re-run.
                  seed: null,
                  asset: action.asset,
                  runId: null,
                  // Nobody was charged for a file the user already had. Zero
                  // rather than `null`: this is a known cost, and counting it
                  // among the unknowns would put a permanent asterisk on the
                  // total of every project holding an upload.
                  costUsd: 0,
                  // Nothing was submitted, so there is nothing to reconcile.
                  requestId: null,
                },
              ],
              action.at,
              // Unlike a job arriving, this happened because someone asked for
              // it just now, so it takes the pick whatever else has.
              new Set<string>([action.nodeId])
            )
          ),
          // Bringing an image in is choosing it (#27) — so it answers whatever
          // run is open on that node, the same way clicking a candidate does,
          // rather than leaving the grid sitting on top of it.
          ...decidedByUser(state, action.nodeId),
        }

      case 'selectGeneration':
        return {
          ...editProject(state, project => {
            const generation = project.generations.find(
              candidate => candidate.id === action.generationId
            )
            if (generation === undefined) return project
            return withNode(project, nodeIdOf(generation), node => ({
              ...node,
              pick: generation.id,
            }))
          }),
          ...decidedByUser(state, nodeOf(state, action.generationId)),
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

      case 'openEffects':
        return { ...state, effectsOpen: true }

      case 'closeEffects':
        return { ...state, effectsOpen: false }

      case 'pinTreatment':
        return {
          ...state,
          effectsOpen: true,
          treatmentTarget: action.generationId,
        }

      case 'unpinTreatment':
        return { ...state, treatmentTarget: null }

      case 'chooseLook':
        return editTreatment(state, action.generationId, (_, project) =>
          action.look === null
            ? null
            : treatmentFor(action.look, project.palette)
        )

      case 'setKnob':
        return editTreatment(state, action.generationId, treatment =>
          treatment === null
            ? null
            : withKnob(treatment, action.look, action.key, action.value)
        )

      // Refused where there is already one, which is the whole rule: #53
      // declares what a recipe *wants*, and what the user has since done to it
      // outranks that every time.
      case 'seedTreatment':
        return editTreatment(state, action.generationId, treatment =>
          treatment === null ? action.treatment : treatment
        )
    }
  }
}

/**
 * Rewrite one candidate's treatment, leaving every other candidate alone.
 *
 * Here rather than open-coded four times because all four transitions are the
 * same fold with a different middle, and because getting the "leave the others
 * alone" half wrong is the sort of bug that only shows up on a project with two
 * treated candidates in it.
 */
function editTreatment(
  state: EditorState,
  generationId: string,
  next: (treatment: Treatment | null, project: Project) => Treatment | null
): EditorState {
  return editProject(state, project => ({
    ...project,
    generations: project.generations.map(generation =>
      generation.id === generationId
        ? { ...generation, treatment: next(generation.treatment, project) }
        : generation
    ),
  }))
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
 *
 * A **motion** preset seeds one field and no others (#29): the whole preset is
 * a prompt, there is no idiom to fail to speak, and neither strength nor a
 * negative is anything a video model's registry row offers. That is the simpler
 * schema paying off rather than a special case — the branch below is the entire
 * difference between the two libraries at this seam.
 */
function seedFromPreset(
  registry: readonly ModelCapabilities[],
  palette: Palette,
  draft: DraftRecipe,
  presetId: string | null,
  preset: Preset | MotionPreset | null,
  values: PresetVariableValues
): DraftRecipe {
  const chosen: DraftRecipe = { ...draft, presetId, presetModified: false }
  if (preset === null) return chosen

  if (isMotionPreset(preset)) return { ...chosen, prompt: preset.prompt }

  // The **primary** model of the fan-out (ADR 0005). The picker only offers a
  // preset every selected model reads, so the idiom is settled before this runs
  // — what is left is `strengthParam` and `negativePromptParam`, which are
  // per-model field *names*, and one bag cannot hold a value under two names.
  // Seeding against the primary and letting `freezeDraft` reconcile the rest is
  // the same trade the parameter panel makes.
  const model = modelById(registry, draft.modelIds[0] ?? '')
  // Expanded here and nowhere later: what lands in the draft is the prose that
  // gets persisted, so no unresolved placeholder can be resolved against a
  // library that has since been edited (#46).
  const composed = composePreset(preset, model, palette, values)
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
 * `presetModified` after an edit — provenance about the *seeded* fields, and
 * nothing else (#28).
 *
 * Two narrowings, each one straight out of what {@link seedFromPreset} actually
 * writes:
 *
 * - **A selected preset only.** With none there is no provenance to lose, which
 *   is what `false` means where `presetId` is null (see {@link StageRecipe}).
 * - **A seeded field only** — the caller's `seeded`, since which parameter names
 *   the model seeds is the registry's answer rather than this action's.
 *
 * There used to be a third, and it took the stage as an argument for it: source
 * was exempt, because it picked from a fixture list that composed nothing and
 * seeded nothing, so a flag saying its form had drifted from a preset would have
 * described a seeding that never happened. #47 gave it a real library. What is
 * left of the stage's say lives in {@link isSeededParam}, which still has one.
 *
 * Sticky, because it is a claim about the past: once a seeded field has moved,
 * editing something else does not unmove it.
 */
function modifiedByEdit(draft: DraftRecipe, seeded: boolean): boolean {
  if (draft.presetId === null) return false
  return draft.presetModified || seeded
}

/**
 * Whether this parameter is one seeding would have written.
 *
 * Kind-aware because the libraries seed different things: a motion preset
 * writes the prompt and nothing else, so moving Veo's `negative_prompt` on an
 * animate node says nothing at all about which motion preset this started from
 * — where on the two composing kinds the same field is seeded and moving it
 * does.
 *
 * Asked of the primary model, for the reason `seedFromPreset` seeds against it:
 * that is the model whose field names the bag was filled under.
 */
function isSeededParam(
  registry: readonly ModelCapabilities[],
  kind: StageKind,
  draft: DraftRecipe,
  key: string
): boolean {
  if (kind === 'animate') return false

  const model = modelById(registry, draft.modelIds[0] ?? '')
  return key === model.strengthParam || key === model.negativePromptParam
}

/**
 * Submit the current draft.
 *
 * The draft is *copied* onto each generation with the upstream pointer
 * resolved. That copy is the whole point: the sidebar form keeps moving, and a
 * generation has to stay re-runnable regardless.
 */
function runNode(
  registry: readonly ModelCapabilities[],
  project: Project,
  action: Extract<EditorAction, { type: 'runNode' }>
): Project {
  const node = nodeById(project, action.nodeId)
  if (node === null) return project

  const draft = node.draft

  // Frozen **per candidate**, because a fan-out is several recipes rather than
  // one run of several calls: each entry names the model it went to, and its
  // parameter bag is reconciled against that model. Anything the node could not
  // freeze — no input to work from — takes the whole run with it, since the
  // refusal is about the node and not about one of its models.
  // A pinned seed makes every candidate *one model* produces identical, so it
  // collapses that model's batch to one. Four copies of the same image is not a
  // choice. It does **not** collapse the fan-out: three models on one seed are
  // three different pictures, which is the comparison a pin exists to make.
  const wanted =
    draft.seed.mode === 'pinned' ? firstPerModel(action.runs) : action.runs

  const planned = wanted.flatMap(run => {
    const recipe = freezeDraft(registry, project, node, run.modelId)
    return recipe === null ? [] : [{ run, recipe }]
  })

  if (planned.length !== wanted.length) return project

  let ordinal = nextOrdinal(project, node.id)

  const created = planned.map(({ run, recipe }): Generation => {
    const model = modelById(registry, run.modelId)
    const seed = draft.seed.mode === 'pinned' ? draft.seed.value : run.seed

    return {
      id: run.id,
      stage: node.kind,
      recipe,
      // Recorded even when rolled — a result you like is worthless if you
      // cannot pin what produced it (PRD §4.3). Null only when the model has
      // no seed at all, which is the honest way to say "not reproducible".
      seed: model.supportsSeed ? seed : null,
      verdict: 'unrated',
      createdAt: action.at,
      ordinal: ordinal++,
      asset: run.asset,
      runId: run.runId,
      // Stamped from the registry as it reads today (ADR 0003), the same way
      // a collected job's is — every path that mints a candidate has to price
      // identically, or the overview's total would depend on which one produced
      // the work.
      costUsd: stampedCost(registry, project.aspect, recipe),
      // Nothing was submitted on this path, so there is nothing to reconcile.
      requestId: null,
      actualCostUsd: null,
      // Untreated until somebody opens the effects panel on it (#36).
      treatment: null,
    }
  })

  if (created.length === 0) return project

  return {
    ...project,
    generations: [...project.generations, ...created],
    // A fresh run picks its first candidate, so the node is never blank after a
    // click. Downstream nodes keep pointing at what they already consumed —
    // nothing further along is invalidated.
    nodes: project.nodes.map(entry =>
      entry.id === node.id
        ? { ...entry, pick: created[0]?.id ?? entry.pick }
        : entry
    ),
  }
}

/** Which node a generation belongs to, or `null` if it is not there. */
function nodeOf(state: EditorState, generationId: string): string | null {
  const generation = state.project?.generations.find(
    entry => entry.id === generationId
  )
  return generation === undefined ? null : nodeIdOf(generation)
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
  nodeId: string | null
): Pick<EditorState, 'runs'> {
  if (nodeId === null) return { runs: state.runs }

  return {
    runs: state.runs.map(run =>
      run.nodeId === nodeId && run.projectId === state.project?.id
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
  const claimable = new Set<string>()
  const nodes = new Set(before.nodes.map(node => node.id))

  for (const entry of entries) {
    // Already recorded: a settled event and the sweep can deliver the same job
    // twice, and it decides nothing the second time.
    if (before.generations.some(generation => generation.id === entry.id)) {
      continue
    }

    // Its node is gone, so the fold below will drop it too — recording a run
    // for a candidate that is never going to appear would leave a grid waiting
    // forever on a node that no longer exists.
    const nodeId = entry.recipe.nodeId
    if (!nodes.has(nodeId)) continue

    const owner = runs.findIndex(run => run.generationIds.includes(entry.id))
    const run = runs.at(owner)

    if (run === undefined) {
      const strandedId = strandedRunId(before.id, nodeId)
      const stranded = runs.findIndex(record => record.id === strandedId)
      const joined = runs.at(stranded)

      // A second stray from the same node joins the first rather than claiming
      // the pick all over again.
      if (joined !== undefined) {
        runs[stranded] = {
          ...joined,
          generationIds: [...joined.generationIds, entry.id],
        }
        continue
      }

      if (claimable.has(nodeId)) continue
      claimable.add(nodeId)
      runs.push(strandedRun(strandedId, before.id, nodeId, entry.id, at))
      continue
    }

    if (run.answered || run.claimed) continue
    if (claimable.has(nodeId)) continue

    claimable.add(nodeId)
    runs[owner] = { ...run, claimed: true }
  }

  const after = withCollectedGenerations(before, entries, at, claimable)
  if (after === before) return state

  return { ...state, project: after, runs }
}

/**
 * A run nobody recorded, reconstructed from the candidate that turned up.
 *
 * Named after the node rather than minted, because the reducer mints nothing —
 * and because that is exactly the identity wanted: the *next* stray from the
 * same node joins this one instead of claiming the pick all over again.
 * Born answered: there was never a grid to answer.
 */
function strandedRunId(projectId: string, nodeId: string): string {
  return `stranded:${projectId}:${nodeId}`
}

function strandedRun(
  id: string,
  projectId: string,
  nodeId: string,
  generationId: string,
  at: number
): RunRecord {
  return {
    id,
    projectId,
    nodeId,
    startedAt: at,
    generationIds: [generationId],
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
 *
 * Not the whole story for a stage with a model behind it: the parameters a
 * *request* carries are resolved afterwards, and `sentRecipe` is what puts them
 * back on the copy that gets persisted (AC10). A fixture stage has no request,
 * so the frozen draft is all there is to record.
 *
 * The registry, because `options.loop` is an intent and the run is a fact
 * (#30): a first/last-frame endpoint loops with the switch off and a model with
 * no end-frame field does not loop with it on, so the frozen copy records
 * `loopsOnEndFrame` rather than what the draft happened to store. The *draft*
 * keeps the user's own answer untouched — that is what lets it survive a model
 * change — but a snapshot of a run that says `loop: false` beside a clip that
 * loops is not a recipe anybody could read.
 */
export function freezeDraft(
  registry: readonly ModelCapabilities[],
  project: Project,
  node: DraftNode,
  modelId: string
): StageRecipe | null {
  const inputGenerationId = resolvedInputId(project, node)

  // A node whose kind consumes a picture needs one. A source never does — which
  // is exactly why re-running a style node leaves its source alone (PRD §4.1).
  //
  // *Which* picture is settled entirely by the edge and the ladder above it, and
  // what lands in the frozen copy is the id that was actually resolved — so a
  // candidate always records the picture it was made from rather than the rule
  // that found it.
  if (needsInput(node.kind) && inputGenerationId === null) return null

  const { modelIds: _fanOut, ...shared } = node.draft
  const model = modelById(registry, modelId)

  return {
    ...shared,
    modelId,
    // Reconciled per model, which is what makes one shared bag legal across a
    // fan-out: a field this model does not declare is dropped rather than sent,
    // and one it declares but the primary did not gets our default rather than
    // the API's (PRD §6.3).
    params: reconcileParams(model, node.draft.params),
    options: {
      ...node.draft.options,
      loop: loopsOnEndFrame(model, node.draft.options),
    },
    inputGenerationId,
    nodeId: node.id,
  }
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
  claimable: ReadonlySet<string>
): Project {
  const known = new Set(project.generations.map(generation => generation.id))
  const nodes = new Set(project.nodes.map(node => node.id))

  // A candidate whose node has been deleted is dropped rather than orphaned
  // (ADR 0005). There is nowhere truthful to put the picture — a node is the
  // only place a candidate lives on the canvas — and inventing a home for it
  // would be the ghost surface this design exists to remove. The file stays in
  // the assets folder until the deliberate cleanup pass.
  const arriving = entries.filter(
    entry => !known.has(entry.id) && nodes.has(entry.recipe.nodeId)
  )

  if (arriving.length === 0) return project

  const ordinals = new Map<string, number>()
  const created = arriving.map((entry): Generation => {
    const nodeId = entry.recipe.nodeId
    const ordinal = ordinals.get(nodeId) ?? nextOrdinal(project, nodeId)
    ordinals.set(nodeId, ordinal + 1)

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
      costUsd: entry.costUsd,
      requestId: entry.requestId,
      // Nothing arrives reconciled. fal's billing events lag the queue by
      // minutes, so the charge for a call that finished a moment ago is not
      // there to be read yet — it lands on a later pass (ADR 0003).
      actualCostUsd: null,
      treatment: null,
    }
  })

  // An arrival takes its node's pick only where the caller says it may — this
  // is the image the user has been waiting for, possibly across a restart, and
  // anything downstream needs an input whether or not anyone is watching. Who
  // is allowed to claim is not decided here, because it depends on what has
  // happened in the session (see `withArrivals`) and this function also folds
  // results into projects nobody has open.
  //
  // Once per node per batch, whatever the caller allows: the candidates of one
  // run must not take it in turns, or a four-up would end on whichever job
  // happened to finish last — and with fan-out, on whichever *model* was
  // quickest, which is not a judgement anyone made.
  const claimed = new Set<string>()
  const picks = new Map<string, string>()

  for (const generation of created) {
    const nodeId = nodeIdOf(generation)
    if (!claimable.has(nodeId) || claimed.has(nodeId)) continue
    claimed.add(nodeId)
    picks.set(nodeId, generation.id)
  }

  return {
    ...project,
    nodes: project.nodes.map(node => {
      const pick = picks.get(node.id)
      return pick === undefined ? node : { ...node, pick }
    }),
    generations: [...project.generations, ...created],
  }
}

/**
 * Replace stamped estimates with what fal actually charged (#56, ADR 0003).
 *
 * Keyed by `requestId`, because that is the only join fal's billing events
 * offer and the only reason the id is persisted at collection at all.
 *
 * Exported as well as dispatched, for the reason `withCollectedGenerations` is:
 * one reconciliation pass covers the whole library, and most of the projects it
 * corrects are not the open one. Both paths have to fold identically or the
 * project you happen to be looking at would total differently from the card
 * behind it.
 *
 * Returns the project unchanged when nothing here is named, which is how the
 * caller knows not to write — a pass over a library that is already reconciled
 * must not rewrite every manifest on disk and move every card's date.
 *
 * A generation already carrying an actual is left alone. fal's answer for a
 * request does not change, and re-writing it would be a write with nothing in
 * it; a *different* answer for the same id is fal disagreeing with itself, and
 * the first reading is no worse than the second.
 */
export function withReconciledCosts(
  project: Project,
  charges: ReadonlyMap<string, number>
): Project {
  let changed = false

  const generations = project.generations.map(generation => {
    if (generation.requestId === null) return generation
    if (generation.actualCostUsd !== null) return generation

    const actual = charges.get(generation.requestId)
    // `undefined` rather than a falsy check: a genuine zero charge is a fact
    // worth recording, and it is exactly the one a `||` would drop.
    if (actual === undefined || !Number.isFinite(actual)) return generation

    changed = true
    return { ...generation, actualCostUsd: actual }
  })

  return changed ? { ...project, generations } : project
}

/**
 * Whether a pass could still tell this project anything.
 *
 * A generation is worth asking about only while it has an id to join on and no
 * answer yet. Everything else — imports, fixtures, already-reconciled work — is
 * settled, and a project of nothing but those never has its manifest opened by
 * a pass again.
 */
export function awaitingReconciliation(project: Project): boolean {
  return project.generations.some(
    generation =>
      generation.requestId !== null && generation.actualCostUsd === null
  )
}

/**
 * What `pinNodeInput` is allowed to write, which is not simply what it was
 * given.
 *
 * Held to a candidate of the node's own input node, for the same reason
 * `pinSeed` is held to models that have a seed field: the action is reachable
 * from a hand-edited manifest as well as from a click, and a pin naming a
 * candidate of some unrelated node would make `resolvedInputId` fall through in
 * silence. A refused pointer leaves the node as it was rather than clearing it,
 * so a bad write costs nothing.
 *
 * `null` is always allowed: that is the caller handing the node back to the
 * default, not naming a candidate.
 */
function pointableInput(
  project: Project,
  node: DraftNode,
  generationId: string | null
): string | null {
  if (generationId === null) return null
  if (!isEligibleInput(project, node, generationId)) return node.pinnedInputId
  return generationId
}

/**
 * Load a past generation's recipe back into the draft — the recipe premise
 * (PRD §1) made operable. The upstream selection moves too, otherwise a
 * "restore" would re-run against whatever happens to be selected now.
 */
function restoreRecipe(project: Project, generationId: string): Project {
  const generation = project.generations.find(g => g.id === generationId)
  if (generation === undefined) return project

  const { recipe } = generation

  // An upload names no model (#27), so there is nothing to load into a form
  // that would produce it again — loading it anyway would leave the draft
  // pointing at a registry entry that does not exist. Refused here rather than
  // hidden in the UI, because the reducer is what the manifest can reach.
  if (isUploadRecipe(recipe)) return project

  const { modelId, inputGenerationId, nodeId: _from, ...shared } = recipe

  // Restored onto **its own node**, which is the only node whose form it
  // describes. A recipe carries the node it was frozen from, so this needs no
  // second opinion about where it belongs.
  return withNode(project, nodeIdOf(generation), node => ({
    ...node,
    // The fan-out collapses to the one model that actually made this picture.
    // Restoring three models from a candidate that came from one of them would
    // be a form that describes something nobody ran.
    draft: { ...shared, modelIds: [modelId] },
    // And the pin follows the recipe, so the re-run consumes the picture this
    // candidate consumed rather than whatever the input node has settled on
    // since. Only where that candidate is still an eligible input — a recipe
    // whose node has been rewired names something from another branch, and
    // `pointableInput` is where that refusal already lives.
    pinnedInputId: pointableInput(project, node, inputGenerationId),
  }))
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
  nodeId: string,
  // The project comes along because one edit needs something the draft does not
  // carry — seeding a preset resolves its variables against the project palette
  // — and the node because another needs its kind (`isSeededParam`).
  change: (draft: DraftRecipe, project: Project, node: DraftNode) => DraftRecipe
): EditorState {
  return editNode(state, nodeId, (node, project) => ({
    ...node,
    draft: change(node.draft, project, node),
  }))
}

/**
 * Rewrite one node, leaving every other node alone.
 *
 * The address every draft-editing action now goes through, and the reason none
 * of them has to know that `Project.nodes` is an array: a node that is not there
 * — deleted while a panel was still mounted, or named by a hand-edited manifest
 * — leaves the project untouched rather than appending a node out of nowhere.
 */
function editNode(
  state: EditorState,
  nodeId: string,
  change: (node: DraftNode, project: Project) => DraftNode
): EditorState {
  return editProject(state, project => withNode(project, nodeId, change))
}

function withNode(
  project: Project,
  nodeId: string,
  change: (node: DraftNode, project: Project) => DraftNode
): Project {
  if (!project.nodes.some(node => node.id === nodeId)) return project

  return {
    ...project,
    nodes: project.nodes.map(node =>
      node.id === nodeId ? change(node, project) : node
    ),
  }
}

/**
 * A node removed, and everything that only made sense because of it.
 *
 * Four things go at once, and each for its own reason (ADR 0005):
 *
 * - **Its candidates**, because a node is the only place one can live on the
 *   canvas. The asset files stay on disk for the deliberate cleanup pass, so
 *   this is reversible right up until the user asks for it not to be.
 * - **Downstream edges**, detached rather than followed: losing one step of a
 *   chain must not cost the rest of the chain.
 * - **Any pin naming one of its candidates**, on any node, since the picture is
 *   about to stop existing.
 * - **Its runs**, or a grid would sit forever waiting on a node that is gone.
 */
function withoutNode(state: EditorState, nodeId: string): EditorState {
  const doomed = new Set(
    state.project?.generations
      .filter(generation => nodeIdOf(generation) === nodeId)
      .map(generation => generation.id) ?? []
  )

  return {
    ...editProject(state, project => ({
      ...project,
      nodes: project.nodes
        .filter(node => node.id !== nodeId)
        .map(node => ({
          ...node,
          inputNodeId: node.inputNodeId === nodeId ? null : node.inputNodeId,
          pinnedInputId:
            node.pinnedInputId !== null && doomed.has(node.pinnedInputId)
              ? null
              : node.pinnedInputId,
        })),
      generations: project.generations.filter(
        generation => !doomed.has(generation.id)
      ),
    })),
    runs: state.runs.filter(run => run.nodeId !== nodeId),
    // The sidebar was editing it, and the effects panel may have been pinned to
    // one of its candidates. Both would otherwise be a form about nothing.
    selectedNodeId:
      state.selectedNodeId === nodeId ? null : state.selectedNodeId,
    treatmentTarget:
      state.treatmentTarget !== null && doomed.has(state.treatmentTarget)
        ? null
        : state.treatmentTarget,
  }
}

/** Whether two model lists say the same thing, in the same order. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  )
}

/**
 * One planned candidate per model, keeping the first of each.
 *
 * What a pinned seed collapses a run to — see `runNode`.
 */
function firstPerModel(runs: readonly PlannedRun[]): readonly PlannedRun[] {
  const seen = new Set<string>()
  return runs.filter(run => {
    if (seen.has(run.modelId)) return false
    seen.add(run.modelId)
    return true
  })
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
 * The node opening a project should drop you on: the one that produced the most
 * recent candidate, or the first node when nothing has been run.
 *
 * "As far as this project has got", not "where you were last time" — which node
 * you had selected is session state and deliberately not in the manifest. On a
 * canvas there is no stage order to walk backwards through, so the answer comes
 * from the append-only history instead, which is the same question asked of the
 * one structure that still has an order.
 */
function furthestNodeId(project: Project): string | null {
  const known = new Set(project.nodes.map(node => node.id))

  for (const generation of [...project.generations].reverse()) {
    const nodeId = nodeIdOf(generation)
    if (known.has(nodeId)) return nodeId
  }

  return project.nodes.at(0)?.id ?? null
}

/**
 * Ordinals count every generation ever made on the node, including rejected
 * ones — nothing is deleted from a node that survives, so nothing is reused.
 */
function nextOrdinal(project: Project, nodeId: string): number {
  return project.generations.filter(g => nodeIdOf(g) === nodeId).length + 1
}
