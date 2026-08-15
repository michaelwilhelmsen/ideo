/**
 * `blockedReasonKey` — the one place a stage says it cannot run, and why.
 *
 * Worth its own file because every answer here is a refusal that costs a
 * disabled button instead of a paid call. The animate cases are the expensive
 * ones: a ratio no video model accepts, a model that will not run without an end
 * frame nobody can supply yet, and a stage with no picture anywhere behind it.
 *
 * That last one used to be "nothing selected upstream", and the difference is
 * the point: a stage consumes any earlier candidate now, so the only thing left
 * to refuse is a project with nothing in it at all.
 *
 * And the other half of the same question, at the end: a project that never runs
 * the animate stage at all, which is a finished project rather than a blocked
 * one.
 */

import { describe, expect, it } from 'vitest'
import { ATLAS, LEDGER } from './fixtures'
import {
  blockedReasonKey,
  generationsForStage,
  resolvedInputId,
  selectedGeneration,
} from './selectors'
import type { Generation, Project, StageKind } from './types'

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
    expect(blockedReasonKey(ATLAS, 'source')).toBeNull()
    expect(blockedReasonKey(ATLAS, 'style')).toBeNull()
    expect(blockedReasonKey(ATLAS, 'animate')).toBeNull()
  })

  it('lets a stage run off an earlier one, rather than demanding the one before it', () => {
    // Ledger has a source and nothing else. Animate used to be blocked here —
    // "pick a styled still first" — which made the style stage mandatory for
    // anyone whose source came out right the first time. It now runs off the
    // source, which is what makes a stage skippable at all.
    expect(blockedReasonKey(LEDGER, 'style')).toBeNull()
    expect(blockedReasonKey(LEDGER, 'animate')).toBeNull()
    expect(resolvedInputId(LEDGER, 'animate')).toBe(LEDGER.selection.source)
  })

  it('falls back to the nearest stage with candidates, not the newest of any', () => {
    // Atlas has sources *and* styled stills. With the style selection cleared
    // and no pointer set, animate falls back — and the fallback must land on a
    // styled still, because style is the nearer stage.
    //
    // The bug this pins ranked by arrival across a flattened list instead, which
    // is the newest candidate of the *furthest* stage. It reads harmlessly and
    // is not: the clip would come out of a raw source, skipping the style pass
    // the user had already paid for, at video prices.
    const noStyleSelection: Project = {
      ...ATLAS,
      drafts: {
        ...ATLAS.drafts,
        animate: { ...ATLAS.drafts.animate, inputGenerationId: null },
      },
      selection: { ...ATLAS.selection, style: null },
    }

    const fallback = resolvedInputId(noStyleSelection, 'animate')

    expect(
      noStyleSelection.generations.find(g => g.id === fallback)?.stage
    ).toBe('style')
  })

  it('blocks a stage with no picture anywhere behind it', () => {
    // The refusal that is left, and it names a picture rather than a stage:
    // with nothing generated at all there is nothing to work from, whichever
    // stage you are standing on.
    const empty: Project = { ...LEDGER, generations: [] }

    expect(blockedReasonKey(empty, 'source')).toBeNull()
    expect(blockedReasonKey(empty, 'style')).toBe('editor.reason.needsInput')
    expect(blockedReasonKey(empty, 'animate')).toBe('editor.reason.needsInput')
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
      expect(
        blockedReasonKey(on(ATLAS, 'animate', modelId), 'animate')
      ).toBeNull()
    }
  })

  it('says nothing about an end frame on a model that does not demand one', () => {
    // Seedance has an `end_image_url` and does not require it, which is exactly
    // the distinction `endFrameRequired` exists to draw.
    const project = on(
      ATLAS,
      'animate',
      'bytedance/seedance-2.5/image-to-video'
    )

    expect(blockedReasonKey(project, 'animate')).toBeNull()
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

    expect(blockedReasonKey(project, 'animate')).toBe(
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
    expect(blockedReasonKey(stillOnly, 'animate')).toBeNull()
    expect(blockedReasonKey(stillOnly, 'style')).toBeNull()
  })
})

describe('what a skipped stage falls back to', () => {
  /**
   * Atlas with the style and animate candidates taken away, so animate has to
   * skip past an empty style stage to reach the sources — the shape of a
   * project whose source came out right the first time.
   */
  function sourcesOnly(
    verdicts: Partial<Record<string, Generation['verdict']>>,
    selected: string | null
  ): Project {
    return {
      ...ATLAS,
      generations: ATLAS.generations
        .filter(generation => generation.stage === 'source')
        .map(generation => ({
          ...generation,
          verdict: verdicts[generation.id] ?? 'unrated',
        })),
      drafts: {
        ...ATLAS.drafts,
        animate: { ...ATLAS.drafts.animate, inputGenerationId: null },
      },
      selection: { source: selected, style: null, animate: null },
    }
  }

  it('uses what the earlier stage is working from, not its newest candidate', () => {
    // The reported bug: twelve sources deep with the ninth selected and
    // previewed one tab over, animate offered to spend video money on the
    // twelfth. `selection` means "what this stage is working from" everywhere
    // else in the app, and skipping a stage must not throw that away.
    const project = sourcesOnly({}, 'gen-src-1')

    expect(resolvedInputId(project, 'animate')).toBe('gen-src-1')
  })

  it('prefers the newest approved one when nothing is selected', () => {
    // With no selection, a verdict is the only statement anyone has made about
    // these pictures, and "approved" is the one that means keep.
    const project = sourcesOnly({ 'gen-src-1': 'approved' }, null)

    expect(resolvedInputId(project, 'animate')).toBe('gen-src-1')
  })

  it('takes the newest of the rest when nothing is selected or approved', () => {
    // Where this started, and still right: an untriaged project animates the
    // last thing it made rather than refusing to run.
    const project = sourcesOnly({}, null)
    const sources = generationsForStage(project, 'source').filter(
      generation => generation.verdict !== 'rejected'
    )

    expect(resolvedInputId(project, 'animate')).toBe(sources.at(-1)?.id)
  })

  it('keeps honouring a selection that has since been rejected', () => {
    // Deliberately the same answer the *non*-skipped path gives: rejecting a
    // candidate does not move the selection off it, the stage's own tab goes on
    // previewing it (PRD §10.3 — a reject is a filter, not a tombstone), and
    // the skipped path disagreeing would put a different picture behind each of
    // two tabs. Choosing another one is a click in the working-from row.
    const project = sourcesOnly(
      { 'gen-src-1': 'rejected', 'gen-src-2': 'approved' },
      'gen-src-1'
    )

    expect(resolvedInputId(project, 'animate')).toBe('gen-src-1')
  })

  it('falls past a selection the project no longer holds', () => {
    // A hand-edited manifest, or a pointer left behind by an older build. A
    // stale id must not block the ladder any more than it blocks the one above.
    const project = sourcesOnly({ 'gen-src-2': 'approved' }, 'gen-src-gone')

    expect(resolvedInputId(project, 'animate')).toBe('gen-src-2')
  })
})
