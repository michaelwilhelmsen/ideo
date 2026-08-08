/**
 * The claims in PRD §4.1 and §4.3, as assertions.
 *
 * These are not prototype scaffolding — the reducer outlives the fixture seam,
 * and "re-running style does not touch the source" is exactly the sort of
 * thing that quietly stops being true.
 */

import { describe, expect, it } from 'vitest'
import {
  createEditorReducer,
  emptyEditorState,
  type EditorAction,
} from './reducer'
import {
  ATLAS,
  FIXTURE_REGISTRY,
  LEDGER,
  fixtureEditorState,
  summaryOf,
} from './fixtures'
import {
  activeProject,
  generationsForStage,
  selectedGeneration,
  visibleGenerations,
} from './selectors'
import type { EditorState, Project, StageRecipe } from './types'

const reduce = createEditorReducer(FIXTURE_REGISTRY)

/** The open project. Every test below has one, so an empty editor is a failure. */
function openProjectOf(state: EditorState): Project {
  const project = activeProject(state)
  if (project === null) throw new Error('nothing is open')
  return project
}

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
    runs: [{ id: `run-${stage}-${seed}`, seed, asset: null }],
    at: 1,
  }
}

describe('stage independence (PRD §4.1)', () => {
  it('re-running style leaves the source generations untouched', () => {
    const before = openProjectOf(fixtureEditorState())
    const after = openProjectOf(apply(fixtureEditorState(), runOf('style', 42)))

    expect(generationsForStage(after, 'source')).toEqual(
      generationsForStage(before, 'source')
    )
    expect(generationsForStage(after, 'style')).toHaveLength(
      generationsForStage(before, 'style').length + 1
    )
  })

  it('re-running the source leaves existing style candidates alone', () => {
    const before = openProjectOf(fixtureEditorState())
    const after = openProjectOf(apply(fixtureEditorState(), runOf('source', 7)))

    expect(generationsForStage(after, 'style')).toEqual(
      generationsForStage(before, 'style')
    )
  })

  it('a new style generation records the source it actually consumed', () => {
    const state = apply(fixtureEditorState(), runOf('style', 42))
    const project = openProjectOf(state)
    const created = generationsForStage(project, 'style').at(-1)

    expect(created?.recipe.inputGenerationId).toBe('gen-src-2')
  })

  it('refuses to run a stage whose input has not been picked', () => {
    // The second project has no styled still, so animate has nothing to work from.
    const state = apply(
      fixtureEditorState(),
      { type: 'openProject', project: LEDGER, directory: '/tmp/ledger' },
      runOf('animate', 3)
    )

    expect(generationsForStage(openProjectOf(state), 'animate')).toHaveLength(0)
  })
})

describe('seeds (PRD §4.3)', () => {
  it('records the rolled seed so it can be pinned afterwards', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'unpinSeed', stage: 'style' },
      runOf('style', 1234)
    )

    expect(
      generationsForStage(openProjectOf(state), 'style').at(-1)?.seed
    ).toBe(1234)
  })

  it('a pinned seed wins over the rolled one, and collapses the batch to one', () => {
    const state = apply(fixtureEditorState(), {
      type: 'runStage',
      stage: 'style',
      runs: [
        { id: 'a', seed: 1, asset: null },
        { id: 'b', seed: 2, asset: null },
        { id: 'c', seed: 3, asset: null },
        { id: 'd', seed: 4, asset: null },
      ],
      at: 1,
    })

    const created = generationsForStage(openProjectOf(state), 'style').slice(3)
    expect(created).toHaveLength(1)
    // The fixture draft is pinned to this value.
    expect(created.at(0)?.seed).toBe(640_213_889)
  })

  it('drops the pin when the chosen model has no seed parameter', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'pinSeed', stage: 'animate', value: 99 },
      {
        type: 'chooseModel',
        stage: 'animate',
        modelId: 'fal-ai/kling-video/o1',
      }
    )

    expect(openProjectOf(state).drafts.animate.seed).toEqual({ mode: 'roll' })
  })

  it('records no seed at all for a model that has none', () => {
    const state = apply(fixtureEditorState(), runOf('animate', 5))
    expect(
      generationsForStage(openProjectOf(state), 'animate').at(-1)?.seed
    ).toBeNull()
  })
})

