/**
 * The recipe model — the shape a project has to hold.
 *
 * Prototype for #33. The premise under test (PRD §1) is that the expensive
 * artefact is the *recipe* — prompt + preset + model + params + seed — and not
 * the pixels. Everything here follows from that: a recipe is copied onto every
 * generation rather than referenced, because a recipe that mutates when you
 * edit the form is not re-runnable.
 *
 * #23 persists this as `project.json`, so the shape wants settling here.
 */

import type { Palette } from './palette'
import type { PresetVariableValues } from './presets'

/**
 * What kind of step a node is (ADR 0005).
 *
 * Two jobs left, and no third. It picks the model pool (`modelsForStage`), and
 * it says whether the node consumes a picture — `source` does not, the other
 * two do. It no longer *orders* anything: the pipeline is whatever edges the
 * canvas holds, and a style node feeding another style node is a restyle of a
 * restyle rather than a rule violation.
 */
export type StageKind = 'source' | 'style' | 'animate'

/** The order the "add node" menu offers kinds in, and nothing else now. */
export const STAGE_ORDER = ['source', 'style', 'animate'] as const

/** Whether a node of this kind consumes an upstream picture. */
export function needsInput(kind: StageKind): boolean {
  return kind !== 'source'
}

/**
 * PRD §4.4 — locked at project creation, inherited by every stage, and each
 * entry carries whether animation is possible at that ratio.
 */
export type AspectId = '16:9' | '21:9' | '2:1' | '3:2' | '1:1' | '3:4' | '9:16'

/**
 * PRD §10.3 — nothing is deleted, so a candidate needs somewhere to record
 * that it lost. `rejected` is a filter, never a tombstone.
 */
export type Verdict = 'unrated' | 'approved' | 'rejected'

/**
 * PRD §4.3 — a seed is either rolled fresh or pinned to a known value. Pinning
 * is what makes "I changed one fragment" legible instead of a re-roll.
 */
export type SeedSetting =
  | { readonly mode: 'roll' }
  | { readonly mode: 'pinned'; readonly value: number }

/** An explicit output size, in pixels — the one non-scalar a request carries. */
export interface PixelSize {
  readonly width: number
  readonly height: number
}

/**
 * Model parameters, kept as a bag rather than named fields.
 *
 * Named fields would mean the type knows about `strength`, `duration` and
 * `resolution` — but PRD §5 is explicit that those are per-model and named
 * differently across models. The registry says which keys are legal; the
 * recipe just carries whatever was sent.
 *
 * {@link PixelSize} is in the union because it is a value that goes on the wire:
 * the largest group of image models is told its geometry as an explicit
 * `{width, height}`, and a recipe that could not hold one could not record what
 * was actually sent (AC10). Every other field is a scalar.
 */
export type ParamValue = string | number | boolean | PixelSize
export type StageParams = Readonly<Record<string, ParamValue>>

/**
 * One knob of an effect, as a generation records it (#36).
 *
 * Scalars only, and no `PixelSize`: an effect's geometry is a cell size or an
 * angle, never an output dimension — the treatment is applied *to* whatever the
 * model returned and never decides how big it is.
 */
export type TreatmentValue = string | number | boolean

/**
 * The effect applied to a generation, and everything needed to reproduce it.
 *
 * Here rather than in `lib/effects` because this file is what a project *is*,
 * and a treatment is now part of that — the same reason `Palette` is reachable
 * from `Project`. What a look is, which knobs it has and how a value is held to
 * one all live in `lib/effects`, which is where the shaders are.
 *
 * Deliberately outside {@link StageRecipe}: a recipe is the frozen record of
 * what was sent to a model, and an effect was never sent to anything. It is
 * chosen while looking at the result, which is why #36 is a tab and not a fourth
 * stage.
 */
