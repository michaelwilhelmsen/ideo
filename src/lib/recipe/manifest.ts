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

import { readTreatment, writeTreatment } from '@/lib/effects/treatment'
import { isAspectId } from './aspects'
import { isRecord } from './json'
import { readPalette, type Palette } from './palette'
import { clampBatchSize, DEFAULT_BATCH_SIZES } from './selectors'
import type {
  Generation,
  ParamValue,
  PixelSize,
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
  /** #55. Absent in manifests older than the slice, which read as `null`. */
  readonly costUsd: number | null
  /** #55, for ADR 0003's reconciliation. Absent in older manifests. */
  readonly requestId: string | null
  /** #36. Absent in manifests older than the slice, which read as `null`. */
  readonly treatment: unknown
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
   * #26, keyed by stage. Absent in older manifests, which read as the
   * defaults — the same numbers a project created today would be given, so
   * nothing about an existing project changes by being opened.
   */
  readonly batchSizes: Readonly<Record<string, number>>
  /**
   * #46. **Required**, and reading throws without it — the one field here with
   * no tolerant fallback.
   *
   * Deliberately unlike `batchSizes`, and the difference is what the absence
   * would mean. A missing batch size is a preference nobody expressed, and the
   * default is the same number a project created today would get. A missing
   * palette is six colours the prompts are about to be written in: quietly
   * substituting ours would make an unopenable project into one that opens and
   * says something different. This is initial development, there are no
   * manifests in the wild to stay compatible with, and a fallback would only
   * ever hide the bug it exists to survive.
   */
  readonly palette: Palette
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
    batchSizes: project.batchSizes,
    palette: project.palette,
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
      costUsd: generation.costUsd,
      requestId: generation.requestId,
      treatment:
        generation.treatment === null
          ? null
          : writeTreatment(generation.treatment),
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
    batchSizes: readBatchSizes(manifest.batchSizes),
    // Throws, and takes the project with it — see `ProjectManifest.palette`.
    palette: readPalette(manifest.palette),
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
    // #55. Absent on anything recorded before costs were stamped, which reads
    // as `null` — an unknown cost, deliberately not a zero one.
    costUsd:
      typeof document.costUsd === 'number' && Number.isFinite(document.costUsd)
        ? document.costUsd
        : null,
    // #55. The join key for fal's billing events (ADR 0003). Absent on
    // anything collected before it was persisted, which reads as `null` — a
    // generation that can never be reconciled, and says so.
    requestId:
      typeof document.requestId === 'string' ? document.requestId : null,
    // #36. Read whole rather than through `readParams`, and *not* resolved
    // against the effects library — see `lib/effects/treatment.ts`. A candidate
    // from before the slice carries none, which is what `null` says.
    treatment: readTreatment(document.treatment),
  }
}

/**
 * How many candidates each stage produces, held to what we would submit.
 *
 * Missing is the normal case for a manifest written before #26 and takes the
 * default. A number that is there but outside the range is a hand-edit, and is
 * *clamped* rather than replaced: `40` plainly means "as many as you can", and
 * four is as many as we do — refusing the project over a preference would be
 * the wrong trade when the recipe is what is expensive (PRD §1).
 */
function readBatchSizes(value: unknown): Project['batchSizes'] {
  const record = isRecord(value) ? value : {}
  const sizes: Partial<Record<StageKind, number>> = {}

  for (const stage of STAGE_ORDER) {
    const size = record[stage]
    sizes[stage] =
      typeof size === 'number' && Number.isFinite(size)
        ? clampBatchSize(size)
        : DEFAULT_BATCH_SIZES[stage]
  }

  return sizes as Project['batchSizes']
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
    // #28. Absent in every manifest written before the slice, and `false` is the
    // truthful reading of that: nothing recorded an edit, so none is claimed.
    // Only `true` counts, so a hand-edited `"yes"` does not become one.
    presetModified: document.presetModified === true,
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
 *
 * A `{width, height}` pair is one of those types: a recipe records the geometry
 * it was actually sent (AC10), and dropping it here would mean a manifest that
 * read back less re-runnable than it was written.
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
      continue
    }
    const size = readPixelSize(entry)
    if (size !== null) params[key] = size
  }
  return params
}

/** An explicit output size, if that is what this is. */
function readPixelSize(value: unknown): PixelSize | null {
  if (!isRecord(value)) return null
  const { width, height } = value
  if (typeof width !== 'number' || typeof height !== 'number') return null
  return { width, height }
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
