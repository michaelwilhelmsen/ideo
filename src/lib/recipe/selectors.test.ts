/**
 * `blockedReasonKey` — the one place a stage says it cannot run, and why.
 *
 * Worth its own file because every answer here is a refusal that costs a
 * disabled button instead of a paid call. The animate cases are the expensive
 * ones: a ratio no video model accepts, a model that will not run without an end
 * frame nobody can supply yet, and a stage with nothing selected upstream.
 *
 * And the other half of the same question, at the end: a project that never runs
 * the animate stage at all, which is a finished project rather than a blocked
 * one.
 */

import { describe, expect, it } from 'vitest'
import { ATLAS, LEDGER } from './fixtures'
import { MODEL_REGISTRY } from './models'
import {
  blockedReasonKey,
  generationsForStage,
  selectedGeneration,
} from './selectors'
import type { Project, StageKind } from './types'

/** The same project with one stage's model swapped. */
function on(project: Project, stage: StageKind, modelId: string): Project {
  return {
    ...project,
    drafts: {
      ...project.drafts,
      [stage]: { ...project.drafts[stage], modelId },
    },
  }
}

describe('blockedReasonKey', () => {
  it('lets a stage run when its input is there and its model can serve it', () => {
    expect(blockedReasonKey(MODEL_REGISTRY, ATLAS, 'source')).toBeNull()
    expect(blockedReasonKey(MODEL_REGISTRY, ATLAS, 'style')).toBeNull()
    expect(blockedReasonKey(MODEL_REGISTRY, ATLAS, 'animate')).toBeNull()
  })

  it('blocks a stage with nothing selected upstream', () => {
    // Ledger has a source and nothing else, so style can run and animate cannot.
    expect(blockedReasonKey(MODEL_REGISTRY, LEDGER, 'style')).toBeNull()
    expect(blockedReasonKey(MODEL_REGISTRY, LEDGER, 'animate')).toBe(
      'editor.reason.needs.style'
    )
  })

  it('blocks animate on a model that will not run without an end frame', () => {
    // #29 — FLUX 3's first/last-frame endpoint requires both, and this slice has
    // only a start frame. Said here, it costs a disabled button; said at submit,
    // it costs the video call.
    const project = on(
      ATLAS,
      'animate',
      'blackforestlabs/flux-3/first-last-frame-to-video'
    )

    expect(blockedReasonKey(MODEL_REGISTRY, project, 'animate')).toBe(
      'editor.reason.needsEndFrame'
    )
  })

  it('says nothing about an end frame on a model that does not demand one', () => {
    // Seedance has an `end_image_url` and does not require it, which is exactly
    // the distinction `endFrameRequired` exists to draw.
    const project = on(
      ATLAS,
      'animate',
      'bytedance/seedance-2.5/image-to-video'
    )

    expect(blockedReasonKey(MODEL_REGISTRY, project, 'animate')).toBeNull()
  })

  it('does not blame the model when the ratio is the problem', () => {
    // PRD §4.4 — the ratio was marked at creation for whether animation is
    // possible at all, and that answer comes first: a 3:2 project cannot animate
    // whichever model is selected, and saying "pick another model" would send
    // the user round a loop with no way out.
    const project = on(
      { ...ATLAS, aspect: '3:2' },
      'animate',
      'blackforestlabs/flux-3/first-last-frame-to-video'
    )

    expect(blockedReasonKey(MODEL_REGISTRY, project, 'animate')).toBe(
      'editor.reason.aspectNotAnimatable'
    )
  })
})

/**
 * PRD §4.1 — the three stages are independent, so the third one is optional.
 *
 * A still is a finished thing on its own: plenty of projects want a poster and
 * nothing that moves, and #29 added a video stage rather than a requirement to
 * use it. Pinned here because nothing else would notice if it stopped being
 * true — animating is a click that costs real money, and the way that regresses
 * is a project quietly reporting itself unfinished until someone pays for a clip
 * they never wanted.
 */
describe('a project that stops at the still', () => {
  /** Atlas with the animate stage never run. */
  const stillOnly: Project = {
    ...ATLAS,
    selection: { ...ATLAS.selection, animate: null },
    generations: ATLAS.generations.filter(g => g.stage !== 'animate'),
  }

  it('keeps its chosen still, with nothing at animate to explain', () => {
    expect(selectedGeneration(stillOnly, 'style')?.id).toBe('gen-sty-2')
    expect(generationsForStage(stillOnly, 'animate')).toEqual([])
    expect(selectedGeneration(stillOnly, 'animate')).toBeNull()
  })

  it('offers animation rather than demanding it', () => {
    // Not blocked — the input is there and the model can serve it — which is
    // the point: the stage is available and skipped, not unavailable.
    expect(blockedReasonKey(MODEL_REGISTRY, stillOnly, 'animate')).toBeNull()
    expect(blockedReasonKey(MODEL_REGISTRY, stillOnly, 'style')).toBeNull()
  })
})
