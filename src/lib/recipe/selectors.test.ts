/**
 * What a node would run from, and whether it could run at all.
 *
 * Rewritten rather than ported for ADR 0005, because the rules genuinely
 * changed. The old suite pinned an inference — "when the style stage is empty,
 * animate walks further upstream and finds a source" — that the canvas replaced
 * with an edge you draw. Porting those assertions would have kept testing a
 * behaviour that is now deliberately absent.
 *
 * What survives unchanged is the part that was always about candidates rather
 * than stages: the pick wins, then a verdict, then recency; a rejected candidate
 * stays honoured while it is in use; a stale pointer falls through instead of
 * blocking.
 */

import { describe, expect, it } from 'vitest'
import {
  ATLAS,
  ATLAS_ANIMATE_NODE,
  ATLAS_SOURCE_NODE,
  ATLAS_STYLE_NODE,
  LEDGER,
  LEDGER_SOURCE_NODE,
  fixtureNode,
  withFixtureDraft,
  withFixtureNode,
} from './fixtures'
import { canConnect, makeNode } from './graph'
import {
  blockedReasonKey,
  generationsForNode,
  pickedGeneration,
  resolvedInputId,
  runSizeFor,
} from './selectors'
import type { Generation, Project } from './types'

/** The same project with one node's fan-out swapped for a single model. */
function on(project: Project, nodeId: string, modelId: string): Project {
  return withFixtureDraft(project, nodeId, { modelIds: [modelId] })
}

