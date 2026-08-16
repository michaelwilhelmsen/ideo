/**
 * The canvas, as React Flow needs to see it — and nothing more (ADR 0005).
 *
 * This module is the whole reason React Flow was chosen over an engine. It is a
 * **pure function of `EditorState`**: nodes and edges are derived here on every
 * render, React Flow is handed them as props, and the only thing it gives back
 * is a list of changes. Nothing on this side of the boundary stores a node, a
 * position or an edge — `project.json` already does, and a second copy is how
 * two documents drift apart.
 *
 * The translation runs one way for reads (project → flow) and the other for
 * writes (change → `EditorAction`), which is exactly the shape a controlled
 * renderer wants and exactly the shape a document engine cannot be given.
 *
 * **No geometry beyond a width.** A card's height is whatever its content comes
 * to, measured from the DOM by React Flow, because a card holds a prompt of any
 * length and a source card holds an upload row that a style card does not. The
 * earlier version declared the height as data and clipped nothing, so a long
 * prompt painted straight over the canvas. Layout constants that have to be
 * kept in step with markup by hand are a bug waiting for the next edit; the
 * browser already knows the answer.
 */

import type { Edge, Node, NodeChange } from '@xyflow/react'
import {
  nodeById,
  resolvedInputId,
  visibleGenerations,
  type EditorAction,
  type Project,
} from '@/lib/recipe'

/**
 * The card's width, and the column the whole layout is measured in.
 *
 * Sized by the **thumbnails**, not by the prompt: four candidates to a row is
 * how a run reads as one row, and at 360px that made each picture 76px, which is
 * too small to tell two models' takes on the same prompt apart. This is the
 * width at which a tile is worth looking at without the card becoming a wall.
 */
export const CARD_WIDTH = 520

/**
 * What a card is assumed to be until it has been measured.
 *
 * `initialHeight` rather than `height`: a real `height` would *override* the
 * measurement and put the clipping bug straight back. This only has to be
 * roughly right for the frame before the ResizeObserver reports, which is the
 * frame `fitView` reads.
 */
const CARD_INITIAL_HEIGHT = 260

export type DraftFlowNode = Node<{ nodeId: string }, 'draft'>
export type IdeoNode = DraftFlowNode

/**
 * The handles a card offers.
 *
 * A card has one target and one source of its own — and one **extra source per
 * candidate**, whose handle id is the generation's id. That is how a line can
 * start at a specific thumbnail while the thumbnail stays ordinary markup
 * inside the card: React Flow anchors an edge to a handle wherever the browser
 * put it, so the picture can be wired without the card having to know where its
 * pictures are.
 */
export const OUTPUT_HANDLE = 'out'
export const INPUT_HANDLE = 'in'

/**
 * Every node React Flow draws — one per draft, and nothing else.
 *
 * Candidates are markup inside their card rather than child nodes: they have no
 * position of their own worth storing, and as child nodes they forced the card
 * to declare a height so the grid could be placed under it.
 */
export function flowNodes(
  project: Project,
  selectedNodeId: string | null
): readonly IdeoNode[] {
  return project.nodes.map(node => ({
    id: node.id,
    type: 'draft' as const,
    position: node.position,
    data: { nodeId: node.id },
    // Width as style so the card is a column; height left to the measurement.
    style: { width: CARD_WIDTH },
    initialWidth: CARD_WIDTH,
    initialHeight: CARD_INITIAL_HEIGHT,
    selected: node.id === selectedNodeId,
    // Deletion goes through the card's own menu, which confirms and names the
    // count — a node takes its candidates with it (ADR 0005), and that is not
    // something a stray Backspace should be able to do.
    deletable: false,
  }))
}

/**
 * Every edge React Flow draws — one per wired node, no more.
 *
 * Anchored to the **candidate that would actually be consumed** where the ladder
 * resolves one and that picture is on screen, and to the input card's own handle
 * where it is not. That is the honest picture: a line leaving a specific
 * thumbnail says "this picture feeds that step", which is the question the
 * canvas exists to answer, and a line leaving the card says "whatever this step
 * settles on".
 *
 * A pin is drawn solid and animated, a follow dashed, because those are two
 * different promises about what the next run will consume.
 */
