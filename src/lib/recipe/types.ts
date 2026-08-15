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

/** The three stages of PRD §1, in order. */
export type StageKind = 'source' | 'style' | 'animate'

export const STAGE_ORDER = ['source', 'style', 'animate'] as const

/**
 * PRD §4.4 — locked at project creation, inherited by every stage, and each
 * entry carries whether animation is possible at that ratio.
 */
export type AspectId = '16:9' | '21:9' | '2:1' | '3:2' | '1:1'

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
 * Everything needed to re-run one stage. This is the artefact PRD §1 calls
 * expensive — the thing worth persisting, restoring, and paying attention to.
 */
export interface StageRecipe {
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
   * Which upstream generation this consumed — `null` for source.
   *
   * This pointer is why the stages are not a wizard (PRD §4.1). A style
   * generation names the source it was made from, so re-running source leaves
   * every existing style generation intact and still meaningful.
   */
  readonly inputGenerationId: string | null
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
   * Position within its stage, assigned once and never renumbered — "Style 3"
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
   * How many candidates one run of each stage produces, per PRD §4.2 — four
   * images, one video.
   *
   * Keyed by stage like `drafts` and `selection` rather than named per medium,
   * so nothing downstream has to keep asking which stages are images.
   *
   * Per project rather than per app, and *copied* from the defaults at
   * creation (PRD §11): changing a default later must not quietly make an old
   * project spend four times as much on its next click. Unlike the aspect
   * ratio these stay editable, because nothing already made depends on them.
   */
  readonly batchSizes: Readonly<Record<StageKind, number>>
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
  /** The editable form per stage — what a re-run would submit right now. */
  readonly drafts: Readonly<Record<StageKind, StageRecipe>>
  /** Flat and append-only. Stage membership is a field, not a bucket. */
  readonly generations: readonly Generation[]
  /** Which generation each stage is currently working from. */
  readonly selection: Readonly<Record<StageKind, string | null>>
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
  readonly activeStage: StageKind
  /**
   * Whether the effects tab is the one on screen (#36).
   *
   * A flag beside `activeStage` rather than a fourth value *in* it, because the
   * two answer different questions and both still have to be answered while the
   * tab is open: `activeStage` says which stage's form the right sidebar edits
   * and which stage's selection the export panel would send, and an effect is
   * not a stage — it has no model, no seed and no price. Widening `StageKind`
   * instead would reach `readDrafts`, `modelById`, `DEFAULT_MODEL_IDS` and
   * `validateRegistry`, none of which a modelless tab can answer.
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
   * What the preset picker's variable fields say — by project, then by stage
   * (#46).
   *
   * Session state and never persisted: only the *expanded* prose reaches a
   * recipe, so keeping these in the manifest would be a second copy of
   * something the prompt already contains. But session-*wide* rather than
   * per-mount, which is the part that had to move. The right sidebar swaps the
   * whole stage form out when you change tab or open the effects tab, so values
   * held in the control's own `useState` went with it — while the prompt box
   * kept the old expansion, which reads as a hand edit and made
   * `presetSeedState` refuse every later variable change in silence, until a
   * paid run went out on the previous value.
   *
   * Kept per project rather than cleared on the way out, because looking at
   * another project is not answering its questions again — you come back to the
   * subject you were working on. Only deleting one drops its entry, since there
   * is nothing left to come back to.
   *
   * By **variable name** within a stage, not by preset: `{{subject}}` is the
   * same question in 21 of the 22 scenes, and trying the next scene for the same
   * subject is what the library is for. A key the newly picked preset does not
   * have is neither shown nor expanded — it simply waits, in case you come back
   * to a preset that asks for it.
   */
  readonly presetVariables: Readonly<
    Record<string, Readonly<Record<StageKind, PresetVariableValues>>>
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
  readonly stage: StageKind
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
   * grid, or chose something else for this stage while the run was open. The
   * grid steps aside, and no arrival of this run may move the selection again.
   */
  readonly answered: boolean
  /**
   * One of this run's candidates has already taken the stage's selection.
   *
   * The first arrival claims an undecided stage, so the stage after it always
   * has an input — and the second, third and fourth do not, or a four-up would
   * end on whichever job happened to finish last.
   */
  readonly claimed: boolean
}
