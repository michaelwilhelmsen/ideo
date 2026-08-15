/**
 * Derived reads over the recipe model. Pure, and deliberately kept out of the
 * reducer — none of this is state, all of it is a question you can ask of the
 * state, and storing the answers is how two copies drift apart.
 */

import { aspectById } from './aspects'
import type {
  EditorState,
  Generation,
  Project,
  RunRecord,
  StageKind,
  StageRecipe,
} from './types'
import { STAGE_ORDER } from './types'

/** The stage whose output this stage consumes. `null` for source. */
export function upstreamOf(stage: StageKind): StageKind | null {
  const index = STAGE_ORDER.indexOf(stage)
  return index <= 0 ? null : (STAGE_ORDER[index - 1] ?? null)
}

/**
 * The open project, or `null`. Nullable on purpose: an empty library is a
 * normal state now that projects come off disk, and a component that renders
 * an editor for a project that is not there is the bug this shape prevents.
 */
export function activeProject(state: EditorState): Project | null {
  return state.project
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

/** Every stage whose output this one may consume, nearest first. */
export function upstreamStages(stage: StageKind): readonly StageKind[] {
  const index = STAGE_ORDER.indexOf(stage)
  return index <= 0 ? [] : STAGE_ORDER.slice(0, index).reverse()
}

/**
 * The candidates this stage could run from — *any* earlier stage's, not only
 * the one immediately before it.
 *
 * This is what makes a stage skippable (#33 follow-up). A source that is
 * already right should be animatable without paying for a pass-through style
 * pass, and nothing downstream ever cared which stage produced its input:
 * `imageInputsFor` names a file and Rust reads it, so an animate model handed a
 * source cannot tell the difference.
 *
 * Rejected candidates are out, except the one currently in use — the same rule
 * the candidate strip follows (PRD §10.3): saying no to a picture should take it
 * out of the pickers, and hiding what a stage is *already* consuming is worse
 * than showing a reject.
 *
 * Nothing here asks whether a candidate has a file. `asset` is legitimately
 * `null` on a generation with no model call behind it, and the run itself
 * refuses a nameless input on both sides of the boundary (`imageInputsFor`, and
 * Rust after it) — so filtering here would be a third opinion on a question
 * already answered where the money is spent.
 *
 * Ordered with {@link resolvedInputId} first, then nearest upstream stage, then
 * creation order. The head of the list is the card the input row preselects,
 * and it only moves when the user moves it.
 */
export function eligibleInputs(
  project: Project,
  stage: StageKind
): readonly Generation[] {
  const current = resolvedInputId(project, stage)

  const usable = upstreamStages(stage).flatMap(upstream =>
    generationsForStage(project, upstream).filter(
      generation =>
        generation.verdict !== 'rejected' || generation.id === current
    )
  )

  return [...usable].sort(
    (left, right) => Number(right.id === current) - Number(left.id === current)
  )
}

/**
 * Which candidate this stage would actually run from, right now.
 *
 * Three answers in falling order of how deliberate they are, and the order is
 * the whole design:
 *
 * 1. **What the draft names.** `StageRecipe.inputGenerationId` has always been
 *    on the draft — `freezeRecipe` simply overwrote it — so picking a card in
 *    the input row is a normal draft edit, persisted in `project.json` with
 *    everything else and restored by `restoreRecipe` for free.
 * 2. **The upstream selection**, which is what this used to be unconditionally.
 *    Nothing changes for anyone who never touches the input row.
 * 3. **The nearest eligible candidate**, which is what makes skipping cost
 *    nothing: on a project with three sources and no style at all, animate is
 *    runnable on arrival rather than after a trip to a picker.
 *
 * Each answer has to name a candidate of an earlier stage that the project
 * still holds, so a stale pointer — one deleted since, or one left behind by a
 * hand-edited manifest — falls through to the next answer rather than blocking
 * the stage.
 */
export function resolvedInputId(
  project: Project,
  stage: StageKind
): string | null {
  if (upstreamOf(stage) === null) return null

  const named = project.drafts[stage].inputGenerationId
  if (isEligibleInput(project, stage, named)) return named

  const upstream = upstreamOf(stage)
  const selected = upstream === null ? null : project.selection[upstream]
  if (isEligibleInput(project, stage, selected)) return selected

  // The fallback that makes skipping cost nothing: with no style candidates at
  // all, animate runs off a source rather than demanding a pass first.
  //
  // Stage by stage, nearest first, and the first stage with anything in it wins
  // outright. Flattening every upstream stage into one list and taking the last
  // entry would rank by *arrival* instead — and since `upstreamStages` runs
  // nearest-first, the last entry is the newest candidate of the **furthest**
  // stage. That reads harmlessly and is not: a project whose style selection was
  // cleared would quietly animate a raw source, skipping the style pass it had
  // already paid for, at video prices.
  for (const earlier of upstreamStages(stage)) {
    const fallback = bestOf(project, stage, earlier)
    if (fallback !== null) return fallback
  }

  return null
}

/**
 * The candidate a skipped-over stage offers up, in falling order of how
 * deliberate it is.
 *
 * The same shape as {@link resolvedInputId}'s own ladder, one stage down, and
 * it exists because answer 2 up there only ever asks the stage *immediately*
 * upstream. When style is empty, animate skips past it — and used to arrive at
 * the newest source, discarding the source the user had chosen and was looking
 * at one tab over. Twelve sources deep with the ninth selected, animate offered
 * to spend video money on the twelfth.
 *
 * 1. **What this stage is working from.** `selection` means exactly that
 *    everywhere else in the app: it is the candidate the stage's own tab
 *    previews, and it moved there because somebody clicked it or because the
 *    first arrival of an undecided run claimed it.
 * 2. **The newest approved one.** With nothing selected, a verdict is the only
 *    statement anyone has made about these pictures, and "approved" is the one
 *    that means keep.
 * 3. **The newest of the rest**, which is where this started.
 *
 * A selection that lost its eligibility — rejected since, or deleted by a hand
 * edit — falls through rather than blocking the ladder, the same way a stale
 * pointer does above.
 */
function bestOf(
  project: Project,
  stage: StageKind,
  earlier: StageKind
): string | null {
  const selected = project.selection[earlier]
  if (isEligibleInput(project, stage, selected)) return selected

  const candidates = generationsForStage(project, earlier).filter(
    generation => generation.verdict !== 'rejected'
  )

  const approved = candidates.filter(
    generation => generation.verdict === 'approved'
  )

  return approved.at(-1)?.id ?? candidates.at(-1)?.id ?? null
}

/**
 * Whether this candidate is one `stage` could run from at all.
 *
 * The single home of that rule, because it is asked on both sides of the
 * reducer boundary: {@link resolvedInputId} uses it to decide whether a stored
 * pointer still stands, and `pointableInput` uses it to decide whether an
 * incoming one may be written. Two copies had already begun to drift.
 *
 * Membership of an *earlier* stage is the whole test — that is what makes a
 * cycle unrepresentable. A verdict is deliberately not part of it: rejecting a
 * candidate should take it out of the pickers (`eligibleInputs`), but a stage
 * already consuming one must keep working from it rather than silently
 * repointing at something else.
 */
export function isEligibleInput(
  project: Project,
  stage: StageKind,
  id: string | null
): id is string {
  const generation = generationById(project, id)
  if (generation === null) return false
  return upstreamStages(stage).includes(generation.stage)
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
  if (upstreamOf(generation.stage) === null) return false
  return (
    generation.recipe.inputGenerationId !==
    resolvedInputId(project, generation.stage)
  )
}

/**
 * Whether the stage could run right now, and if not, why.
 *
 * Not a question about the *model* any more. #29 blocked whole animate runs on
 * the two endpoints whose end frame is mandatory, because there was no second
 * frame to send; #30 sends the start still again, so those rows run like any
 * other and the fact that they always loop is said on the loop switch
 * (`controlAvailability`) rather than on the run button. What is left here is
 * the project's own arithmetic — the locked ratio and the input pointer —
 * neither of which needs the registry.
 *
 * The input half is now "is there *an* image to work from", not "has the
 * previous stage been run". Animate no longer demands a styled still, because
 * it no longer consumes one by definition — which is why the refusal names a
 * picture rather than a stage.
 */
export function blockedReasonKey(
  project: Project,
  stage: StageKind
): string | null {
  // PRD §4.4 — the ratio was marked at creation for whether animation is
  // possible, and this is where that mark has to do something. Saying it here
  // costs a disabled button; saying it at submit costs the video call.
  if (stage === 'animate' && !aspectById(project.aspect).animatable) {
    return 'editor.reason.aspectNotAnimatable'
  }

  if (upstreamOf(stage) === null) return null
  if (resolvedInputId(project, stage) === null) {
    return 'editor.reason.needsInput'
  }
  return null
}

/**
 * PRD §4.2 — four images beats serial re-rolling and image calls are cheap;
 * one video, because a four-up of a clip that costs real money per second
 * would genuinely hurt. Copied into a project at creation (PRD §11).
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
 * click away.
 */
export const MIN_BATCH_SIZE = 1
export const MAX_BATCH_SIZE = 4

export function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.round(value)))
}

