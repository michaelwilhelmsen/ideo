/**
 * Derived reads over the recipe model. Pure, and deliberately kept out of the
 * reducer — none of this is state, all of it is a question you can ask of the
 * state, and storing the answers is how two copies drift apart.
 *
 * Addressed by **node** since ADR 0005. Every function that used to take a
 * `StageKind` now takes a `DraftNode`, because a canvas can hold two style
 * nodes and "the style stage's candidates" stopped being a question with one
 * answer.
 */

import { aspectById } from './aspects'
import { nodeById } from './graph'
import type {
  DraftNode,
  EditorState,
  Generation,
  Project,
  RunRecord,
  StageKind,
  StageRecipe,
} from './types'
import { needsInput } from './types'

/**
 * The open project, or `null`. Nullable on purpose: an empty library is a
 * normal state now that projects come off disk, and a component that renders
 * an editor for a project that is not there is the bug this shape prevents.
 */
export function activeProject(state: EditorState): Project | null {
  return state.project
}

/**
 * Which node made this candidate.
 *
 * Read off the frozen recipe rather than a field of its own, because that is
 * the copy that survives the round trip through the job store — see
 * {@link StageRecipe.nodeId}.
 */
export function nodeIdOf(generation: Generation): string {
  return generation.recipe.nodeId
}

export function generationsForNode(
  project: Project,
  nodeId: string
): readonly Generation[] {
  return project.generations.filter(g => nodeIdOf(g) === nodeId)
}

/**
 * PRD §10.3 — rejected candidates are filtered, never removed, and one toggle
 * brings them back. The node's own pick is always visible even when rejected,
 * because hiding what the rest of the graph is consuming is worse than showing
 * a reject.
 */
export function visibleGenerations(
  project: Project,
  node: DraftNode,
  showRejected: boolean
): readonly Generation[] {
  const all = generationsForNode(project, node.id)
  if (showRejected) return all
  return all.filter(g => g.verdict !== 'rejected' || g.id === node.pick)
}

export function rejectedCount(project: Project, nodeId: string): number {
  return generationsForNode(project, nodeId).filter(
    g => g.verdict === 'rejected'
  ).length
}

/** The candidate this node has settled on, or `null` while undecided. */
export function pickedGeneration(
  project: Project,
  node: DraftNode
): Generation | null {
  return generationById(project, node.pick)
}

/**
 * Nullable in both arguments, for the reason `nodeById` is: a component asks for
 * a candidate before it has ruled out "no project open", and there is no
 * candidate either way.
 */
export function generationById(
  project: Project | null,
  id: string | null
): Generation | null {
  if (project === null || id === null) return null
  return project.generations.find(g => g.id === id) ?? null
}

/**
 * The candidates this node could run from — its input node's, and only its
 * input node's.
 *
 * Narrower than the selector it replaces, and deliberately so. The old
 * `eligibleInputs` offered every candidate of every earlier *stage*, because
 * with three fixed stages that was the only way to express "animate this source
 * without a style pass". On a canvas that sentence is an edge you draw, so the
 * picker's job shrinks back to the honest one: which picture, out of the ones
 * the node you are actually wired to has made.
 *
 * Rejected candidates are out, except the one currently in use — the same rule
 * the candidate strip follows (PRD §10.3): saying no to a picture should take it
 * out of the pickers, and hiding what a node is *already* consuming is worse
 * than showing a reject.
 *
 * Nothing here asks whether a candidate has a file. `asset` is legitimately
 * `null` on a generation with no model call behind it, and the run itself
 * refuses a nameless input on both sides of the boundary (`imageInputsFor`, and
 * Rust after it) — so filtering here would be a third opinion on a question
 * already answered where the money is spent.
 *
 * Ordered with {@link resolvedInputId} first, then creation order. The head of
 * the list is the card the input row preselects, and it only moves when the
 * user moves it.
 */
export function eligibleInputs(
  project: Project,
  node: DraftNode
): readonly Generation[] {
  if (node.inputNodeId === null) return []

  const current = resolvedInputId(project, node)
  const usable = generationsForNode(project, node.inputNodeId).filter(
    generation => generation.verdict !== 'rejected' || generation.id === current
  )

  return [...usable].sort(
    (left, right) => Number(right.id === current) - Number(left.id === current)
  )
}

/**
 * Which candidate this node would actually run from, right now.
 *
 * Three answers in falling order of how deliberate they are, and the order is
 * the whole design:
 *
 * 1. **The pin.** `DraftNode.pinnedInputId` is a click on a specific card in the
 *    input row, persisted in `project.json` with everything else.
 * 2. **The input node's own pick**, which is what most projects will ever use:
 *    choose a candidate upstream, and everything wired to it follows.
 * 3. **The newest approved candidate, else the newest unrejected one.** With
 *    nothing picked, a verdict is the only statement anyone has made about
 *    these pictures, and "approved" is the one that means keep.
 *
 * There is no fourth rung, and its absence is the feature. The old ladder ended
 * by walking further upstream when the previous stage was empty — an inference
 * made on your behalf, at video prices, about which picture you meant. Now the
 * edge says which node, and this only has to say which of its candidates.
 *
 * Each answer has to name a candidate the input node still holds, so a stale
 * pointer — one deleted since, or one left behind by a hand-edited manifest —
 * falls through to the next answer rather than blocking the node.
 */