describe('candidates are kept, not deleted (PRD §10.3)', () => {
  it('rejecting hides a candidate from the strip but keeps the record', () => {
    const state = apply(fixtureEditorState(), {
      type: 'setVerdict',
      generationId: 'gen-sty-3',
      verdict: 'rejected',
    })
    const project = openProjectOf(state)

    expect(project.generations.some(g => g.id === 'gen-sty-3')).toBe(true)
    expect(
      visibleGenerations(project, 'style', false).map(g => g.id)
    ).not.toContain('gen-sty-3')
    expect(visibleGenerations(project, 'style', true).map(g => g.id)).toContain(
      'gen-sty-3'
    )
  })

  it('keeps the selected candidate visible even after rejecting it', () => {
    const state = apply(fixtureEditorState(), {
      type: 'setVerdict',
      generationId: 'gen-sty-2',
      verdict: 'rejected',
    })
    const project = openProjectOf(state)

    expect(
      visibleGenerations(project, 'style', false).map(g => g.id)
    ).toContain('gen-sty-2')
  })

  it('never reuses an ordinal, so "Style 3" keeps meaning one candidate', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'setVerdict', generationId: 'gen-sty-3', verdict: 'rejected' },
      runOf('style', 9)
    )

    const ordinals = generationsForStage(openProjectOf(state), 'style').map(
      g => g.ordinal
    )
    expect(ordinals).toEqual([1, 2, 3, 4])
  })
})

describe('the recipe is the artefact (PRD §1)', () => {
  it('freezes the draft onto the generation rather than referencing it', () => {
    const state = apply(fixtureEditorState(), runOf('style', 11), {
      type: 'setPrompt',
      stage: 'style',
      prompt: 'something else entirely',
    })

    const created = generationsForStage(openProjectOf(state), 'style').at(-1)
    expect(created?.recipe.prompt).toBe('restyle')
  })

  it('restoring a recipe also restores the input it was made from', () => {
    const state = apply(fixtureEditorState(), {
      type: 'restoreRecipe',
      generationId: 'gen-sty-1',
    })
    const project = openProjectOf(state)

    // gen-sty-1 was made from source 1, which is not what the stage was on.
    expect(project.selection.source).toBe('gen-src-1')
    expect(project.drafts.style.presetId).toBe('editorial-noir')
  })
})

describe('changing model (PRD §5, §6.3)', () => {
  it('replaces parameters the new model does not understand with our defaults', () => {
    const state = apply(fixtureEditorState(), {
      type: 'chooseModel',
      stage: 'style',
      modelId: 'fal-ai/qwen-image-2.0/edit',
    })

    const params = openProjectOf(state).drafts.style.params
    expect(params.strength).toBeUndefined()
    expect(params.negative_prompt).toBe('')
  })

  it('carries a parameter across when both models use the same field', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'setParam', stage: 'style', key: 'strength', value: 0.8 },
      {
        type: 'chooseModel',
        stage: 'style',
        modelId: 'fal-ai/flux-pro/kontext/image-to-image',
      }
    )

    expect(openProjectOf(state).drafts.style.params.strength).toBe(0.8)
  })
})

describe('opening projects off disk (#23)', () => {
  it('starts with nothing open, because the library is on disk', () => {
    const state = emptyEditorState()
    expect(activeProject(state)).toBeNull()
    expect(state.summaries).toEqual([])
  })

  it('opens a loaded manifest, and remembers where it came from', () => {
    const state = apply(emptyEditorState(), {
      type: 'openProject',
      project: ATLAS,
      directory: '/projects/atlas',
    })

    expect(openProjectOf(state).id).toBe(ATLAS.id)
    expect(state.directory).toBe('/projects/atlas')
  })

  it('opens on the furthest stage the project has reached', () => {
    // Opening Ledger — which has only a source — on the animate tab would show
    // a stage that cannot run, for a project the user has just opened.
    expect(
      apply(emptyEditorState(), {
        type: 'openProject',
        project: LEDGER,
        directory: '/projects/ledger',
      }).activeStage
    ).toBe('source')

    expect(
      apply(emptyEditorState(), {
        type: 'openProject',
        project: ATLAS,
        directory: '/projects/atlas',
      }).activeStage
    ).toBe('animate')
  })

  it('closes back to nothing, rather than to a stale project', () => {
    const state = apply(fixtureEditorState(), { type: 'closeProject' })
    expect(activeProject(state)).toBeNull()
    expect(state.directory).toBeNull()
  })

  it('ignores an edit that arrives with nothing open', () => {
    const state = apply(emptyEditorState(), {
      type: 'setPrompt',
      stage: 'source',
      prompt: 'into the void',
    })
    expect(activeProject(state)).toBeNull()
  })

  it('takes the project list from the index without opening anything', () => {
    const state = apply(emptyEditorState(), {
      type: 'setSummaries',
      summaries: [summaryOf(ATLAS)],
    })

    expect(state.summaries.map(s => s.id)).toEqual([ATLAS.id])
    expect(activeProject(state)).toBeNull()
  })
})