/**
 * What the project is set to produce for this stage — the setting itself,
 * which is what the stepper shows.
 */
export function configuredBatchSize(
  project: Project,
  stage: StageKind
): number {
  return clampBatchSize(project.batchSizes[stage])
}

/**
 * How many candidates a run of this stage would actually produce right now.
 *
 * The project's setting, except that a pinned seed collapses it to one: every
 * candidate in a pinned batch is the same picture, and four copies of one
 * picture is not a choice. That collapse is why this is not simply the field —
 * the button says what the click will cost, and the estimate above it agrees
 * (PRD §10.2).
 */
export function batchSizeFor(project: Project, stage: StageKind): number {
  if (project.drafts[stage].seed.mode === 'pinned') return 1
  return configuredBatchSize(project, stage)
}

/**
 * A stage's candidates, split into the runs that produced them (#26).
 *
 * Consecutive rather than gathered: generations are appended in the order they
 * arrived, so a run is already contiguous, and grouping by value would reorder
 * history to make the grouping look tidier than it was.
 *
 * `number` is counted over every candidate in the stage, rejected ones
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
  stage: StageKind,
  showRejected: boolean
): readonly RunGroup[] {
  const numbers = new Map<string, number>()
  for (const generation of generationsForStage(project, stage)) {
    if (generation.runId === null || numbers.has(generation.runId)) continue
    numbers.set(generation.runId, numbers.size + 1)
  }

  const groups: RunGroup[] = []
  for (const generation of visibleGenerations(project, stage, showRejected)) {
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
 * The run a stage is currently offering a choice from, or `null`.
 *
 * The newest one that has not been answered — answering is a click on a
 * candidate, or a dismissal, which is the whole point of the grid. Deliberately not "the run
 * with jobs still running": `active_jobs` reports only what is running, so a
 * run would vanish the moment its last job completed and the user would never
 * see the finished four-up they were waiting for.
 */
export function activeRunFor(
  state: EditorState,
  projectId: string,
  stage: StageKind
): RunRecord | null {
  const runs = state.runs.filter(
    run =>
      run.projectId === projectId &&
      run.stage === stage &&
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
 * The stages whose selection an arrival may take when nothing is watching.
 *
 * Used for a project that is not open (#24): there is no grid to choose from
 * and no session state to consult, so an arrival fills an empty selection —
 * the next stage needs an input — and otherwise leaves the last one alone.
 */
export function stagesWithoutSelection(
  project: Project
): ReadonlySet<StageKind> {
  return new Set(STAGE_ORDER.filter(stage => project.selection[stage] === null))
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