export function resolvedInputId(
  project: Project,
  node: DraftNode
): string | null {
  if (node.inputNodeId === null) return null

  if (isEligibleInput(project, node, node.pinnedInputId)) {
    return node.pinnedInputId
  }

  const input = nodeById(project, node.inputNodeId)
  if (input === null) return null

  if (isEligibleInput(project, node, input.pick)) return input.pick

  const candidates = generationsForNode(project, input.id).filter(
    generation => generation.verdict !== 'rejected'
  )
  const approved = candidates.filter(
    generation => generation.verdict === 'approved'
  )

  return approved.at(-1)?.id ?? candidates.at(-1)?.id ?? null
}

/**
 * Whether this candidate is one `node` could run from at all.
 *
 * The single home of that rule, because it is asked on both sides of the
 * reducer boundary: {@link resolvedInputId} uses it to decide whether a stored
 * pointer still stands, and `pointableInput` uses it to decide whether an
 * incoming one may be written. Two copies had already begun to drift.
 *
 * Membership of the node's **input node** is the whole test. Cycles are
 * unrepresentable a level up — `canConnect` refuses the edge — so this does not
 * have to re-litigate them, and a verdict is deliberately not part of it:
 * rejecting a candidate should take it out of the pickers
 * ({@link eligibleInputs}), but a node already consuming one must keep working
 * from it rather than silently repointing at something else.
 */
export function isEligibleInput(
  project: Project,
  node: DraftNode,
  id: string | null
): id is string {
  if (node.inputNodeId === null) return false
  const generation = generationById(project, id)
  if (generation === null) return false
  return nodeIdOf(generation) === node.inputNodeId
}

/**
 * Whether this generation was made from something other than what its node's
 * input is now.
 *
 * Independent re-runs (PRD §4.1) mean an old candidate stays valid after its
 * input is re-rolled — but "valid" and "comparable" are different things, and
 * without saying so a node's candidates become a set of pictures with no shared
 * basis.
 */
export function isFromAnotherInput(
  project: Project,
  generation: Generation
): boolean {
  const node = nodeById(project, nodeIdOf(generation))
  if (node === null || node.inputNodeId === null) return false
  return generation.recipe.inputGenerationId !== resolvedInputId(project, node)
}

/**
 * Whether the node could run right now, and if not, why.
 *
 * Not a question about the *model*. #29 blocked whole animate runs on the two
 * endpoints whose end frame is mandatory, because there was no second frame to
 * send; #30 sends the start still again, so those rows run like any other and
 * the fact that they always loop is said on the loop switch
 * (`controlAvailability`) rather than on the run button. What is left here is
 * the project's own arithmetic — the locked ratio and the input edge — neither
 * of which needs the registry.
 *
 * The input half is two distinct refusals since ADR 0005, because they have two
 * different fixes: a node wired to nothing needs an **edge**, and a node wired
 * to an empty node needs that node **run**. Collapsing them into one sentence
 * would send half the users to the wrong control.
 */
export function blockedReasonKey(
  project: Project,
  node: DraftNode
): string | null {
  // PRD §4.4 — the ratio was marked at creation for whether animation is
  // possible, and this is where that mark has to do something. Saying it here
  // costs a disabled button; saying it at submit costs the video call.
  if (node.kind === 'animate' && !aspectById(project.aspect).animatable) {
    return 'editor.reason.aspectNotAnimatable'
  }

  if (!needsInput(node.kind)) return null
  if (node.inputNodeId === null) return 'editor.reason.noInputNode'
  if (resolvedInputId(project, node) === null) return 'editor.reason.needsInput'
  return null
}

/**
 * PRD §4.2 — four images beats serial re-rolling and image calls are cheap;
 * one video, because a four-up of a clip that costs real money per second
 * would genuinely hurt. Copied onto a node at creation (PRD §11).
 */
export const DEFAULT_BATCH_SIZES: Readonly<Record<StageKind, number>> = {
  source: 4,
  style: 4,
  animate: 1,
}

/**
 * The range the stepper offers, and the range anything read off disk is held
 * to. The ceiling is a spending limit before it is a layout constraint: a
 * hand-edited manifest saying `40` would otherwise be forty paid calls one
 * click away — and with fan-out, forty *per model*.
 */
export const MIN_BATCH_SIZE = 1
export const MAX_BATCH_SIZE = 4

export function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.round(value)))
}

/**
 * How many candidates *per model* a run of this node would produce.
 *
 * The node's setting, except that a pinned seed collapses it to one: every
 * candidate a single model makes from a pinned seed is the same picture, and
 * four copies of one picture is not a choice.
 *
 * It does **not** collapse the fan-out. Three models on one pinned seed are
 * three different pictures — that is the comparison a pin exists to make, held
 * still on everything except which model drew it.
 */