export interface Treatment {
  /** Which look, by id — from the built-ins or from the user's own folder. */
  readonly lookId: string
  /**
   * Every knob's **resolved** value.
   *
   * Resolved, never a reference: a colour knob that started as the palette role
   * `ink` is stored as the hex it resolved to, so editing the project's palette
   * cannot reach back into an image somebody already approved. Same argument
   * #46 settled for `{{primary}}`.
   */
  readonly values: Readonly<Record<string, TreatmentValue>>
  /**
   * Whether any knob was turned after the look was chosen.
   *
   * Provenance rather than a diff, exactly like {@link StageRecipe.presetModified}
   * — one flag is enough to say "this is Halftone, nudged", and cheaper than
   * storing what the look said at the time, which is a second copy of a library
   * the user can edit.
   */
  readonly lookModified: boolean
}

/**
 * Everything needed to re-run one step. This is the artefact PRD §1 calls
 * expensive — the thing worth persisting, restoring, and paying attention to.
 *
 * The **frozen** half of the pair since ADR 0005: a `StageRecipe` is only ever
 * found on a {@link Generation}, and it is exactly {@link DraftRecipe} plus the
 * three resolutions made at the moment of the run — which model of the fan-out
 * (`modelId`), which candidate it consumed (`inputGenerationId`), and which
 * draft it was frozen from (`nodeId`).
 */
export interface StageRecipe {
  /**
   * The one model this call went to.
   *
   * Singular where the draft holds a list: a run of a three-model node produces
   * three generations, and each records the model that actually made it. A
   * frozen recipe naming three models would be a recipe for nothing.
   */
  readonly modelId: string
  /** Subject prose (source), style fragment (style), motion fragment (animate). */
  readonly prompt: string
  readonly presetId: string | null
  /**
   * Whether any field the preset seeded was changed before this ran (#28).
   *
   * Provenance, not a diff. A preset seeds an editable form — the prompt box is
   * pre-filled and everything stays tweakable — so "which preset produced this"
   * is only half an answer: at 0.78 strength with two clauses rewritten, the
   * preset is where the recipe started and not what it is. One flag is enough to
   * say that out loud, and cheaper than storing what the preset said at the time
   * of seeding, which is a second copy of a library that can be edited.
   *
   * Meaningless while `presetId` is null, and `false` there by convention.
   */
  readonly presetModified: boolean
  readonly seed: SeedSetting
  /**
   * Exactly what goes in the request body, keyed by the model's own field
   * names (PRD §5: `strengthParam` is "the actual API field name"). Reading a
   * persisted recipe should not require guessing what we renamed.
   */
  readonly params: StageParams
  /**
   * Our settings, which no model has ever heard of — rewind looping is ffmpeg
   * (PRD §4.5), not an API field. Kept apart from `params` so the request
   * builder never has to know which keys to strip out.
   */
  readonly options: StageParams
  /**
   * Which upstream generation this consumed — `null` on a source node.
   *
   * This pointer is why the steps are not a wizard (PRD §4.1). A style
   * generation names the picture it was made from, so re-running the node that
   * produced that picture leaves every existing style generation intact and
   * still meaningful. It is also the older half of the DAG: edges *between
   * results* have always been here, which is what ADR 0005 verified before
   * adding edges between drafts.
   */
  readonly inputGenerationId: string | null
  /**
   * The draft node this was frozen from (ADR 0005).
   *
   * On the recipe rather than on {@link Generation} because the recipe is the
   * only part of a candidate that survives the trip through the job store: Rust
   * holds it as an opaque JSON blob and hands it back on arrival, so a node id
   * recorded here needs no column, no schema change and no binding regeneration
   * to come home. It is a resolution made at freeze time exactly like the two
   * pointers above it, and it belongs in the same place they do.
   *
   * A candidate whose node has since been deleted is dropped rather than
   * orphaned — see ADR 0005, "Deleting a node".
   */
  readonly nodeId: string
}

