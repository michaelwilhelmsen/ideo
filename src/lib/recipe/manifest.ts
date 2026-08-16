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
import { heldModelIds } from './graph'
import { isRecord } from './json'
import { DEFAULT_MODEL_IDS } from './models'
import { readPalette, type Palette } from './palette'
import { clampBatchSize, DEFAULT_BATCH_SIZES } from './selectors'
import type {
  DraftNode,
  DraftRecipe,
  Generation,
  NodePosition,
  ParamValue,
  PixelSize,
  Project,
  SeedSetting,
  StageKind,
  StageParams,
  StageRecipe,
  Verdict,
} from './types'
import { needsInput, STAGE_ORDER } from './types'

/**
 * Bumped when a manifest written today would be misread by an older build.
 *
 * **2** is the canvas (ADR 0005), and there is deliberately no upgrade path
 * from 1. A v1 manifest holds three drafts keyed by stage, a selection per
 * stage and no node positions; turning that into a graph would mean inventing
 * coordinates, guessing which of three forms deserved to become a node, and
 * deciding what a per-stage selection meant — three guesses, all wrong for
 * anything but an empty project, in service of files that do not exist yet.
 *
 * So a v1 file is **refused**, not migrated. See {@link readManifest}: the
 * version check is the second statement in the function, before any field is
 * touched, and the project stays on disk exactly as it was.
 */
export const MANIFEST_VERSION = 2

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
  /** #56 — fal's own charge. Absent until a pass reconciles this candidate. */
  readonly actualCostUsd: number | null
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
  /**
   * The canvas (ADR 0005) — every draft, its position, and its input edge.
   *
   * This one field replaced `drafts`, `selection` and `batchSizes`, all three of
   * which were `Record<StageKind, …>` and none of which could hold two style
   * steps.
   */
  readonly nodes: readonly unknown[]
  readonly generations: readonly ManifestGeneration[]
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
    palette: project.palette,
    nodes: project.nodes,
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
      actualCostUsd: generation.actualCostUsd,
      treatment:
        generation.treatment === null
          ? null
          : writeTreatment(generation.treatment),
    })),
  }
}

/**
 * A manifest this build will not open because of its *version*.
 *
 * Its own class rather than a plain `Error` so the caller can tell it apart
 * from "this file is corrupt" without matching on a message. They deserve
 * different sentences: a v1 project is intact and simply not readable here
 * (ADR 0005 — no migration), and telling somebody their work is damaged when it
 * is not would be the worse of the two mistakes.
 */