describe('a generation records the file it produced (#23)', () => {
  it('carries the asset the model call actually wrote', () => {
    const state = apply(fixtureEditorState(), {
      type: 'runStage',
      stage: 'source',
      runs: [{ id: 'run-real', seed: 5, asset: 'run-real.jpeg' }],
      at: 1,
    })

    const created = generationsForStage(openProjectOf(state), 'source').at(-1)
    expect(created?.asset).toBe('run-real.jpeg')
  })

  it('leaves the asset null for a stage with no model call behind it yet', () => {
    const state = apply(fixtureEditorState(), runOf('style', 3))
    expect(
      generationsForStage(openProjectOf(state), 'style').at(-1)?.asset
    ).toBeNull()
  })
})

describe('selection', () => {
  it('selects the first candidate of a fresh run so the preview is never blank', () => {
    const state = apply(fixtureEditorState(), runOf('style', 77))
    expect(selectedGeneration(openProjectOf(state), 'style')?.id).toBe(
      'run-style-77'
    )
  })
})

describe('collecting a job that outlived its click (#24)', () => {
  /** A finished job, as the store hands it back. */
  function collected(
    id: string,
    recipe: Partial<StageRecipe> = {}
  ): EditorAction {
    return {
      type: 'recordGenerations',
      entries: [
        {
          id,
          stage: 'source',
          recipe: {
            modelId: 'fal-ai/flux-pro/v1.1',
            prompt: 'the prompt as it was when this was submitted',
            presetId: null,
            seed: { mode: 'roll' },
            params: {},
            options: {},
            inputGenerationId: null,
            ...recipe,
          },
          seed: 4242,
          asset: `${id}.jpeg`,
        },
      ],
      at: 99,
    }
  }

  it('records the recipe the job carried, not whatever the draft says now', () => {
    // The point of freezing a recipe at submit: by the time a resumed job
    // lands, the sidebar has moved on, and a generation that adopted the
    // current draft would describe the wrong image (PRD §1).
    const state = apply(
      fixtureEditorState(),
      { type: 'setPrompt', stage: 'source', prompt: 'something else entirely' },
      collected('job-1')
    )

    const created = generationsForStage(openProjectOf(state), 'source').at(-1)
    expect(created?.recipe.prompt).toBe(
      'the prompt as it was when this was submitted'
    )
    expect(created?.seed).toBe(4242)
    expect(created?.asset).toBe('job-1.jpeg')
  })

  it('ignores a job it has already recorded', () => {
    // A settled event and the sweep that covers the events a quit lost can
    // both deliver the same job, and it has only been paid for once.
    const once = apply(fixtureEditorState(), collected('job-1'))
    const twice = apply(once, collected('job-1'))

    expect(generationsForStage(openProjectOf(twice), 'source')).toHaveLength(
      generationsForStage(openProjectOf(once), 'source').length
    )
    expect(openProjectOf(twice)).toBe(openProjectOf(once))
  })

  it('numbers a collected candidate after the ones already in the stage', () => {
    const before = generationsForStage(
      openProjectOf(fixtureEditorState()),
      'source'
    )
    const state = apply(fixtureEditorState(), collected('job-1'))

    expect(
      generationsForStage(openProjectOf(state), 'source').at(-1)?.ordinal
    ).toBe(before.length + 1)
  })

  it('selects what arrived, because it is what the user was waiting for', () => {
    const state = apply(fixtureEditorState(), collected('job-1'))
    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-1')
  })

  it('records nothing at all when the batch has already been collected', () => {
    const state = apply(fixtureEditorState(), {
      type: 'recordGenerations',
      entries: [],
      at: 1,
    })

    expect(openProjectOf(state)).toBe(openProjectOf(fixtureEditorState()))
  })
})
