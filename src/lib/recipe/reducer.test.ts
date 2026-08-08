/**
 * The claims in PRD §4.1 and §4.3, as assertions.
 *
 * These are not prototype scaffolding — the reducer outlives the fixture seam,
 * and "re-running style does not touch the source" is exactly the sort of
 * thing that quietly stops being true.
 */

import { describe, expect, it } from 'vitest'
import { createEditorReducer, type EditorAction } from './reducer'
import { FIXTURE_REGISTRY, initialEditorState } from './fixtures'
import {
  activeProject,
  generationsForStage,
  selectedGeneration,
  visibleGenerations,
} from './selectors'
import type { EditorState } from './types'

const reduce = createEditorReducer(FIXTURE_REGISTRY)

function apply(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(reduce, state)
}

function runOf(
  stage: 'source' | 'style' | 'animate',
  seed: number
): EditorAction {
  return {
    type: 'runStage',
    stage,
    runs: [{ id: `run-${stage}-${seed}`, seed }],
    at: 1,
  }
}

describe('stage independence (PRD §4.1)', () => {
  it('re-running style leaves the source generations untouched', () => {
    const before = activeProject(initialEditorState())
    const after = activeProject(apply(initialEditorState(), runOf('style', 42)))

    expect(generationsForStage(after, 'source')).toEqual(
      generationsForStage(before, 'source')
    )
    expect(generationsForStage(after, 'style')).toHaveLength(
      generationsForStage(before, 'style').length + 1
    )
  })

  it('re-running the source leaves existing style candidates alone', () => {
    const before = activeProject(initialEditorState())
    const after = activeProject(apply(initialEditorState(), runOf('source', 7)))

    expect(generationsForStage(after, 'style')).toEqual(
      generationsForStage(before, 'style')
    )
  })

  it('a new style generation records the source it actually consumed', () => {
    const state = apply(initialEditorState(), runOf('style', 42))
    const project = activeProject(state)
    const created = generationsForStage(project, 'style').at(-1)

    expect(created?.recipe.inputGenerationId).toBe('gen-src-2')
  })

  it('refuses to run a stage whose input has not been picked', () => {
    // The second project has no styled still, so animate has nothing to work from.
    const state = apply(
      initialEditorState(),
      { type: 'selectProject', projectId: 'project-ledger' },
      runOf('animate', 3)
    )

    expect(generationsForStage(activeProject(state), 'animate')).toHaveLength(0)
  })
})

describe('seeds (PRD §4.3)', () => {
  it('records the rolled seed so it can be pinned afterwards', () => {
    const state = apply(
      initialEditorState(),
      { type: 'unpinSeed', stage: 'style' },
      runOf('style', 1234)
    )

    expect(
      generationsForStage(activeProject(state), 'style').at(-1)?.seed
    ).toBe(1234)
  })

  it('a pinned seed wins over the rolled one, and collapses the batch to one', () => {
    const state = apply(initialEditorState(), {
      type: 'runStage',
      stage: 'style',
      runs: [
        { id: 'a', seed: 1 },
        { id: 'b', seed: 2 },
        { id: 'c', seed: 3 },
        { id: 'd', seed: 4 },
      ],
      at: 1,
    })

    const created = generationsForStage(activeProject(state), 'style').slice(3)
    expect(created).toHaveLength(1)
    // The fixture draft is pinned to this value.
    expect(created.at(0)?.seed).toBe(640_213_889)
  })

  it('drops the pin when the chosen model has no seed parameter', () => {
    const state = apply(
      initialEditorState(),
      { type: 'pinSeed', stage: 'animate', value: 99 },
      {
        type: 'chooseModel',
        stage: 'animate',
        modelId: 'fal-ai/kling-video/o1',
      }
    )

    expect(activeProject(state).drafts.animate.seed).toEqual({ mode: 'roll' })
  })

  it('records no seed at all for a model that has none', () => {
    const state = apply(initialEditorState(), runOf('animate', 5))
    expect(
      generationsForStage(activeProject(state), 'animate').at(-1)?.seed
    ).toBeNull()
  })
})

describe('candidates are kept, not deleted (PRD §10.3)', () => {
  it('rejecting hides a candidate from the strip but keeps the record', () => {
    const state = apply(initialEditorState(), {
      type: 'setVerdict',
      generationId: 'gen-sty-3',
      verdict: 'rejected',
    })
    const project = activeProject(state)

    expect(project.generations.some(g => g.id === 'gen-sty-3')).toBe(true)
    expect(
      visibleGenerations(project, 'style', false).map(g => g.id)
    ).not.toContain('gen-sty-3')
    expect(visibleGenerations(project, 'style', true).map(g => g.id)).toContain(
      'gen-sty-3'
    )
  })

  it('keeps the selected candidate visible even after rejecting it', () => {
    const state = apply(initialEditorState(), {
      type: 'setVerdict',
      generationId: 'gen-sty-2',
      verdict: 'rejected',
    })
    const project = activeProject(state)

    expect(
      visibleGenerations(project, 'style', false).map(g => g.id)
    ).toContain('gen-sty-2')
  })

  it('never reuses an ordinal, so "Style 3" keeps meaning one candidate', () => {
    const state = apply(
      initialEditorState(),
      { type: 'setVerdict', generationId: 'gen-sty-3', verdict: 'rejected' },
      runOf('style', 9)
    )

    const ordinals = generationsForStage(activeProject(state), 'style').map(
      g => g.ordinal
    )
    expect(ordinals).toEqual([1, 2, 3, 4])
  })
})

describe('the recipe is the artefact (PRD §1)', () => {
  it('freezes the draft onto the generation rather than referencing it', () => {
    const state = apply(initialEditorState(), runOf('style', 11), {
      type: 'setPrompt',
      stage: 'style',
      prompt: 'something else entirely',
    })

    const created = generationsForStage(activeProject(state), 'style').at(-1)
    expect(created?.recipe.prompt).toBe('restyle')
  })

  it('restoring a recipe also restores the input it was made from', () => {
    const state = apply(initialEditorState(), {
      type: 'restoreRecipe',
      generationId: 'gen-sty-1',
    })
    const project = activeProject(state)

    // gen-sty-1 was made from source 1, which is not what the stage was on.
    expect(project.selection.source).toBe('gen-src-1')
    expect(project.drafts.style.presetId).toBe('editorial-noir')
  })
})

describe('changing model (PRD §5, §6.3)', () => {
  it('replaces parameters the new model does not understand with our defaults', () => {
    const state = apply(initialEditorState(), {
      type: 'chooseModel',
      stage: 'style',
      modelId: 'fal-ai/qwen-image-2.0/edit',
    })

    const params = activeProject(state).drafts.style.params
    expect(params.strength).toBeUndefined()
    expect(params.negative_prompt).toBe('')
  })

  it('carries a parameter across when both models use the same field', () => {
    const state = apply(
      initialEditorState(),
      { type: 'setParam', stage: 'style', key: 'strength', value: 0.8 },
      {
        type: 'chooseModel',
        stage: 'style',
        modelId: 'fal-ai/flux-pro/kontext/image-to-image',
      }
    )

    expect(activeProject(state).drafts.style.params.strength).toBe(0.8)
  })
})

describe('selection', () => {
  it('selects the first candidate of a fresh run so the preview is never blank', () => {
    const state = apply(initialEditorState(), runOf('style', 77))
    expect(selectedGeneration(activeProject(state), 'style')?.id).toBe(
      'run-style-77'
    )
  })
})