describe('blockedReasonKey', () => {
  it('lets a node run when its input is there and its model can serve it', () => {
    for (const nodeId of [
      ATLAS_SOURCE_NODE,
      ATLAS_STYLE_NODE,
      ATLAS_ANIMATE_NODE,
    ]) {
      expect(blockedReasonKey(ATLAS, fixtureNode(ATLAS, nodeId))).toBeNull()
    }
  })

  it('tells a node wired to nothing apart from one whose input is empty', () => {
    // Two refusals with two different fixes, which is why they are two keys
    // (ADR 0005). Collapsing them into "needs an input" sent half the users to
    // the wrong control: one of them needs to draw an edge, the other needs to
    // press Generate on the node they already drew one to.
    const unwired = withFixtureNode(LEDGER, LEDGER_SOURCE_NODE, {})
    const dangling: Project = {
      ...unwired,
      nodes: [
        ...unwired.nodes,
        makeNode('node-new-style', 'style', { x: 0, y: 0 }, null, 4),
        makeNode('node-wired', 'style', { x: 0, y: 0 }, 'node-new-style', 4),
      ],
    }

    expect(
      blockedReasonKey(dangling, fixtureNode(dangling, 'node-new-style'))
    ).toBe('editor.reason.noInputNode')

    // Wired, but to a node that has produced nothing — so there *is* an edge
    // and still no picture.
    expect(
      blockedReasonKey(dangling, fixtureNode(dangling, 'node-wired'))
    ).toBe('editor.reason.needsInput')
  })

  it('never blocks a source node, which consumes nothing', () => {
    const empty: Project = { ...LEDGER, generations: [] }

    expect(
      blockedReasonKey(empty, fixtureNode(empty, LEDGER_SOURCE_NODE))
    ).toBeNull()
  })

  it('lets animate run on a model that will not run without an end frame', () => {
    // #29 blocked the whole run here, because there was no second frame to
    // send. #30 supplies one — the start still, again — so FLUX 3's and Veo's
    // first/last-frame endpoints are ordinary animate models that happen
    // always to loop, and the locked-on switch says so where the user can see
    // it rather than a disabled run button saying "pick another model".
    for (const modelId of [
      'blackforestlabs/flux-3/first-last-frame-to-video',
      'fal-ai/veo3.1/first-last-frame-to-video',
    ]) {
      const project = on(ATLAS, ATLAS_ANIMATE_NODE, modelId)
      expect(
        blockedReasonKey(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
      ).toBeNull()
    }
  })

  it('does not blame the model when the ratio is the problem', () => {
    // PRD §4.4 — the ratio was marked at creation for whether animation is
    // possible at all, and that answer comes first: a 3:2 project cannot animate
    // whichever model is selected, and saying "pick another model" would send
    // the user round a loop with no way out.
    const project = on(
      { ...ATLAS, aspect: '3:2' },
      ATLAS_ANIMATE_NODE,
      'blackforestlabs/flux-3/first-last-frame-to-video'
    )

    expect(
      blockedReasonKey(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe('editor.reason.aspectNotAnimatable')
  })
})

/**
 * PRD §4.1 — the steps are independent, so the last one is optional.
 *
 * A still is a finished thing on its own: plenty of projects want a poster and
 * nothing that moves, and #29 added a video step rather than a requirement to
 * use it. Pinned here because nothing else would notice if it stopped being
 * true — animating is a click that costs real money, and the way that regresses
 * is a project quietly reporting itself unfinished until someone pays for a clip
 * they never wanted.
 */
describe('a project that stops at the still', () => {
  /** Atlas with the animate node never run. */
  const stillOnly: Project = withFixtureNode(
    {
      ...ATLAS,
      generations: ATLAS.generations.filter(g => g.stage !== 'animate'),
    },
    ATLAS_ANIMATE_NODE,
    { pick: null }
  )

  it('keeps its chosen still, with nothing at animate to explain', () => {
    expect(
      pickedGeneration(stillOnly, fixtureNode(stillOnly, ATLAS_STYLE_NODE))?.id
    ).toBe('gen-sty-2')
    expect(generationsForNode(stillOnly, ATLAS_ANIMATE_NODE)).toEqual([])
    expect(
      pickedGeneration(stillOnly, fixtureNode(stillOnly, ATLAS_ANIMATE_NODE))
    ).toBeNull()
  })

  it('offers animation rather than demanding it', () => {
    // Not blocked — the input is there and the model can serve it — which is
    // the point: the step is available and skipped, not unavailable.
    for (const nodeId of [ATLAS_ANIMATE_NODE, ATLAS_STYLE_NODE]) {
      expect(
        blockedReasonKey(stillOnly, fixtureNode(stillOnly, nodeId))
      ).toBeNull()
    }
  })
})

/**
 * Skipping a step is now an **edge**, not an inference (ADR 0005).
 *
 * The old ladder ended by walking upstream past an empty stage on the user's
 * behalf, at video prices, guessing which picture they meant. This is the
 * replacement, and it is one assertion rather than five: wire animate straight
 * to source, and it consumes a source.
 */
describe('wiring past a step', () => {
  it('consumes whatever the node it is wired to has settled on', () => {
    const direct = withFixtureNode(ATLAS, ATLAS_ANIMATE_NODE, {
      inputNodeId: ATLAS_SOURCE_NODE,
      pinnedInputId: null,
    })

    expect(
      resolvedInputId(direct, fixtureNode(direct, ATLAS_ANIMATE_NODE))
    ).toBe(fixtureNode(direct, ATLAS_SOURCE_NODE).pick)
  })

  it('refuses an edge that would close a cycle', () => {
    // The one rule left on which edges may exist. There is no ordering on kinds
    // any more — a style node may feed another style node — so this is the whole
    // check, and it has to hold transitively rather than just for self-edges.
    expect(canConnect(ATLAS, ATLAS_SOURCE_NODE, ATLAS_ANIMATE_NODE)).toBe(true)
    expect(canConnect(ATLAS, ATLAS_STYLE_NODE, ATLAS_STYLE_NODE)).toBe(false)
    expect(canConnect(ATLAS, ATLAS_ANIMATE_NODE, ATLAS_STYLE_NODE)).toBe(false)
    expect(canConnect(ATLAS, ATLAS_ANIMATE_NODE, ATLAS_SOURCE_NODE)).toBe(false)
  })

  it('lets a style step feed another style step', () => {
    // A restyle of a restyle, which `upstreamStages` used to forbid for no
    // reason anybody could state once the pipeline stopped being a wizard.
    const project: Project = {
      ...ATLAS,
      nodes: [
        ...ATLAS.nodes,
        makeNode('node-second-style', 'style', { x: 0, y: 0 }, null, 4),
      ],
    }

    expect(canConnect(project, ATLAS_STYLE_NODE, 'node-second-style')).toBe(
      true
    )
  })
})

describe('which candidate of its input a node runs from', () => {
  /** Atlas's animate node wired to source, with the sources' verdicts set. */
  function offSources(
    verdicts: Partial<Record<string, Generation['verdict']>>,
    pick: string | null,
    pinned: string | null = null
  ): Project {
    const base: Project = {
      ...ATLAS,
      generations: ATLAS.generations
        .filter(generation => generation.stage === 'source')
        .map(generation => ({
          ...generation,
          verdict: verdicts[generation.id] ?? 'unrated',
        })),
    }

    return withFixtureNode(
      withFixtureNode(base, ATLAS_SOURCE_NODE, { pick }),
      ATLAS_ANIMATE_NODE,
      { inputNodeId: ATLAS_SOURCE_NODE, pinnedInputId: pinned, pick: null }
    )
  }

  it('takes the pin first, whatever the input node has settled on', () => {
    const project = offSources({}, 'gen-src-2', 'gen-src-1')

    expect(
      resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe('gen-src-1')
  })

  it('otherwise takes what the input node is working from', () => {
    // `pick` means "the candidate this node has settled on" everywhere in the
    // app, and following it is what makes choosing upstream feed everything
    // downstream without a second click per edge.
    const project = offSources({}, 'gen-src-1')

    expect(
      resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe('gen-src-1')
  })

  it('prefers the newest approved one when nothing is picked', () => {
    // With no pick, a verdict is the only statement anyone has made about these
    // pictures, and "approved" is the one that means keep.
    const project = offSources({ 'gen-src-1': 'approved' }, null)

    expect(
      resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe('gen-src-1')
  })

  it('takes the newest of the rest when nothing is picked or approved', () => {
    // An untriaged project runs off the last thing it made rather than refusing.
    const project = offSources({}, null)
    const sources = generationsForNode(project, ATLAS_SOURCE_NODE).filter(
      generation => generation.verdict !== 'rejected'
    )

    expect(
      resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe(sources.at(-1)?.id)
  })

  it('keeps honouring a pick that has since been rejected', () => {
    // A reject is a filter, not a tombstone (PRD §10.3): it takes a candidate
    // out of the pickers, and it must not silently repoint a node that is
    // already consuming it. Choosing another one is a click in the input row.
    const project = offSources(
      { 'gen-src-1': 'rejected', 'gen-src-2': 'approved' },
      'gen-src-1'
    )

    expect(
      resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
    ).toBe('gen-src-1')
  })

  it('falls past a pointer the project no longer holds', () => {
    // A hand-edited manifest, or a pointer left behind by an older build. A
    // stale id must not block the ladder at either rung.
    const stalePin = offSources({ 'gen-src-2': 'approved' }, null, 'gen-gone')
    const stalePick = offSources({ 'gen-src-2': 'approved' }, 'gen-gone')

    for (const project of [stalePin, stalePick]) {
      expect(
        resolvedInputId(project, fixtureNode(project, ATLAS_ANIMATE_NODE))
      ).toBe('gen-src-2')
    }
  })

  it('names nothing at all when the node is wired to nothing', () => {
    const unwired = withFixtureNode(ATLAS, ATLAS_ANIMATE_NODE, {
      inputNodeId: null,
      pinnedInputId: null,
    })

    expect(
      resolvedInputId(unwired, fixtureNode(unwired, ATLAS_ANIMATE_NODE))
    ).toBeNull()
  })
})

/**
 * What one click costs, which is the number the run button says out loud.
 *
 * The fan-out multiplies it, and the pinned seed collapses only the *batch* —
 * not the fan-out. Three models on one seed are three different pictures, which
 * is the comparison a pin exists to make.
 */
describe('runSizeFor', () => {
  const two = 'fal-ai/flux/dev/image-to-image'
  const three = 'fal-ai/qwen-image-2/edit'

  it('multiplies the batch by the number of models', () => {
    const project = withFixtureDraft(ATLAS, ATLAS_STYLE_NODE, {
      modelIds: [two, three],
      seed: { mode: 'roll' },
    })

    expect(
      runSizeFor({ ...fixtureNode(project, ATLAS_STYLE_NODE), batchSize: 3 })
    ).toBe(6)
  })

  it('collapses the batch on a pinned seed but keeps every model', () => {
    const project = withFixtureDraft(ATLAS, ATLAS_STYLE_NODE, {
      modelIds: [two, three],
      seed: { mode: 'pinned', value: 7 },
    })

    expect(
      runSizeFor({ ...fixtureNode(project, ATLAS_STYLE_NODE), batchSize: 4 })
    ).toBe(2)
  })
})