export function flowEdges(
  project: Project,
  showRejected: boolean
): readonly Edge[] {
  return project.nodes.flatMap((node): Edge[] => {
    if (node.inputNodeId === null) return []

    const resolved = resolvedInputId(project, node)
    const pinned =
      node.pinnedInputId !== null && node.pinnedInputId === resolved

    // Only a candidate the input card is actually drawing has a handle to
    // anchor to. A rejected one is absent from the DOM while `showRejected` is
    // off, and an edge pointing at a handle that does not exist falls back to
    // the node's origin — a line to the card's top-left corner. Asking the input
    // card for its own handle instead puts it where it would have pointed
    // anyway.
    //
    // The same question also settles whose card the candidate is on: a pin
    // survives a rewire (`pinNodeInput` is about a picture, `connectNodes` about
    // a step), so the two can disagree, and a handle belonging to another card
    // is one this edge's source node does not have.
    const input = nodeById(project, node.inputNodeId)
    const drawn =
      resolved !== null &&
      input !== null &&
      visibleGenerations(project, input, showRejected).some(
        g => g.id === resolved
      )

    return [
      {
        id: `${node.inputNodeId}->${node.id}`,
        source: node.inputNodeId,
        target: node.id,
        sourceHandle: drawn ? resolved : OUTPUT_HANDLE,
        targetHandle: INPUT_HANDLE,
        animated: pinned,
        style: pinned ? undefined : { strokeDasharray: '6 4' },
        deletable: true,
      },
    ]
  })
}

/**
 * What React Flow's change list means to the reducer.
 *
 * Deliberately lossy. React Flow reports dimension measurements and parent
 * expansions as well as real edits, and neither of those is a fact about the
 * project — so they are dropped rather than round-tripped into `project.json`.
 * What survives is the two things a user actually did:
 *
 * - **A drag.** Every frame of it, including the intermediate ones, and that is
 *   not an oversight. `nodes` is a pure derivation of the store, so a frame the
 *   reducer never sees is a frame the card does not move — the position has to
 *   go through the store for the drag to be visible at all. That is the cost of
 *   having exactly one copy of the graph, and it is cheap: one field on one
 *   node, and the manifest write behind it is already debounced to 600ms.
 * - **A selection.** Only selecting *on*: deselection arrives as a paired change
 *   when another node is clicked, and acting on it would clear the sidebar a
 *   frame before filling it again.
 *
 * Removals are absent because they cannot arrive: cards declare
 * `deletable: false` and deletion goes through the card's own menu, which
 * confirms and names what goes with it.
 */
export function actionsForNodeChanges(
  changes: readonly NodeChange<IdeoNode>[]
): readonly EditorAction[] {
  return changes.flatMap((change): EditorAction[] => {
    if (change.type === 'position' && change.position !== undefined) {
      return [
        { type: 'moveNode', nodeId: change.id, position: change.position },
      ]
    }

    if (change.type === 'select' && change.selected) {
      return [{ type: 'selectNode', nodeId: change.id }]
    }

    return []
  })
}

/**
 * What a finished connection drag means.
 *
 * Two requests wearing one gesture, told apart by **which handle it left**
 * (ADR 0005): from a candidate's handle it is "feed this step *that picture*",
 * so the edge is drawn and the candidate pinned in one go; from the card's own
 * handle it is "feed this step from that node", and which picture is left to the
 * ladder.
 *
 * Returned as actions rather than dispatched here so the whole translation stays
 * testable without a canvas — and so the reducer, not the drag, has the last
 * word on whether the edge is legal (`canConnect`).
 */
export function actionsForConnection(
  project: Project,
  source: string,
  target: string,
  sourceHandle: string | null
): readonly EditorAction[] {
  const connect: EditorAction = {
    type: 'connectNodes',
    sourceNodeId: source,
    targetNodeId: target,
  }

  const candidate =
    sourceHandle === null || sourceHandle === OUTPUT_HANDLE
      ? undefined
      : project.generations.find(g => g.id === sourceHandle)

  if (candidate === undefined) return [connect]

  return [
    connect,
    // After the edge, because `connectNodes` clears the old pin — writing this
    // first would have it cleared a line later.
    { type: 'pinNodeInput', nodeId: target, generationId: candidate.id },
  ]
}
