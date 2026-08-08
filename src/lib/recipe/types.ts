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

/**
 * Model parameters, kept as a bag rather than named fields.
 *
 * Named fields would mean the type knows about `strength`, `duration` and
 * `resolution` — but PRD §5 is explicit that those are per-model and named
 * differently across models. The registry says which keys are legal; the
 * recipe just carries whatever was sent.
 */
export type ParamValue = string | number | boolean
export type StageParams = Readonly<Record<string, ParamValue>>

/**
 * Everything needed to re-run one stage. This is the artefact PRD §1 calls
 * expensive — the thing worth persisting, restoring, and paying attention to.
 */
export interface StageRecipe {
  readonly modelId: string
  /** Subject prose (source), style fragment (style), motion fragment (animate). */
  readonly prompt: string
  readonly presetId: string | null
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
   * Position within its stage, assigned once and never renumbered — "Style 3"
   * has to keep meaning the same candidate after something is rejected, or
   * "the second one was better" (PRD §10.3) stops being sayable.
   * The visible name is `t()` over this; the record holds no English.
   */
  readonly ordinal: number
}

/**
 * What `project.json` holds (#23).
 *
 * Note what is *not* here: no job state, no `request_id`, no polling cursor.
 * Those belong to the SQLite index (PRD §3.2/§3.3) — disk holds the recipe,
 * the database holds the in-flight work, and a lost database costs you a poll
 * rather than a recipe.
 */
export interface Project {
  readonly id: string
  readonly name: string
  /** Locked at creation, per PRD §4.4 — never edited afterwards. */
  readonly aspect: AspectId
  readonly createdAt: number
  /** The editable form per stage — what a re-run would submit right now. */
  readonly drafts: Readonly<Record<StageKind, StageRecipe>>
  /** Flat and append-only. Stage membership is a field, not a bucket. */
  readonly generations: readonly Generation[]
  /** Which generation each stage is currently working from. */
  readonly selection: Readonly<Record<StageKind, string | null>>
}

/** Session state — the editor, not the project. Never persisted. */
export interface EditorState {
  readonly projects: readonly Project[]
  readonly activeProjectId: string
  readonly activeStage: StageKind
  /** PRD §10.3 — rejected candidates stay reachable behind one toggle. */
  readonly showRejected: boolean
}
