/**
 * The translation layer, on its own (ADR 0005).
 *
 * Worth testing without a canvas because it is the whole of what React Flow is
 * allowed to know: nodes and edges out, actions back. Everything here is a pure
 * function, so the assertions are about *shape* — which handle an edge leaves,
 * what a drag from a thumbnail means — rather than about pixels.
 */

import { describe, expect, it } from 'vitest'
import {
  ATLAS,
  ATLAS_ANIMATE_NODE,
  ATLAS_SOURCE_NODE,
  ATLAS_STYLE_NODE,
} from '../../lib/recipe/fixtures'
import type { Project } from '@/lib/recipe'
import {
  actionsForConnection,
  actionsForNodeChanges,
  flowEdges,
  flowNodes,
  OUTPUT_HANDLE,
} from './flow-graph'

function edgeInto(project: Project, nodeId: string, showRejected = false) {
  return flowEdges(project, showRejected).find(edge => edge.target === nodeId)
}

describe('flowNodes', () => {
  it('draws one node per draft and leaves the height to the browser', () => {
    const nodes = flowNodes(ATLAS, null)

    expect(nodes.map(node => node.id)).toEqual(ATLAS.nodes.map(n => n.id))
    // A declared `height` would override the measurement, which is how a card
    // came to be shorter than its own prompt.
    for (const node of nodes) {
      expect(node.height).toBeUndefined()
      expect(node.initialHeight).toBeGreaterThan(0)
    }
  })
})

describe('flowEdges', () => {
  it('leaves the handle of the candidate that would actually be consumed', () => {
    // The style node's input resolves to the source node's pick, so the line
    // starts at that thumbnail rather than at the card — "this picture feeds
    // that step" is the question the canvas exists to answer.
    expect(edgeInto(ATLAS, ATLAS_STYLE_NODE)).toMatchObject({
      source: ATLAS_SOURCE_NODE,
      sourceHandle: 'gen-src-2',
    })
  })

  it('falls back to the card when that candidate is not on screen', () => {
    // A rejected candidate is absent from the DOM while `showRejected` is off,
    // and an edge aimed at a handle that does not exist collapses to the node's
    // top-left corner.
    const project: Project = {
      ...ATLAS,
      generations: ATLAS.generations.map(g =>
        g.id === 'gen-src-2' ? { ...g, verdict: 'rejected' as const } : g
      ),
      nodes: ATLAS.nodes.map(node =>
        node.id === ATLAS_SOURCE_NODE ? { ...node, pick: null } : node
      ),
    }

    const edge = edgeInto(project, ATLAS_STYLE_NODE)
    expect(edge?.source).toBe(ATLAS_SOURCE_NODE)
    expect(edge?.sourceHandle).not.toBe('gen-src-2')
  })

  it('draws a pin solid and a follow dashed', () => {
    const pinned: Project = {
      ...ATLAS,
      nodes: ATLAS.nodes.map(node =>
        node.id === ATLAS_STYLE_NODE
          ? { ...node, pinnedInputId: 'gen-src-1' }
          : node
      ),
    }

    expect(edgeInto(pinned, ATLAS_STYLE_NODE)?.animated).toBe(true)
    expect(edgeInto(ATLAS, ATLAS_STYLE_NODE)?.animated).toBe(false)
    expect(edgeInto(ATLAS, ATLAS_STYLE_NODE)?.style).toMatchObject({
      strokeDasharray: expect.any(String),
    })
  })

  it('draws nothing into a node that is wired to nothing', () => {
    const loose: Project = {
      ...ATLAS,
      nodes: ATLAS.nodes.map(node =>
        node.id === ATLAS_ANIMATE_NODE
          ? { ...node, inputNodeId: null, pinnedInputId: null }
          : node
      ),
    }

    expect(edgeInto(loose, ATLAS_ANIMATE_NODE)).toBeUndefined()
  })
})

describe('actionsForConnection', () => {
  it('pins the picture when the drag left a candidate handle', () => {
    expect(
      actionsForConnection(
        ATLAS,
        ATLAS_SOURCE_NODE,
        ATLAS_ANIMATE_NODE,
        'gen-src-1'
      )
    ).toEqual([
      {
        type: 'connectNodes',
        sourceNodeId: ATLAS_SOURCE_NODE,
        targetNodeId: ATLAS_ANIMATE_NODE,
      },
      // After the edge: `connectNodes` clears the old pin, so the other order
      // would have this cleared a line later.
      {
        type: 'pinNodeInput',
        nodeId: ATLAS_ANIMATE_NODE,
        generationId: 'gen-src-1',
      },
    ])
  })

  it('leaves the choice to the ladder when the drag left the card', () => {
    expect(
      actionsForConnection(
        ATLAS,
        ATLAS_SOURCE_NODE,
        ATLAS_ANIMATE_NODE,
        OUTPUT_HANDLE
      )
    ).toEqual([
      {
        type: 'connectNodes',
        sourceNodeId: ATLAS_SOURCE_NODE,
        targetNodeId: ATLAS_ANIMATE_NODE,
      },
    ])
  })
})

describe('actionsForNodeChanges', () => {
  it('forwards every frame of a drag', () => {
    expect(
      actionsForNodeChanges([
        { id: ATLAS_STYLE_NODE, type: 'position', position: { x: 5, y: 6 } },
        { id: ATLAS_STYLE_NODE, type: 'position', position: { x: 7, y: 8 } },
      ])
    ).toEqual([
      { type: 'moveNode', nodeId: ATLAS_STYLE_NODE, position: { x: 5, y: 6 } },
      { type: 'moveNode', nodeId: ATLAS_STYLE_NODE, position: { x: 7, y: 8 } },
    ])
  })

  it('ignores deselection, so the sidebar does not blink on a click-through', () => {
    expect(
      actionsForNodeChanges([
        { id: ATLAS_SOURCE_NODE, type: 'select', selected: false },
        { id: ATLAS_STYLE_NODE, type: 'select', selected: true },
      ])
    ).toEqual([{ type: 'selectNode', nodeId: ATLAS_STYLE_NODE }])
  })

  it('drops the measurements React Flow reports about itself', () => {
    expect(
      actionsForNodeChanges([
        {
          id: ATLAS_STYLE_NODE,
          type: 'dimensions',
          dimensions: { width: 520, height: 400 },
        },
      ])
    ).toEqual([])
  })
})
