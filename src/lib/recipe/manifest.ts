/**
 * `project.json` — the recipe as it lives on disk (PRD §3.2).
 *
 * Disk is authoritative, so this file is the only place that decides what a
 * project *is*. Rust owns the folder, the atomic write and the index; it does
 * not own the recipe, because the recipe widens with every slice and a shape
 * declared twice drifts.
 *
 * Both directions are here on purpose. `writeManifest` is what gets written;
 * `readManifest` treats whatever comes back as untrusted — a manifest can be
 * hand-edited, copied off another machine, or written by an older build, and
 * "it was ours once" is not a guarantee about what it says now.
 *
 * The rule when a manifest disagrees with this build: refuse the *project*
 * only when the disagreement is about the project (its version, its ratio).
 * A single candidate this build cannot read is dropped, because the recipe is
 * the expensive artefact (PRD §1) and losing all of it over one unreadable
 * candidate is the wrong trade.
 */

import { isAspectId } from './aspects'
import {
  clampBatchSize,
  DEFAULT_IMAGE_BATCH,
  DEFAULT_VIDEO_BATCH,
} from './selectors'
import type {
  Generation,
  ParamValue,
  Project,
  SeedSetting,
  StageKind,
  StageParams,
  StageRecipe,
  Verdict,
} from './types'
import { STAGE_ORDER } from './types'

/** Bumped when a manifest written today would be misread by an older build. */
export const MANIFEST_VERSION = 1

/**
 * An asset is a bare file name inside the project's `assets/` folder. Anything
 * with a separator in it is a claim about somewhere else on the filesystem.
 */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const VERDICTS: readonly Verdict[] = ['unrated', 'approved', 'rejected']

export interface ManifestGeneration {
  readonly id: string
  readonly stage: string
  readonly ordinal: number
  readonly seed: number | null
  readonly verdict: string
  readonly createdAt: number
  readonly asset: string | null
  readonly recipe: unknown
  /** #26. Absent in manifests older than the slice, which read as `null`. */
  readonly runId: string | null
}

export interface ProjectManifest {
  readonly version: number
  readonly id: string
  readonly name: string
  readonly aspect: string
  readonly createdAt: number
  /** When this file was last written — the index sorts on it. */
  readonly updatedAt: number
  readonly drafts: unknown
  readonly selection: unknown
  readonly generations: readonly ManifestGeneration[]
  /**
   * #26. Absent in older manifests, which read as the defaults — the same
   * numbers a project created today would have been given, so nothing about
   * an existing project changes by being opened.
   */
  readonly imageBatchSize: number
  readonly videoBatchSize: number
}

/** The project, as the bytes that go to disk. */
export function writeManifest(project: Project, now: number): ProjectManifest {
  return {
    version: MANIFEST_VERSION,
    id: project.id,
    name: project.name,
    aspect: project.aspect,
    createdAt: project.createdAt,
    updatedAt: now,
    imageBatchSize: project.imageBatchSize,
    videoBatchSize: project.videoBatchSize,
    drafts: project.drafts,
    selection: project.selection,
    generations: project.generations.map(generation => ({
      id: generation.id,
      stage: generation.stage,
      ordinal: generation.ordinal,
      seed: generation.seed,
      verdict: generation.verdict,
      createdAt: generation.createdAt,
      asset: generation.asset,
      recipe: generation.recipe,
      runId: generation.runId,
    })),
  }
}

/**
 * The bytes from disk, as a project — or a throw naming what was wrong with
 * them. Throwing is the point: the caller has to decide out loud what to show
 * for a project it cannot open, and a silently half-loaded recipe would be
 * indistinguishable from one the user edited badly.
 */
export function readManifest(document: unknown): Project {
  const manifest = asRecord(document, 'manifest')

  const version = asNumber(manifest.version, 'version')
  if (version !== MANIFEST_VERSION) {
    throw new Error(
      `Manifest version ${version} is not version ${MANIFEST_VERSION}`
    )
  }

  const aspect = manifest.aspect
  if (!isAspectId(aspect)) {
    throw new Error(`Manifest names an aspect ratio we do not offer: ${aspect}`)
  }

  const generations = asArray(manifest.generations, 'generations')
    .map(readGeneration)
    .filter((generation): generation is Generation => generation !== null)

  const known = new Set(generations.map(generation => generation.id))

  return {
    id: asString(manifest.id, 'id'),
    name: asString(manifest.name, 'name'),
    aspect,
    createdAt: asNumber(manifest.createdAt, 'createdAt'),
    // Missing is the normal case for a manifest written before #26, and a
    // number outside the range is a hand-edit — both take the default rather
    // than the project, because a batch size is a preference and the recipe
    // is the thing worth refusing over.
    imageBatchSize: readBatchSize(manifest.imageBatchSize, DEFAULT_IMAGE_BATCH),
    videoBatchSize: readBatchSize(manifest.videoBatchSize, DEFAULT_VIDEO_BATCH),
    drafts: readDrafts(manifest.drafts),
    generations,
    selection: readSelection(manifest.selection, known),
  }
}

