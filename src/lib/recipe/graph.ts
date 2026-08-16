/**
 * The draft graph: what a node is made of, and which edges are legal (ADR 0005).
 *
 * Pure, and deliberately apart from `selectors.ts` — the questions here are
 * about the *shape* of the canvas (may this edge exist, where does a new node
 * go, what is a node called) rather than about what the recipes in it say.
 *
 * Nothing here mints an id. The reducer takes ids on the action so that "same
 * pinned seed, one changed fragment" is reproducible rather than approximately
 * reproducible (PRD §4.3), and a graph helper that called `randomUUID` would
 * quietly reintroduce the impurity through the back door.
 */

import { DEFAULT_MODEL_IDS } from './models'
import type {
  DraftNode,
  DraftRecipe,
  NodePosition,
  Project,
  StageKind,
} from './types'
import { needsInput } from './types'

/**
 * How many models one node may fan out to.
 *
 * A spending limit before it is a layout constraint, exactly like
 * `MAX_BATCH_SIZE`: four models at four candidates each is sixteen paid calls
 * behind one click, and that is as far as one click is allowed to go.
 */
export const MAX_MODELS_PER_NODE = 4

/**
 * The gap between a node and the one added downstream of it, in canvas units.
 *
 * Wide enough that the edge is visibly an edge rather than two cards touching,
 * and tall enough that a node with a full four-up of candidates does not sit on
 * top of its sibling.
 */
const NODE_SPACING = { x: 460, y: 320 } as const

/** An empty form, on one model, with nothing typed into it. */
export function blankDraft(modelId: string): DraftRecipe {
  return {
    modelIds: [modelId],
    prompt: '',
    presetId: null,
    presetModified: false,
    seed: { mode: 'roll' },
    params: {},
    options: {},
  }
}

/**
 * A new node of this kind, wired to `inputNodeId` where its kind takes an
 * input.
 *
 * The model comes from the registry (#25) rather than being written out at the
 * call site: a draft naming a model with no capability entry is a recipe
 * nothing can build a request for, and `modelById` would refuse it on the next
 * render.
 *
 * `batchSize` is the default for the kind, *copied* rather than referenced
 * (PRD §11) — raising a default later must not make an existing node's next
 * click cost four times as much.
 */
export function makeNode(
  id: string,
  kind: StageKind,
  position: NodePosition,
  inputNodeId: string | null,
  batchSize: number
): DraftNode {
  return {
    id,
    kind,
    title: null,
    position,
    draft: blankDraft(DEFAULT_MODEL_IDS[kind]),
    batchSize,
    inputNodeId: needsInput(kind) ? inputNodeId : null,
    pinnedInputId: null,
    pick: null,
  }
}

/**
 * Nullable in both arguments, because both are legitimately unknown at the call
 * site: a component asks for its node before it has ruled out "no project open",
 * and `selectedNodeId` is `null` whenever the canvas has nothing selected.
 * Widening here is cheaper than a guard at every caller, and it makes the two
 * absences read the same — there is no node either way.
 */
export function nodeById(
  project: Project | null,
  id: string | null
): DraftNode | null {
  if (project === null || id === null) return null
  return project.nodes.find(node => node.id === id) ?? null
}

/** Every node that consumes this one. */
export function downstreamOf(
  project: Project,
  nodeId: string
): readonly DraftNode[] {
  return project.nodes.filter(node => node.inputNodeId === nodeId)
}

/**
 * Every node this one consumes from, transitively — nearest first.
 *
 * A plain walk up `inputNodeId`, which is all it needs to be: a node has at
 * most one input, so the draft graph is a forest rather than a general DAG.
 * Guarded against a cycle anyway, because the manifest is untrusted input and a
 * hand-edited one can name anything.
 */
export function ancestorsOf(
  project: Project,
  nodeId: string
): readonly DraftNode[] {
  const seen = new Set<string>([nodeId])
  const chain: DraftNode[] = []

  let current = nodeById(project, nodeId)?.inputNodeId ?? null
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const node = nodeById(project, current)
    if (node === null) break
    chain.push(node)
    current = node.inputNodeId
  }

  return chain
}

/**
 * Whether `source` may feed `target`.
 *
 * Three rules, and the absence of a fourth is the point of ADR 0005: there is
 * no ordering on kinds any more, so a style node feeding another style node is
 * a restyle of a restyle rather than a rule violation.
 *
 * 1. The target has to consume a picture at all — a source node's models
 *    declare no image field, so an edge into one could never be sent.
 * 2. Both nodes have to exist. The action is reachable from a hand-edited
 *    manifest as well as from a drag.
 * 3. The target must not already be upstream of the source, which is the whole
 *    cycle check. Self-connection is the degenerate case of it.
 */
export function canConnect(
  project: Project,
  sourceNodeId: string,
  targetNodeId: string
): boolean {
  if (sourceNodeId === targetNodeId) return false

  const target = nodeById(project, targetNodeId)
  if (target === null || !needsInput(target.kind)) return false
  if (nodeById(project, sourceNodeId) === null) return false

  return !ancestorsOf(project, sourceNodeId).some(
    node => node.id === targetNodeId
  )
}

/**
 * Where to drop a node added downstream of `fromNodeId`.
 *
 * To the right of its input, and below any sibling already there — a second
 * branch off one node is the common move on this canvas (one source, three
 * styles), and dropping them all on the same coordinates would make the fan-out
 * look like a single node until the user dragged them apart.
 *
 * With no input to hang off, it goes below the lowest node on the canvas rather
 * than at the origin, so "add a source" twice does not stack.
 */
export function placeNode(
  project: Project,
  fromNodeId: string | null
): NodePosition {
  const from = nodeById(project, fromNodeId)

  if (from === null) {
    const lowest = project.nodes.reduce(
      (bottom, node) => Math.max(bottom, node.position.y),
      -NODE_SPACING.y
    )
    return { x: 0, y: lowest + NODE_SPACING.y }
  }

  const siblings = downstreamOf(project, from.id)
  return {
    x: from.position.x + NODE_SPACING.x,
    y: from.position.y + siblings.length * NODE_SPACING.y,
  }
}

/**
 * The models a node would run, held to what may actually be submitted.
 *
 * Never empty and never over the cap, because both are reachable from a
 * hand-edited manifest and both are expensive to get wrong in opposite
 * directions: an empty list is a run button that submits nothing, and an
 * uncapped one is a click that spends without a ceiling.
 */
export function heldModelIds(
  ids: readonly string[],
  fallback: string
): readonly string[] {
  const unique = [...new Set(ids.filter(id => id !== ''))]
  if (unique.length === 0) return [fallback]
  return unique.slice(0, MAX_MODELS_PER_NODE)
}