/**
 * The editable form on one node — what a re-run would submit right now
 * (ADR 0005).
 *
 * The **draft** half of the pair. Deliberately holds neither of
 * {@link StageRecipe}'s pointers: `inputGenerationId` is resolved from the
 * node's edge at freeze time (`resolvedInputId`), and `nodeId` is the node this
 * lives on. Typing them here would be storing an answer that is already
 * derivable, which is how two copies drift apart.
 */
export interface DraftRecipe {
  /**
   * Every model this node runs, in submission order — the fan-out axis, and
   * the reason this type exists apart from {@link StageRecipe}.
   *
   * Never empty. One click submits `modelIds.length × batchSize` jobs sharing
   * one `runId`, so the whole fan-out arrives as the one choice it is.
   *
   * The {@link StageRecipe.params} bag below is shared across all of them,
   * keyed by each model's own field names (PRD §5), and every frozen copy runs
   * it through `reconcileParams` for its own model. That is not a new
   * mechanism — it is what swapping one model for another already did, applied
   * once per model instead of once.
   */
  readonly modelIds: readonly string[]
  readonly prompt: string
  readonly presetId: string | null
  /** See {@link StageRecipe.presetModified} — provenance, not a diff. */
  readonly presetModified: boolean
  readonly seed: SeedSetting
  readonly params: StageParams
  readonly options: StageParams
}

/** Where a node sits on the canvas. Persisted — the layout is the user's work. */
export interface NodePosition {
  readonly x: number
  readonly y: number
}

/**
 * One step on the canvas: a re-runnable draft (ADR 0005).
 *
 * A node is **not** a result. Running it appends candidates beside whatever it
 * has already produced and leaves the form editable, which is the whole
 * difference between this and a lineage view.
 */
export interface DraftNode {
  readonly id: string
  readonly kind: StageKind
  /** The user's own name for this step, or `null` to be named after its kind. */
  readonly title: string | null
  readonly position: NodePosition
  readonly draft: DraftRecipe
  /**
   * How many candidates this node produces **per model**, per PRD §4.2.
   *
   * Per node rather than per stage, because a node is what gets run. Held to
   * `MIN_BATCH_SIZE`..`MAX_BATCH_SIZE` on the way in from disk for the reason
   * it always was: a hand-edited `40` would be forty paid calls one click away.
   */
  readonly batchSize: number
  /**
   * The node this one consumes — the edge between **drafts**, and the thing
   * that did not exist before ADR 0005.
   *
   * At most one, which is what makes the draft graph a forest and lets
   * `canConnect` check for cycles by walking up rather than searching.
   * `null` on a source node, and on any node whose input has been detached.
   */
  readonly inputNodeId: string | null
  /**
   * A specific candidate of {@link inputNodeId} to consume, or `null` to follow
   * whatever that node currently offers.
   *
   * A refinement of the edge rather than a second edge: with a pin the canvas
   * draws the line from that candidate, without one it draws from the node.
   * A pin naming a candidate of some other node is ignored — see
   * `resolvedInputId`.
   */
  readonly pinnedInputId: string | null
  /**
   * Which of **this** node's candidates is the one, or `null` while undecided.
   *
   * What `Project.selection[stage]` used to be, moved onto the thing it is
   * about. Downstream nodes read it through `resolvedInputId`, so picking a
   * candidate here is what feeds the rest of the graph.
   */
  readonly pick: string | null
}

/**
 * One model call that happened: its result, plus a frozen copy of the recipe
 * that produced it.
 *
 * The recipe is copied, not referenced. The draft in the sidebar keeps
 * changing; this snapshot must not.
 */
