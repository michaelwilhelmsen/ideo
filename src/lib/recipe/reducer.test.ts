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
  type CompletedRun,
  type EditorAction,
} from './reducer'
import { ATLAS, LEDGER, fixtureEditorState, summaryOf } from './fixtures'
import { MODEL_REGISTRY } from './models'
import { UPLOAD_MODEL_ID, isUploadRecipe, uploadFileName } from './upload'
import {
  activeProject,
  batchSizeFor,
  configuredBatchSize,
  generationsForStage,
  runGroups,
  selectedGeneration,
  visibleGenerations,
} from './selectors'
import type { EditorState, Project, StageRecipe } from './types'

const reduce = createEditorReducer(MODEL_REGISTRY)

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
    runs: [{ id: `run-${stage}-${seed}`, seed, asset: null, runId: null }],
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
        { id: 'a', seed: 1, asset: null, runId: 'run-1' },
        { id: 'b', seed: 2, asset: null, runId: 'run-1' },
        { id: 'c', seed: 3, asset: null, runId: 'run-1' },
        { id: 'd', seed: 4, asset: null, runId: 'run-1' },
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
        modelId: 'fal-ai/kling-video/o1/image-to-video',
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
      modelId: 'fal-ai/qwen-image-2/edit',
    })

    // The draft was on FLUX.1 dev, whose `strength` Qwen has never heard of.
    const params = openProjectOf(state).drafts.style.params
    expect(params.strength).toBeUndefined()
    expect(params.negative_prompt).toBe('')
  })

  it('carries a parameter across when both models use the same field', () => {
    const state = apply(
      fixtureEditorState(),
      {
        type: 'chooseModel',
        stage: 'style',
        modelId: 'fal-ai/qwen-image-2/edit',
      },
      {
        type: 'setParam',
        stage: 'style',
        key: 'negative_prompt',
        value: 'blurry',
      },
      {
        type: 'chooseModel',
        stage: 'style',
        modelId: 'fal-ai/qwen-image-2/pro/edit',
      }
    )

    expect(openProjectOf(state).drafts.style.params.negative_prompt).toBe(
      'blurry'
    )
  })

  it('never changes the model because a control was touched', () => {
    // PRD §10.1 — "never auto-switch the user's model when they toggle a
    // control. Helpfulness that spends money is not helpful." Every control the
    // panel offers goes through one of these actions.
    const before = fixtureEditorState()
    const chosen = openProjectOf(before).drafts.animate.modelId

    const after = apply(
      before,
      { type: 'setParam', stage: 'animate', key: 'duration', value: '10' },
      { type: 'setOption', stage: 'animate', key: 'loop', value: true },
      { type: 'setOption', stage: 'animate', key: 'rewind', value: true },
      { type: 'setPrompt', stage: 'animate', prompt: 'a slow drift' },
      { type: 'choosePreset', stage: 'animate', presetId: 'slow-drift' },
      { type: 'pinSeed', stage: 'animate', value: 7 },
      { type: 'unpinSeed', stage: 'animate' }
    )

    expect(openProjectOf(after).drafts.animate.modelId).toBe(chosen)
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
      runs: [{ id: 'run-real', seed: 5, asset: 'run-real.jpeg', runId: null }],
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
          runId: null,
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

describe('an image the user brought in (#27)', () => {
  function uploaded(id = 'upload-1'): EditorAction {
    return {
      type: 'recordUpload',
      generationId: id,
      asset: `${id}.png`,
      fileName: 'hero-plate.png',
      at: 7,
    }
  }

  it('records the upload as an ordinary source candidate', () => {
    const before = generationsForStage(
      openProjectOf(fixtureEditorState()),
      'source'
    )
    const project = openProjectOf(apply(fixtureEditorState(), uploaded()))
    const sources = generationsForStage(project, 'source')

    expect(sources).toHaveLength(before.length + 1)

    const upload = sources.at(-1)
    expect(upload?.stage).toBe('source')
    expect(upload?.asset).toBe('upload-1.png')
    // Numbered in the same sequence as everything else in the stage, so
    // "Source 3" keeps meaning one candidate whatever produced it.
    expect(upload?.ordinal).toBe(before.length + 1)
    expect(upload?.verdict).toBe('unrated')
  })

  it('is what every downstream selector sees, exactly as a generation is', () => {
    // The acceptance criterion of #27, as an assertion: nothing here asks
    // whether the pixels were generated.
    const project = openProjectOf(apply(fixtureEditorState(), uploaded()))

    expect(selectedGeneration(project, 'source')?.id).toBe('upload-1')
    expect(visibleGenerations(project, 'source', false).at(-1)?.id).toBe(
      'upload-1'
    )

    const styled = openProjectOf(
      apply(fixtureEditorState(), uploaded(), runOf('style', 42))
    )
    const style = generationsForStage(styled, 'style').at(-1)
    expect(style?.recipe.inputGenerationId).toBe('upload-1')
  })

  it('marks itself as an upload rather than claiming a model made it', () => {
    const project = openProjectOf(apply(fixtureEditorState(), uploaded()))
    const upload = generationsForStage(project, 'source').at(-1)

    if (upload === undefined) throw new Error('the upload was not recorded')

    expect(upload.recipe.modelId).toBe(UPLOAD_MODEL_ID)
    expect(isUploadRecipe(upload.recipe)).toBe(true)
    // Nothing produced it, so there is no seed to pin — the honest null.
    expect(upload.seed).toBeNull()
    expect(uploadFileName(upload.recipe)).toBe('hero-plate.png')
  })

  it('refuses to load an upload back into the draft, because it names no model', () => {
    // The draft is what a re-run would submit, and `modelById` throws on an id
    // with no registry entry — a restored upload would break the panel.
    const state = apply(fixtureEditorState(), uploaded())
    const before = openProjectOf(state).drafts.source

    const after = apply(state, {
      type: 'restoreRecipe',
      generationId: 'upload-1',
    })

    expect(openProjectOf(after).drafts.source).toEqual(before)
  })

  it('records the same upload once, however many times it arrives', () => {
    const once = apply(fixtureEditorState(), uploaded())
    const twice = apply(once, uploaded())

    expect(openProjectOf(twice)).toBe(openProjectOf(once))
  })
})

/**
 * Four candidates from one click, and one of them kept (#26, PRD §4.2).
 *
 * The batch is only worth paying for if the choice between candidates is real,
 * and that is a claim about two things the reducer owns: the candidates know
 * which click made them, and a choice made during the run is not taken back by
 * the rest of the run arriving.
 */
describe('a run of several candidates (#26)', () => {
  /** One click's worth of candidates, as the fixture stages mint them. */
  function runOfFour(runId: string): EditorAction {
    return {
      type: 'runStage',
      stage: 'source',
      runs: Array.from({ length: 4 }, (_, index) => ({
        id: `${runId}-${String(index)}`,
        seed: 100 + index,
        asset: null,
        runId,
      })),
      at: 1,
    }
  }

  /** One candidate as the job store hands it back. */
  function collected(id: string, runId: string | null): CompletedRun {
    return {
      id,
      stage: 'source',
      recipe: ATLAS.drafts.source,
      seed: 7,
      asset: `${id}.jpeg`,
      runId,
    }
  }

  /** A candidate arriving off the job store, carrying its run. */
  function arrival(id: string, runId: string | null): EditorAction {
    return {
      type: 'recordGenerations',
      entries: [collected(id, runId)],
      at: 5,
    }
  }

  it('stamps every candidate of one click with the same run', () => {
    const project = openProjectOf(
      apply(fixtureEditorState(), runOfFour('run-1'))
    )
    const created = generationsForStage(project, 'source').slice(-4)

    expect(created).toHaveLength(4)
    expect(new Set(created.map(g => g.runId))).toEqual(new Set(['run-1']))
    // Distinct candidates, not four references to one.
    expect(new Set(created.map(g => g.id)).size).toBe(4)
  })

  it('groups a stage into the runs that produced it, newest last', () => {
    const project = openProjectOf(
      apply(fixtureEditorState(), runOfFour('run-1'))
    )
    const groups = runGroups(project, 'source', true)

    // The fixture's own run, then this one — never merged, never reordered.
    expect(groups).toHaveLength(2)
    expect(groups.at(-1)?.runId).toBe('run-1')
    expect(groups.at(-1)?.number).toBe(2)
    expect(groups.at(-1)?.generations).toHaveLength(4)
  })

  it('leaves candidates from before the slice ungrouped rather than invented', () => {
    const ungrouped = {
      ...ATLAS,
      generations: ATLAS.generations.map(g => ({ ...g, runId: null })),
    }
    const groups = runGroups(ungrouped, 'source', true)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.runId).toBeNull()
    expect(groups[0]?.number).toBeNull()
  })

  it('keeps a run numbered the same when a reject is hidden', () => {
    // "Run 2" has to keep meaning one click, for the same reason ordinals are
    // never renumbered — otherwise "the second one of that run" stops working.
    const withReject = apply(fixtureEditorState(), runOfFour('run-1'))
    const rejected = apply(withReject, {
      type: 'setVerdict',
      // Not the first, which the run selected — a rejected candidate the next
      // stage is consuming stays on screen (PRD §10.3).
      generationId: 'run-1-1',
      verdict: 'rejected',
    })

    const project = openProjectOf(rejected)
    const shown = runGroups(project, 'source', false).at(-1)

    expect(shown?.number).toBe(2)
    expect(shown?.generations).toHaveLength(3)
  })

  /** A run being started — what a click on Generate dispatches first. */
  function began(runId: string, ids: readonly string[]): EditorAction {
    return {
      type: 'beginRun',
      runId,
      projectId: ATLAS.id,
      stage: 'source',
      generationIds: ids,
      at: 4,
    }
  }

  it('selects the first candidate to arrive, so the next stage has an input', () => {
    const state = apply(fixtureEditorState(), arrival('job-a', 'run-1'))
    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-a')
  })

  it('does not let later arrivals steal the selection from their own run', () => {
    // Otherwise a four-up ends on whichever job happened to finish last.
    const state = apply(
      fixtureEditorState(),
      arrival('job-a', 'run-1'),
      arrival('job-b', 'run-1'),
      arrival('job-c', 'run-1')
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-a')
  })

  it('does not let them steal it when the run is not known either', () => {
    // A batch resumed after a quit arrives with no run at all until the sweep
    // adopts it, and "whichever finished last" is no better an answer then.
    const state = apply(
      fixtureEditorState(),
      arrival('job-a', null),
      arrival('job-b', null),
      arrival('job-c', null)
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-a')
  })

  it('never overrides a candidate the user picked during the run', () => {
    // The grid is the moment the choice is made, and it is made while the rest
    // of the batch is still generating. An arrival that moved the selection
    // would undo a click from two seconds ago.
    const state = apply(
      fixtureEditorState(),
      began('run-1', ['job-a', 'job-b', 'job-c', 'job-d']),
      arrival('job-a', 'run-1'),
      arrival('job-b', 'run-1'),
      { type: 'selectGeneration', generationId: 'job-b' },
      arrival('job-c', 'run-1'),
      arrival('job-d', 'run-1')
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-b')
  })

  it('never overrides it from a second run queued behind the first', () => {
    // Two runs in flight, arrivals interleaved: the pick was a statement about
    // the stage, not about one batch, so nothing from either run moves it.
    const state = apply(
      fixtureEditorState(),
      began('run-1', ['job-a', 'job-b']),
      began('run-2', ['job-c', 'job-d']),
      arrival('job-a', 'run-1'),
      { type: 'selectGeneration', generationId: 'job-a' },
      {
        type: 'recordGenerations',
        entries: [
          collected('job-c', 'run-2'),
          collected('job-b', 'run-1'),
          collected('job-d', 'run-2'),
        ],
        at: 6,
      }
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-a')
  })

  it('never overrides a candidate the user picked from the strip', () => {
    // Clicking an older candidate mid-run is a choice about the stage too, and
    // an arrival is not entitled to overrule it.
    const state = apply(
      fixtureEditorState(),
      began('run-1', ['job-a', 'job-b']),
      { type: 'selectGeneration', generationId: 'gen-src-1' },
      arrival('job-a', 'run-1'),
      arrival('job-b', 'run-1')
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe(
      'gen-src-1'
    )
  })

  it('claims the selection again for a run started after the choice', () => {
    // Asking for more candidates is asking to be shown one: the previous
    // answer stops standing in the way when a new run begins.
    const state = apply(
      fixtureEditorState(),
      began('run-1', ['job-a']),
      arrival('job-a', 'run-1'),
      { type: 'selectGeneration', generationId: 'job-a' },
      began('run-2', ['job-b']),
      arrival('job-b', 'run-2')
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe('job-b')
  })

  it('still selects an arrival whose run this session never knew', () => {
    // A job submitted before the last quit comes back with no run at all, and
    // it is exactly the image the user has been waiting for.
    const state = apply(fixtureEditorState(), arrival('job-resumed', null))
    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe(
      'job-resumed'
    )
  })

  it('an upload is selected even after the user has chosen something', () => {
    // Bringing an image in is asking for it to be used (#27) — unlike a job
    // arriving, it happened because someone did it just now.
    const state = apply(
      fixtureEditorState(),
      { type: 'selectGeneration', generationId: 'gen-src-1' },
      {
        type: 'recordUpload',
        generationId: 'upload-9',
        asset: 'upload-9.png',
        fileName: 'plate.png',
        at: 8,
      }
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe(
      'upload-9'
    )
  })
})

/** PRD §4.2/§11 — the batch is the project's setting, not the app's. */
describe('batch size (#26)', () => {
  it('produces four images and one video by default', () => {
    const project = openProjectOf(fixtureEditorState())

    expect(batchSizeFor(project, 'source')).toBe(4)
    expect(batchSizeFor(project, 'animate')).toBe(1)
    // Style is an image stage too — the fixture's style draft pins a seed, so
    // what it would submit right now is the collapse rather than the setting.
    expect(configuredBatchSize(project, 'style')).toBe(4)
    expect(batchSizeFor(project, 'style')).toBe(1)
  })

  it('reads what the project was set to, not a constant', () => {
    const state = apply(fixtureEditorState(), {
      type: 'setBatchSize',
      stage: 'source',
      size: 2,
    })

    const project = openProjectOf(state)
    expect(project.batchSizes.source).toBe(2)
    expect(batchSizeFor(project, 'source')).toBe(2)
    // Per stage, so setting one leaves the others exactly as they were.
    expect(configuredBatchSize(project, 'style')).toBe(4)
    expect(batchSizeFor(project, 'animate')).toBe(1)
  })

  it('sets the video batch from the animate stage alone', () => {
    const project = openProjectOf(
      apply(fixtureEditorState(), {
        type: 'setBatchSize',
        stage: 'animate',
        size: 3,
      })
    )

    expect(project.batchSizes.animate).toBe(3)
    expect(project.batchSizes.source).toBe(4)
  })

  it('refuses a size we would not actually submit', () => {
    const huge = openProjectOf(
      apply(fixtureEditorState(), {
        type: 'setBatchSize',
        stage: 'source',
        size: 40,
      })
    )
    const none = openProjectOf(
      apply(fixtureEditorState(), {
        type: 'setBatchSize',
        stage: 'source',
        size: 0,
      })
    )

    expect(huge.batchSizes.source).toBe(4)
    expect(none.batchSizes.source).toBe(1)
  })

  it('collapses to one candidate while the seed is pinned', () => {
    // Four copies of the same picture is not a choice, whatever the setting
    // says — and the estimate above the button has to agree with the button.
    const state = apply(fixtureEditorState(), {
      type: 'pinSeed',
      stage: 'source',
      value: 12_345,
    })

    const project = openProjectOf(state)
    expect(batchSizeFor(project, 'source')).toBe(1)
    // The setting itself is untouched: unpinning restores the four.
    expect(configuredBatchSize(project, 'source')).toBe(4)
    expect(
      batchSizeFor(
        openProjectOf(apply(state, { type: 'unpinSeed', stage: 'source' })),
        'source'
      )
    ).toBe(4)
  })
})