/**
 * One candidate, or `null` if this build cannot make sense of it.
 *
 * `null` rather than a throw: a manifest written by a newer build can carry a
 * stage that does not exist here yet, and that is a reason to show the rest of
 * the project rather than none of it.
 */
function readGeneration(document: unknown): Generation | null {
  if (!isRecord(document)) return null

  const stage = document.stage
  if (!isStageKind(stage)) return null

  const recipe = readRecipe(document.recipe)
  if (recipe === null) return null

  const verdict = document.verdict
  if (typeof document.id !== 'string') return null

  return {
    id: document.id,
    stage,
    recipe,
    seed: typeof document.seed === 'number' ? document.seed : null,
    verdict: isVerdict(verdict) ? verdict : 'unrated',
    createdAt: typeof document.createdAt === 'number' ? document.createdAt : 0,
    ordinal: typeof document.ordinal === 'number' ? document.ordinal : 0,
    asset: readAsset(document.asset),
    // A candidate from before #26 belongs to no recorded run, which is what
    // `null` says. Losing the grouping costs a divider in the strip; refusing
    // the candidate over it would cost the recipe.
    runId: typeof document.runId === 'string' ? document.runId : null,
  }
}

/** A batch size we would be willing to submit, or the default. */
function readBatchSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return clampBatchSize(value)
}

/**
 * The file name, if it is one. A name that could walk out of the project
 * folder loses its claim to a file rather than taking the generation with it —
 * the recipe is still worth having, and the pixels are re-derivable.
 */
function readAsset(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return ASSET_NAME.test(value) ? value : null
}

/**
 * One recipe, or `null` if this build cannot make sense of it.
 *
 * Exported because a manifest is not the only place a recipe comes back from:
 * a job carries its own across a restart (#24), and it is the same untrusted
 * document — hand-editable, or written by a build that knew more.
 */
export function readRecipe(document: unknown): StageRecipe | null {
  if (!isRecord(document)) return null
  if (typeof document.modelId !== 'string') return null

  const seed = readSeed(document.seed)
  if (seed === null) return null

  return {
    modelId: document.modelId,
    prompt: typeof document.prompt === 'string' ? document.prompt : '',
    presetId: typeof document.presetId === 'string' ? document.presetId : null,
    seed,
    params: readParams(document.params),
    options: readParams(document.options),
    inputGenerationId:
      typeof document.inputGenerationId === 'string'
        ? document.inputGenerationId
        : null,
  }
}

function readSeed(value: unknown): SeedSetting | null {
  if (!isRecord(value)) return null
  if (value.mode === 'roll') return { mode: 'roll' }
  if (value.mode === 'pinned' && typeof value.value === 'number') {
    return { mode: 'pinned', value: value.value }
  }
  return null
}

/**
 * Parameters are a bag keyed by each model's own field names (PRD §5), so
 * there is nothing to check them against beyond the types a request body can
 * carry. Anything else is dropped rather than sent to an API.
 */
function readParams(value: unknown): StageParams {
  if (!isRecord(value)) return {}

  const params: Record<string, ParamValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      params[key] = entry
    }
  }
  return params
}

/**
 * Drafts are the form you would re-run from, so all three have to be there.
 * Unlike a candidate, a missing draft is not something the rest of the project
 * survives — there would be nothing to put in the panel.
 */
function readDrafts(document: unknown): Project['drafts'] {
  const record = asRecord(document, 'drafts')
  const drafts: Partial<Record<StageKind, StageRecipe>> = {}

  for (const stage of STAGE_ORDER) {
    const recipe = readRecipe(record[stage])
    if (recipe === null) {
      throw new Error(`Manifest has no readable ${stage} draft`)
    }
    drafts[stage] = recipe
  }

  return drafts as Project['drafts']
}

/**
 * A selection is a pointer, and a pointer to a candidate that is no longer
 * there is worse than none — the stage would claim an input it cannot show.
 */
function readSelection(
  document: unknown,
  known: ReadonlySet<string>
): Project['selection'] {
  const record = isRecord(document) ? document : {}
  const selection: Partial<Record<StageKind, string | null>> = {}

  for (const stage of STAGE_ORDER) {
    const id = record[stage]
    selection[stage] = typeof id === 'string' && known.has(id) ? id : null
  }

  return selection as Project['selection']
}

export function isStageKind(value: unknown): value is StageKind {
  return STAGE_ORDER.some(stage => stage === value)
}

function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some(verdict => verdict === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Manifest has no ${field}`)
  return value
}

function asArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Manifest has no ${field}`)
  return value
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Manifest has no ${field}`)
  return value
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new Error(`Manifest has no ${field}`)
  return value
}