export interface Generation {
  readonly id: string
  readonly stage: StageKind
  readonly recipe: StageRecipe
  /**
   * The seed actually used — recorded even when it was rolled, because a
   * result you like is worthless if you cannot pin what produced it.
   * `null` when the model has no seed parameter at all (PRD §9.1, Kling O1).
   */
  readonly seed: number | null
  readonly verdict: Verdict
  readonly createdAt: number
  /**
   * The run that produced it — one id shared by every candidate of a single
   * click (#26, PRD §4.2), so a four-up can be shown and labelled as the one
   * choice it actually is.
   *
   * `null` is a normal value, not a gap: a candidate written before runs were
   * recorded has none, and neither does one whose run was submitted by a
   * previous launch of the app — the grouping is a convenience, and losing it
   * must never lose the candidate.
   */
  readonly runId: string | null
  /**
   * Position within its **node**, assigned once and never renumbered — "Style 3"
   * has to keep meaning the same candidate after something is rejected, or
   * "the second one was better" (PRD §10.3) stops being sayable.
   * The visible name is `t()` over this; the record holds no English.
   */
  readonly ordinal: number
  /**
   * The file this generation produced, named relative to the project's assets
   * folder — never an absolute path, because the manifest has to survive the
   * app-data directory moving (PRD §3.2).
   *
   * `null` while a stage has no model call behind it yet: style and animate are
   * still fixture-driven, and a generation with no file is exactly what the
   * cleanup pass must not count as an orphan.
   */
  readonly asset: string | null
  /**
   * What this generation cost, in USD — the estimate as the price table read
   * on the day it was collected (ADR 0003).
   *
   * Stamped rather than derived, and that is the whole point: prices drift, and
   * a project's total recomputed from today's table would keep restating what
   * last year's work costs *now*. It also has to be a field the index can sum
   * without a model registry, since the overview must not parse every manifest
   * to draw a grid of cards.
   *
   * `null` is a real answer and not a gap: a token-priced model has no
   * per-image number, an imported image cost nothing to make, and a candidate
   * recorded before this field existed has none. Those are counted and named
   * separately rather than summed as zero — "unknown" and "free" must not look
   * the same.
   *
   * Always an estimate. What fal actually charged goes in
   * {@link Generation.actualCostUsd} beside it rather than overwriting this,
   * so the two stay tellable apart — that difference is the thing ADR 0003
   * exists to measure, and a field that quietly became authoritative could
   * never be checked against the invoice again.
   */
  readonly costUsd: number | null
  /**
   * What fal actually charged for this call, in USD — its `cost_total` from
   * the billing events, joined on {@link Generation.requestId} (ADR 0003).
   *
   * `null` until reconciliation reaches it, and *permanently* null for three
   * distinct populations that all read the same way and must not be confused
   * with a zero charge: a generation with no `requestId` (an import, a
   * fixture), one whose call is older than fal's 90-day billing window, and one
   * on an account whose key the billing endpoint refuses.
   *
   * Where this is a number it *replaces* the estimate rather than adding to it
   * — one call was charged once — and it is the only thing that lets a
   * project's total be shown without a tilde.
   */
  readonly actualCostUsd: number | null
  /**
   * fal's own id for the call that produced this, or `null` when there was no
   * call — an imported image, or a fixture-driven candidate.
   *
   * Persisted here because it is about to be destroyed everywhere else:
   * `request_id` lives on the job row, and claiming a collected job takes that
   * row off the books (ADR 0003). It is the only thing fal's billing events can
   * be joined on, and their window is 90 days — so a generation collected
   * without it is permanently unreconcilable, whatever lands later.
   *
   * Nothing reads it yet. That is the point: the value has to be kept at the
   * one moment it exists, not at the moment something wants it.
   */
  readonly requestId: string | null
  /**
   * The effect applied to this candidate, or `null` for an untreated one (#36).
   *
   * One treatment per generation. Several treatments of one frame, held side by
   * side, is a follow-up — with live preview and instant look switching the
   * comparison is currently made by flipping, not by baking.
   */
  readonly treatment: Treatment | null
}

/**
 * What `project.json` holds.
 *
 * Note what is *not* here: no job state, no `request_id`, no polling cursor.
 * Those belong to the SQLite index (PRD §3.2/§3.3) — disk holds the recipe,
 * the database holds the in-flight work, and a lost database costs you a poll
 * rather than a recipe.
 *
 * Nor is the project's own directory here. It is where the file was found, not
 * something the file gets to claim, or a copied folder would insist it lives
 * somewhere else.
 */