export class IncompatibleManifestError extends Error {
  constructor(readonly found: number) {
    super(`Manifest version ${found} is not version ${MANIFEST_VERSION}`)
    this.name = 'IncompatibleManifestError'
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

  // Before anything else is touched, so a v1 file is refused whole rather than
  // half-read (ADR 0005 — "No migration").
  const version = asNumber(manifest.version, 'version')
  if (version !== MANIFEST_VERSION) {
    throw new IncompatibleManifestError(version)
  }

  const aspect = manifest.aspect
  if (!isAspectId(aspect)) {
    throw new Error(`Manifest names an aspect ratio we do not offer: ${aspect}`)
  }

  const nodes = readNodes(manifest.nodes)
  const known = new Set(nodes.map(node => node.id))

  const generations = asArray(manifest.generations, 'generations')
    .map(readGeneration)
    .filter((generation): generation is Generation => generation !== null)
    // A candidate naming a node this file does not hold has nowhere to be
    // drawn, and the canvas is the only surface there is. Dropped for the
    // reason an unreadable one is: the rest of the project is still worth
    // showing, and the *file* stays in `assets/` either way.
    .filter(generation => known.has(generation.recipe.nodeId))

  const candidates = new Set(generations.map(generation => generation.id))

  return {
    id: asString(manifest.id, 'id'),
    name: asString(manifest.name, 'name'),
    aspect,
    createdAt: asNumber(manifest.createdAt, 'createdAt'),
    // Throws, and takes the project with it — see `ProjectManifest.palette`.
    palette: readPalette(manifest.palette),
    // Second pass, now that the candidates are known: a pointer at a candidate
    // that is not there is worse than none, because the node would claim a
    // picture it cannot show. Edges are checked here too — a `inputNodeId`
    // naming a missing node, or one that closes a cycle, is dropped rather than
    // taking the project with it.
    nodes: nodes.map(node => resolvePointers(node, known, candidates, nodes)),
    generations,
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
    // #56. Absent on everything written before reconciliation existed, and on
    // everything a pass has not reached — which are the same answer as far as
    // the total is concerned, and neither of them is a charge of zero.
    actualCostUsd:
      typeof document.actualCostUsd === 'number' &&
      Number.isFinite(document.actualCostUsd)
        ? document.actualCostUsd
        : null,
    // #36. Read whole rather than through `readParams`, and *not* resolved
    // against the effects library — see `lib/effects/treatment.ts`. A candidate
    // from before the slice carries none, which is what `null` says.
    treatment: readTreatment(document.treatment),
  }
}

/**
 * The canvas, or a throw. A project with no readable node has nothing to edit.
 *
 * Individual nodes are dropped where they cannot be read — a kind this build
 * does not know is a node from a newer build, and that is a reason to show the
 * rest of the canvas rather than none of it. An *empty* canvas is different: it
 * means the file said nothing about what the project is, and there would be no
 * surface to put in front of the user.
 *
 * Duplicated ids are dropped down to the first, because every pointer in the
 * file — `inputNodeId`, `pinnedInputId`, every generation's `nodeId` — resolves
 * by id, and two nodes answering to one id is a graph with no single meaning.
 */
function readNodes(value: unknown): readonly DraftNode[] {
  const entries = asArray(value, 'nodes')
  const seen = new Set<string>()
  const nodes: DraftNode[] = []

  for (const entry of entries) {
    const node = readNode(entry)
    if (node === null || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }

  if (nodes.length === 0) throw new Error('Manifest has no readable nodes')
  return nodes
}

/** One node, or `null` if this build cannot make sense of it. */
function readNode(document: unknown): DraftNode | null {
  if (!isRecord(document)) return null
  if (typeof document.id !== 'string' || document.id === '') return null

  const kind = document.kind
  if (!isStageKind(kind)) return null

  const draft = readDraft(document.draft, kind)
  if (draft === null) return null

  return {
    id: document.id,
    kind,
    title: typeof document.title === 'string' ? document.title : null,
    position: readPosition(document.position),
    draft,
    // Clamped rather than replaced, for the reason it always was: `40` plainly
    // means "as many as you can", and four is as many as we do — refusing the
    // project over a preference would be the wrong trade when the recipe is
    // what is expensive (PRD §1).
    batchSize:
      typeof document.batchSize === 'number' &&
      Number.isFinite(document.batchSize)
        ? clampBatchSize(document.batchSize)
        : DEFAULT_BATCH_SIZES[kind],
    // Both pointers are read as *claims* here and settled in `resolvePointers`
    // once every node and candidate in the file is known. A source node can
    // hold neither, whatever the file says: its models declare no image field,
    // so an edge into one could never be sent.
    inputNodeId:
      needsInput(kind) && typeof document.inputNodeId === 'string'
        ? document.inputNodeId
        : null,
    pinnedInputId:
      needsInput(kind) && typeof document.pinnedInputId === 'string'
        ? document.pinnedInputId
        : null,
    pick: typeof document.pick === 'string' ? document.pick : null,
  }
}

/**
 * A node's coordinates, or the origin.
 *
 * The origin rather than a throw, and rather than a random scatter: a position
 * is the least expensive thing in the file to lose, and a node stacked on
 * another is one drag from being right. A `NaN` from a hand-edit reads the same
 * as a missing one — React Flow would render a node at no coordinates at all.
 */
function readPosition(value: unknown): NodePosition {
  if (!isRecord(value)) return { x: 0, y: 0 }
  const { x, y } = value
  return {
    x: typeof x === 'number' && Number.isFinite(x) ? x : 0,
    y: typeof y === 'number' && Number.isFinite(y) ? y : 0,
  }
}

/**
 * The editable form on a node, or `null` if this build cannot read it.
 *
 * Unlike a candidate's frozen recipe there is a sensible default for a missing
 * model — the one a new node of this kind would start on — because a draft is a
 * form rather than a record of something that happened. A frozen recipe with no
 * model is a lie about a call that was made; a draft with no model is a form
 * nobody has filled in.
 */
function readDraft(document: unknown, kind: StageKind): DraftRecipe | null {
  if (!isRecord(document)) return null

  const seed = readSeed(document.seed)
  if (seed === null) return null

  const declared = Array.isArray(document.modelIds)
    ? document.modelIds.filter((id): id is string => typeof id === 'string')
    : []

  return {
    // Never empty and never over `MAX_MODELS_PER_NODE`: an empty list is a run
    // button that submits nothing, and an uncapped one is a click that spends
    // without a ceiling. Both are one hand-edit away.
    modelIds: heldModelIds(declared, DEFAULT_MODEL_IDS[kind]),
    prompt: typeof document.prompt === 'string' ? document.prompt : '',
    presetId: typeof document.presetId === 'string' ? document.presetId : null,
    presetModified: document.presetModified === true,
    seed,
    params: readParams(document.params),
    options: readParams(document.options),
  }
}

/**
 * A node's three pointers, settled against what the file actually holds.
 *
 * Deliberately a second pass rather than part of {@link readNode}: an edge can
 * name a node that appears later in the array, and a pin can name a candidate
 * read after every node. Checking them one at a time would make the answer
 * depend on the order the file happened to be written in.
 *
 * A refused pointer becomes `null` rather than taking the node with it. Each
 * has a live fallback — `resolvedInputId` climbs its ladder, a node with no
 * pick shows no hero — so the cost of dropping one is a click, where the cost
 * of refusing the project is the recipe (PRD §1).
 */
function resolvePointers(
  node: DraftNode,
  nodes: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
  all: readonly DraftNode[]
): DraftNode {
  const inputNodeId =
    node.inputNodeId !== null &&
    nodes.has(node.inputNodeId) &&
    !closesCycle(node, all)
      ? node.inputNodeId
      : null

  return {
    ...node,
    inputNodeId,
    // A pin only means anything while there is an edge for it to refine, so it
    // goes with a dropped edge. Whether it names a candidate of *that* node is
    // settled live by `isEligibleInput`, which is the one place that rule lives.
    pinnedInputId:
      inputNodeId !== null &&
      node.pinnedInputId !== null &&
      candidates.has(node.pinnedInputId)
        ? node.pinnedInputId
        : null,
    pick: node.pick !== null && candidates.has(node.pick) ? node.pick : null,
  }
}

/**
 * Whether following this node's edges comes back to itself.
 *
 * `canConnect` makes a cycle unreachable through the UI, but the manifest is
 * untrusted input (PRD §3.2) and a hand-edited one can write any pair of ids it
 * likes. A cycle here would make `resolvedInputId` recurse forever, which is a
 * hung window rather than a bad picture — so it is checked on the way in and
 * broken at the node that closes it.
 */
function closesCycle(node: DraftNode, all: readonly DraftNode[]): boolean {
  const seen = new Set<string>([node.id])
  let current = node.inputNodeId

  while (current !== null) {
    if (seen.has(current)) return true
    seen.add(current)
    current = all.find(entry => entry.id === current)?.inputNodeId ?? null
  }

  return false
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
  // ADR 0005. Required and unrecoverable, unlike every other field here: a
  // candidate that does not say which node made it cannot be drawn on the one
  // surface there is, and picking a node for it would be inventing provenance.
  if (typeof document.nodeId !== 'string' || document.nodeId === '') return null

  const seed = readSeed(document.seed)
  if (seed === null) return null

  return {
    modelId: document.modelId,
    nodeId: document.nodeId,
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