export function batchSizeFor(node: DraftNode): number {
  if (node.draft.seed.mode === 'pinned') return 1
  return clampBatchSize(node.batchSize)
}

/**
 * How many jobs one click on this node submits — the number the run button says
 * out loud, because it is also the number of times the account gets charged.
 */
export function runSizeFor(node: DraftNode): number {
  return node.draft.modelIds.length * batchSizeFor(node)
}

/**
 * A node's candidates, split into the runs that produced them (#26).
 *
 * Consecutive rather than gathered: generations are appended in the order they
 * arrived, so a run is already contiguous, and grouping by value would reorder
 * history to make the grouping look tidier than it was.
 *
 * `number` is counted over every candidate on the node, rejected ones
 * included — so "Run 2" keeps meaning the same click after a reject is hidden,
 * for the same reason ordinals are never renumbered.
 */
export interface RunGroup {
  readonly runId: string | null
  /** 1-based, and `null` for candidates that belong to no recorded run. */
  readonly number: number | null
  readonly generations: readonly Generation[]
}

export function runGroups(
  project: Project,
  node: DraftNode,
  showRejected: boolean
): readonly RunGroup[] {
  const numbers = new Map<string, number>()
  for (const generation of generationsForNode(project, node.id)) {
    if (generation.runId === null || numbers.has(generation.runId)) continue
    numbers.set(generation.runId, numbers.size + 1)
  }

  const groups: RunGroup[] = []
  for (const generation of visibleGenerations(project, node, showRejected)) {
    const last = groups.at(-1)

    if (last !== undefined && last.runId === generation.runId) {
      groups[groups.length - 1] = {
        ...last,
        generations: [...last.generations, generation],
      }
      continue
    }

    groups.push({
      runId: generation.runId,
      number:
        generation.runId === null
          ? null
          : (numbers.get(generation.runId) ?? null),
      generations: [generation],
    })
  }

  return groups
}

/**
 * The run a node is currently offering a choice from, or `null`.
 *
 * The newest one that has not been answered — answering is a click on a
 * candidate, or a dismissal, which is the whole point of the grid. Deliberately
 * not "the run with jobs still running": `active_jobs` reports only what is
 * running, so a run would vanish the moment its last job completed and the user
 * would never see the finished four-up they were waiting for.
 */
export function activeRunFor(
  state: EditorState,
  projectId: string,
  nodeId: string
): RunRecord | null {
  const runs = state.runs.filter(
    run =>
      run.projectId === projectId &&
      run.nodeId === nodeId &&
      !run.answered &&
      expectedOf(run).length > 0
  )

  return runs.at(-1) ?? null
}

/** The run that produced a generation, as far as this session knows. */
export function runIdForGeneration(
  state: EditorState,
  generationId: string
): string | null {
  const run = state.runs.find(record =>
    record.generationIds.includes(generationId)
  )
  return run?.id ?? null
}

/** The candidates a run is still expecting — everything it has not given up on. */
export function expectedOf(run: RunRecord): readonly string[] {
  return run.generationIds.filter(id => !run.abandonedIds.includes(id))
}

/** What a run has produced so far, and how much of it is still coming. */
export interface RunProgress {
  readonly arrived: readonly Generation[]
  /** How many candidates are still expected but not here yet. */
  readonly waiting: number
  readonly total: number
}

export function runProgress(project: Project, run: RunRecord): RunProgress {
  const expected = expectedOf(run)
  const arrived = project.generations.filter(generation =>
    expected.includes(generation.id)
  )

  return {
    arrived,
    waiting: expected.length - arrived.length,
    total: expected.length,
  }
}

/**
 * The nodes whose pick an arrival may take when nobody is watching.
 *
 * Used for a project that is not open (#24): there is no grid to choose from
 * and no session state to consult, so an arrival fills an undecided node —
 * anything downstream needs an input — and otherwise leaves the last pick
 * alone.
 */
export function nodesWithoutPick(project: Project): ReadonlySet<string> {
  return new Set(
    project.nodes.filter(node => node.pick === null).map(node => node.id)
  )
}

/**
 * The two generations a "one fragment changed" comparison is between: the given
 * one, and the most recent earlier one **on the same node** that shares its
 * seed.
 *
 * This is the pinned-seed claim (PRD §4.3) made checkable — if the seed really
 * isolates the change, these two differ in exactly the fragment that was
 * edited. Same node rather than same kind, because two style nodes are two
 * different prompts and a coincidence of seeds between them proves nothing.
 */
export function seedSibling(
  project: Project,
  generation: Generation
): Generation | null {
  if (generation.seed === null) return null

  const siblings = generationsForNode(project, nodeIdOf(generation)).filter(
    g => g.id !== generation.id && g.seed === generation.seed
  )

  return siblings.at(-1) ?? null
}

/**
 * Which fragments two recipes disagree about.
 *
 * With the seed pinned this should come back with exactly one entry — that is
 * the check PRD §4.3 is asking for, and it is cheap enough to put on screen
 * rather than leave to the eye. Across a fan-out the one entry is `model`,
 * which is the comparison the fan-out exists to make.
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