export interface Project {
  readonly id: string
  readonly name: string
  /** Locked at creation, per PRD §4.4 — never edited afterwards. */
  readonly aspect: AspectId
  readonly createdAt: number
  /**
   * The six colour roles this project's prompts speak in, plus extras (#46).
   *
   * Prompt data, not chrome — nothing here styles the app. A preset variable
   * naming a role resolves to that colour's *name* when the preset is picked,
   * and only the expanded prose is persisted, which is what makes this editable
   * after creation: changing it cannot reach back into anything already
   * generated, only into what the next pick seeds. Same argument `batchSizes`
   * won on, and copied from the defaults at creation for the same reason
   * (PRD §11).
   */
  readonly palette: Palette
  /**
   * The canvas: every draft, and the edges between them (ADR 0005).
   *
   * This replaced three things at once — `drafts`, `selection` and
   * `batchSizes`, all of them `Record<StageKind, …>`, all of them addressed by
   * a string literal because there were exactly three of everything. Each is
   * now a field on the node it was always about.
   *
   * Ordered for the file rather than for the graph: a node's place in this
   * array means nothing, its `position` and its `inputNodeId` mean everything.
   */
  readonly nodes: readonly DraftNode[]
  /**
   * Flat and append-only. Which node made a candidate is a field on its
   * recipe, not a bucket — the same shape `stage` always had.
   */
  readonly generations: readonly Generation[]
}

/**
 * One row of the project list, as the SQLite index holds it (PRD §3.2).
 *
 * Deliberately not a `Project`: listing every project must not mean parsing
 * every manifest, and the sidebar only ever shows this much. `directory` is
 * where the manifest was found, so the frontend can resolve asset files
 * without a round-trip per image.
 *
 * Taken from the generated bindings rather than declared here, because it is a
 * wire shape Rust already defines — `docs/developer/tauri-commands.md`: "no
 * manual sync between Rust and TypeScript". Note its `aspect` is a bare
 * string: the index copied a label out of a manifest, and whether that label
 * names a ratio this build still offers is settled by `readManifest` when the
 * project is opened.
 */
import type { ProjectSummary } from '@/lib/tauri-bindings'

export type { ProjectSummary }

/**
 * Session state — the editor, not the project. Never persisted.
 *
 * One project is open at a time. The alternative — every manifest in memory —
 * would make "open a project" a no-op and quietly reintroduce the assumption
 * that the whole library fits in a tab.
 */
export interface EditorState {
  /** The project list, from the index. */
  readonly summaries: readonly ProjectSummary[]
  /** The open project, or `null` when the library is empty or still loading. */
  readonly project: Project | null
  /** Where the open project's manifest lives — assets hang off it. */
  readonly directory: string | null
  /**
   * The node the right sidebar is editing, or `null` for none (ADR 0005).
   *
   * What `activeStage` was, except that it is genuinely nullable now: with the
   * tab bar gone there is no "current stage" that always exists, and clicking
   * empty canvas is a real state rather than an impossible one. The sidebar
   * shows the project's own panel there.
   *
   * Session state, not the project's: which node you had selected is not a fact
   * about the recipe, and a manifest that recorded it would make opening a
   * project on another machine a different experience.
   */
  readonly selectedNodeId: string | null
  /**
   * Whether the effects panel is the one on screen (#36).
   *
   * A flag beside `selectedNodeId` rather than a node kind, because an effect
   * is not a step: it has no model, no seed and no price, and it is chosen
   * while looking at a result rather than submitted. Widening `StageKind`
   * instead would reach `modelsForStage`, `modelById`, `DEFAULT_MODEL_IDS` and
   * `validateRegistry`, none of which a modelless kind can answer.
   */
  readonly effectsOpen: boolean
  /**
   * The candidate the effects tab is pinned to, or `null` to follow the
   * selection.
   *
   * Sticky on purpose: without it, changing your selection elsewhere would
   * silently move you onto a different generation's treatment mid-edit. Session
   * state, because a pin is a thing you are doing rather than a thing the
   * project holds.
   */
  readonly treatmentTarget: string | null
  /** PRD §10.3 — rejected candidates stay reachable behind one toggle. */
  readonly showRejected: boolean
  /**
   * What the preset picker's variable fields say — by project, then by **node**
   * (#46, re-keyed by ADR 0005).
   *
   * Session state and never persisted: only the *expanded* prose reaches a
   * recipe, so keeping these in the manifest would be a second copy of
   * something the prompt already contains. But session-*wide* rather than
   * per-mount, which is the part that had to move. The right sidebar swaps the
   * whole form out when you select another node or open the effects panel, so
   * values held in the control's own `useState` went with it — while the prompt
   * box kept the old expansion, which reads as a hand edit and made
   * `presetSeedState` refuse every later variable change in silence, until a
   * paid run went out on the previous value.
   *
   * Kept per project rather than cleared on the way out, because looking at
   * another project is not answering its questions again — you come back to the
   * subject you were working on. Only deleting one drops its entry, since there
   * is nothing left to come back to.
   *
   * By **variable name** within a node, not by preset: `{{subject}}` is the
   * same question in 21 of the 22 scenes, and trying the next scene for the same
   * subject is what the library is for. A key the newly picked preset does not
   * have is neither shown nor expanded — it simply waits, in case you come back
   * to a preset that asks for it.
   *
   * Keyed by node rather than by kind since ADR 0005, because two style nodes
   * on one canvas are two different questions and sharing their answers would
   * be the same silent overwrite this field was created to stop.
   */
  readonly presetVariables: Readonly<
    Record<string, Readonly<Record<string, PresetVariableValues>>>
  >
  /**
   * The runs this session is watching (#26).
   *
   * Session state, deliberately: a run is a thing being waited on, and the
   * manifest already records the durable half of it on each candidate. Held
   * here rather than in a module of its own so the grid subscribes to it like
   * everything else — see `docs/developer/state-management.md`.
   *
   * Also where "who decided this stage's selection" lives, on the two flags
   * below. Keeping it here rather than in a field of its own is what makes the
   * hold survive closing and reopening a project while its jobs run on.
   */
  readonly runs: readonly RunRecord[]
}

/**
 * One click's worth of generations, and what became of them (#26, PRD §4.2).
 *
 * Membership is a list of generation ids rather than a job filter, because the
 * job store is not a reliable census of a run: `active_jobs` reports only what
 * is *running*, so a completed job leaves the list before its candidate is in
 * the manifest, and a stalled one leaves without producing anything. A run
 * that asked the job store how big it was would shrink as it succeeded.
 */
export interface RunRecord {
  readonly id: string
  readonly projectId: string
  /**
   * The node that was run (ADR 0005). Was `stage`, and the swap is the whole
   * point: two style nodes running at once are two runs with two grids, where
   * one stage could only ever have had one.
   */
  readonly nodeId: string
  readonly startedAt: number
  /** Every candidate the run asked for, in submission order. */
  readonly generationIds: readonly string[]
  /**
   * The ones that will never arrive — a submit fal refused, a job that failed
   * or was cancelled. Kept rather than removed so the grid can stop waiting
   * without pretending the run was smaller than it was.
   */
  readonly abandonedIds: readonly string[]
  /**
   * The question has been answered: the user picked a candidate, dismissed the
   * grid, or chose something else on this node while the run was open. The
   * grid steps aside, and no arrival of this run may move the pick again.
   */
  readonly answered: boolean
  /**
   * One of this run's candidates has already taken the node's `pick`.
   *
   * The first arrival claims an undecided node, so anything downstream always
   * has an input — and the rest of the batch does not, or a four-up would end
   * on whichever job happened to finish last.
   */
  readonly claimed: boolean
}
