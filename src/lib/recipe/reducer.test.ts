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
  freezeRecipe,
  type CompletedRun,
  type EditorAction,
} from './reducer'
import { ATLAS, LEDGER, fixtureEditorState, summaryOf } from './fixtures'
import { MODEL_REGISTRY } from './models'
import { modelById } from './registry'
import {
  composePreset,
  sourcePresetById,
  stylePresetById,
  userPresetFrom,
  type Preset,
} from './presets'
import { motionPresetById } from './motion'
import { colourNameOf, DEFAULT_PALETTE } from './palette'
import { UPLOAD_MODEL_ID, isUploadRecipe, uploadFileName } from './upload'
import {
  activeProject,
  activeRunFor,
  batchSizeFor,
  configuredBatchSize,
  generationsForStage,
  runGroups,
  selectedGeneration,
  visibleGenerations,
} from './selectors'
import type { EditorState, Project, StageParams, StageRecipe } from './types'

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

/** A built-in by id, or a failure — the library is committed data. */
function presetOf(id: string): Preset {
  const preset = stylePresetById(id)
  if (preset === null) throw new Error(`no built-in preset "${id}"`)
  return preset
}

/** Choosing a style preset as the panel does: the preset rides along. */
/** The one animate model with a `negative_prompt` field to leave alone. */
const VEO = 'fal-ai/veo3.1/image-to-video'

/** Selecting a built-in motion preset, exactly as the picker dispatches it. */
function chooseMotion(id: string): EditorAction {
  const preset = motionPresetById(id)
  if (preset === null) throw new Error(`no motion preset "${id}"`)
  return { type: 'choosePreset', stage: 'animate', presetId: id, preset }
}

function choose(id: string): EditorAction {
  return {
    type: 'choosePreset',
    stage: 'style',
    presetId: id,
    preset: presetOf(id),
  }
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
    expect(project.drafts.style.presetId).toBe('brutalist-monochrome')
  })
})

/**
 * #28 — a preset seeds an editable form, so "which preset produced this" needs a
 * companion: whether what was sent is still what the preset said.
 */
describe('preset provenance', () => {
  it('starts a freshly chosen preset unmodified', () => {
    const state = apply(fixtureEditorState(), choose('glass-caustics'))

    expect(openProjectOf(state).drafts.style.presetModified).toBe(false)
  })

  it('records an edit to a seeded field', () => {
    const state = apply(fixtureEditorState(), choose('glass-caustics'), {
      type: 'setPrompt',
      stage: 'style',
      prompt: 'my own words',
    })

    expect(openProjectOf(state).drafts.style.presetModified).toBe(true)
  })

  it('records a move of a seeded parameter as an edit too', () => {
    // Strength is seeded, so "which preset produced this" is a different claim
    // at 0.8 than at 0.7.
    const state = apply(fixtureEditorState(), choose('glass-caustics'), {
      type: 'setParam',
      stage: 'style',
      key: 'strength',
      value: 0.8,
    })

    expect(openProjectOf(state).drafts.style.presetModified).toBe(true)
  })

  it('records a move of the negative, where the model has one to seed', () => {
    const state = apply(
      fixtureEditorState(),
      // Qwen is the one model with a `negative_prompt` to seed.
      {
        type: 'chooseModel',
        stage: 'style',
        modelId: 'fal-ai/qwen-image-2/edit',
      },
      choose('glass-caustics'),
      {
        type: 'setParam',
        stage: 'style',
        key: 'negative_prompt',
        value: 'no gradients',
      }
    )

    expect(openProjectOf(state).drafts.style.presetModified).toBe(true)
  })

  it('ignores a parameter the preset never seeded', () => {
    // Seeding writes three fields (`seedFromPreset`) and this is not one of
    // them: a step count is the model's business, and moving it says nothing
    // about whether the recipe is still the preset's.
    const state = apply(fixtureEditorState(), choose('glass-caustics'), {
      type: 'setParam',
      stage: 'style',
      key: 'num_inference_steps',
      value: 40,
    })

    expect(openProjectOf(state).drafts.style.presetModified).toBe(false)
  })

  it('keeps the flag once a seeded field has moved, whatever is edited next', () => {
    // Provenance is a claim about the past. Editing something unrelated
    // afterwards does not un-edit the prompt.
    const state = apply(
      fixtureEditorState(),
      choose('glass-caustics'),
      { type: 'setPrompt', stage: 'style', prompt: 'my own words' },
      {
        type: 'setParam',
        stage: 'style',
        key: 'num_inference_steps',
        value: 40,
      }
    )

    expect(openProjectOf(state).drafts.style.presetModified).toBe(true)
  })

  it('claims no modification when there was no preset to modify', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'choosePreset', stage: 'style', presetId: null, preset: null },
      { type: 'setPrompt', stage: 'style', prompt: 'from scratch' }
    )

    expect(openProjectOf(state).drafts.style.presetModified).toBe(false)
  })

  it('records an edited source prompt as having moved from its scene', () => {
    // #47 — source has a real library now, so the same provenance claim holds
    // there. Before it did, source was exempt: it picked from a fixture list
    // that composed nothing, and a flag saying the form had drifted would have
    // described a seeding that never happened.
    const scene = sourcePresetById('gn-monolith')
    if (scene === null) throw new Error('the source library lost a preset')

    const state = apply(
      fixtureEditorState(),
      {
        type: 'choosePreset',
        stage: 'source',
        presetId: scene.id,
        preset: scene,
      },
      { type: 'setPrompt', stage: 'source', prompt: 'a different subject' }
    )

    expect(openProjectOf(state).drafts.source.presetId).toBe(scene.id)
    expect(openProjectOf(state).drafts.source.presetModified).toBe(true)
  })

  it('claims nothing on a source draft with no scene selected', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'choosePreset', stage: 'source', presetId: null, preset: null },
      { type: 'setPrompt', stage: 'source', prompt: 'a different subject' }
    )

    expect(openProjectOf(state).drafts.source.presetModified).toBe(false)
  })

  it('records an edited motion prompt as having moved from its preset', () => {
    // #29 — animate has a real library now, so the same provenance claim holds
    // there: "which motion preset produced this" is only half an answer once the
    // prompt has been rewritten.
    const state = apply(fixtureEditorState(), chooseMotion('drifting-clouds'), {
      type: 'setPrompt',
      stage: 'animate',
      prompt: 'clouds, but faster',
    })

    expect(openProjectOf(state).drafts.animate.presetModified).toBe(true)
  })

  it('does not count a video model’s negative prompt, which motion never seeds', () => {
    // Veo has a `negative_prompt` and a motion preset writes the prompt and
    // nothing else — so moving that field says nothing about which preset this
    // started from, unlike the style stage where the same field *is* seeded.
    const state = apply(
      fixtureEditorState(),
      { type: 'chooseModel', stage: 'animate', modelId: VEO },
      chooseMotion('drifting-clouds'),
      {
        type: 'setParam',
        stage: 'animate',
        key: 'negative_prompt',
        value: 'blurry',
      }
    )

    expect(openProjectOf(state).drafts.animate.presetModified).toBe(false)
  })
})

/**
 * The second library (#29) — motion presets seed, and seed one field.
 *
 * Worth asserting apart from the style cases because the schemas differ on
 * purpose: there is no idiom to fail to speak, no strength and no negative, so
 * the interesting question is what seeding *does not* touch.
 */
describe('seeding the form from a motion preset', () => {
  const DRIFT = motionPresetById('drifting-clouds')
  if (DRIFT === null) throw new Error('the built-in motion library lost one')

  it('puts the whole motion prompt in the box, which is what gets sent', () => {
    const state = apply(fixtureEditorState(), chooseMotion(DRIFT.id))
    const draft = openProjectOf(state).drafts.animate

    expect(draft.prompt).toBe(DRIFT.prompt)
    expect(draft.presetId).toBe(DRIFT.id)
    expect(draft.presetModified).toBe(false)
  })

  it('leaves duration, resolution and the rest exactly as they were', () => {
    // Movement and length are different decisions, and a preset that reset the
    // duration would silently change what the next click costs.
    const before = openProjectOf(fixtureEditorState()).drafts.animate
    const state = apply(fixtureEditorState(), chooseMotion(DRIFT.id))
    const after = openProjectOf(state).drafts.animate

    expect(after.params).toEqual(before.params)
    expect(after.options).toEqual(before.options)
    expect(after.seed).toEqual(before.seed)
  })

  it('never writes a negative, even on the one video model that has the field', () => {
    const state = apply(
      fixtureEditorState(),
      { type: 'chooseModel', stage: 'animate', modelId: VEO },
      chooseMotion(DRIFT.id)
    )

    // Whatever the model's own default says, seeding did not touch it.
    expect(openProjectOf(state).drafts.animate.params.negative_prompt).toBe('')
  })

  it('keeps the text and drops only the pointer when nothing is selected', () => {
    const state = apply(fixtureEditorState(), chooseMotion(DRIFT.id), {
      type: 'choosePreset',
      stage: 'animate',
      presetId: null,
      preset: null,
    })
    const draft = openProjectOf(state).drafts.animate

    expect(draft.presetId).toBeNull()
    expect(draft.prompt).toBe(DRIFT.prompt)
  })
})

/**
 * Seeding (#28) — "presets are seeds, not filters", as transitions.
 *
 * The claim being tested is that what lands in the form is the whole of what
 * will be sent: the composed prompt in the box, the strength and the negative in
 * the fields the *model* names for them, and nothing anywhere it does not
 * belong. Which is why every case here is really about the registry — the same
 * preset seeds two fields on flux i2i and a different one on Qwen.
 */
describe('seeding the form from a preset', () => {
  /** Atlas's style draft is on flux i2i: prose, a strength, no negative. */
  const FLUX_I2I = modelById(MODEL_REGISTRY, 'fal-ai/flux/dev/image-to-image')
  /** The tags exemplar: a real `negative_prompt`, and no strength at all. */
  const QWEN = modelById(MODEL_REGISTRY, 'fal-ai/qwen-image-2/edit')

  const onQwen: EditorAction = {
    type: 'chooseModel',
    stage: 'style',
    modelId: QWEN.id,
  }

  it('pre-fills the box with the fully composed prompt', () => {
    // Not a fragment assembled later: what is in the box is what is sent, so
    // the preserve block has to be visible to the person about to pay for it.
    const state = apply(fixtureEditorState(), choose('glass-caustics'))
    const draft = openProjectOf(state).drafts.style

    expect(draft.prompt).toBe(
      composePreset(presetOf('glass-caustics'), FLUX_I2I, DEFAULT_PALETTE)
        ?.prompt
    )
    expect(draft.prompt).toContain('Keep the composition exactly as it is')
    expect(draft.presetId).toBe('glass-caustics')
  })

  it('seeds the strength under the name the model gives it', () => {
    const state = apply(fixtureEditorState(), choose('topographic-contour'))

    // The preset's own opinion, clamped to the measured window by `composePreset`.
    expect(openProjectOf(state).drafts.style.params.strength).toBe(0.78)
  })

  it('leaves a model with no strength field without one', () => {
    const state = apply(
      fixtureEditorState(),
      onQwen,
      choose('topographic-contour')
    )
    const params = openProjectOf(state).drafts.style.params

    expect(params.strength).toBeUndefined()
    expect(
      composePreset(presetOf('topographic-contour'), QWEN, DEFAULT_PALETTE)
        ?.strength
    ).toBeNull()
  })

  it('routes the negative to the field the model names, never into the prompt', () => {
    const state = apply(fixtureEditorState(), onQwen, choose('glass-caustics'))
    const draft = openProjectOf(state).drafts.style
    const negative = presetOf('glass-caustics').variants.tags?.negative ?? ''

    expect(draft.params.negative_prompt).toBe(negative)
    // PRD §9 — "no gradients" inside a positive prompt is a request for gradients.
    expect(draft.prompt).not.toContain(negative)
  })

  it('drops the negative entirely on a model with nowhere to put one', () => {
    const state = apply(fixtureEditorState(), choose('glass-caustics'))

    expect(FLUX_I2I.negativePromptParam).toBeNull()
    expect(
      openProjectOf(state).drafts.style.params.negative_prompt
    ).toBeUndefined()
  })

  it('clears the last preset’s negative rather than letting it outlive it', () => {
    const nothingToSubtract = userPresetFrom({
      id: 'nothing-to-subtract',
      name: 'Nothing to subtract',
      promptStyle: 'tags',
      prompt: 'plain and unopinionated',
      negative: null,
      strength: null,
      aspect: null,
      headlineZone: null,
      note: null,
    })

    const state = apply(
      fixtureEditorState(),
      onQwen,
      choose('glass-caustics'),
      {
        type: 'choosePreset',
        stage: 'style',
        presetId: nothingToSubtract.id,
        preset: nothingToSubtract,
      }
    )

    expect(openProjectOf(state).drafts.style.params.negative_prompt).toBe('')
  })

  it('seeds nothing when the preset does not speak the model’s idiom', () => {
    // A fork carries the one idiom it was saved in. Seeding the other one is the
    // cross-send the schema exists to refuse, so the text is left alone — the
    // picker disables this combination with the reason attached.
    const tagsOnly = userPresetFrom({
      id: 'tags-only',
      name: 'Tags only',
      promptStyle: 'tags',
      prompt: 'a keyword list',
      negative: null,
      strength: null,
      aspect: null,
      headlineZone: null,
      note: null,
    })

    const before = openProjectOf(fixtureEditorState()).drafts.style.prompt
    const state = apply(fixtureEditorState(), {
      type: 'choosePreset',
      stage: 'style',
      presetId: tagsOnly.id,
      preset: tagsOnly,
    })

    expect(openProjectOf(state).drafts.style.prompt).toBe(before)
    // Still recorded: the recipe says what was selected either way.
    expect(openProjectOf(state).drafts.style.presetId).toBe('tags-only')
  })

  it('keeps the user’s own words when the model changes', () => {
    const state = apply(
      fixtureEditorState(),
      choose('glass-caustics'),
      { type: 'setPrompt', stage: 'style', prompt: 'my own words' },
      onQwen
    )
    const draft = openProjectOf(state).drafts.style

    expect(draft.prompt).toBe('my own words')
    expect(draft.presetId).toBe('glass-caustics')
    expect(draft.presetModified).toBe(true)
  })

  it('re-seeds in the new model’s idiom when asked, and only then', () => {
    // The offer is made in the UI; taking it is this same action again. Note the
    // prompt is the *tags* phrasing now, which is the whole point of asking.
    const state = apply(
      fixtureEditorState(),
      choose('glass-caustics'),
      { type: 'setPrompt', stage: 'style', prompt: 'my own words' },
      onQwen,
      choose('glass-caustics')
    )
    const draft = openProjectOf(state).drafts.style

    expect(draft.prompt).toBe(
      composePreset(presetOf('glass-caustics'), QWEN, DEFAULT_PALETTE)?.prompt
    )
    expect(draft.presetModified).toBe(false)
  })

  it('leaves the form alone when the preset is cleared', () => {
    // Deselecting is not undoing: the text is the user's now, whatever put it
    // there. Only the provenance pointer goes.
    const state = apply(fixtureEditorState(), choose('glass-caustics'), {
      type: 'choosePreset',
      stage: 'style',
      presetId: null,
      preset: null,
    })
    const draft = openProjectOf(state).drafts.style

    expect(draft.presetId).toBeNull()
    expect(draft.prompt).toBe(
      composePreset(presetOf('glass-caustics'), FLUX_I2I, DEFAULT_PALETTE)
        ?.prompt
    )
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
      {
        type: 'choosePreset',
        stage: 'animate',
        presetId: 'locked-camera-drift',
        preset: null,
      },
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
            presetModified: false,
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

/**
 * What a run remembers, and for how long (#26).
 *
 * The hold lives on the run records rather than beside them, which is what
 * makes it survive the editor being pointed somewhere else — a job goes on
 * running whichever project is in front of you.
 */
describe('a run outlives the view of it (#26)', () => {
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

  function arrival(id: string, runId: string | null): EditorAction {
    return {
      type: 'recordGenerations',
      entries: [
        {
          id,
          stage: 'source',
          recipe: ATLAS.drafts.source,
          seed: 7,
          asset: `${id}.jpeg`,
          runId,
        },
      ],
      at: 5,
    }
  }

  it('keeps a choice made before the project was closed and reopened', () => {
    // Switching away and back is not a new question, and the rest of the batch
    // is still landing while you are somewhere else.
    const opened = apply(
      fixtureEditorState(),
      began('run-1', ['job-a', 'job-b']),
      arrival('job-a', 'run-1'),
      { type: 'selectGeneration', generationId: 'job-a' }
    )

    const project = openProjectOf(opened)
    const returned = apply(
      opened,
      { type: 'closeProject' },
      { type: 'openProject', project, directory: '/tmp/atlas' },
      arrival('job-b', 'run-1')
    )

    expect(selectedGeneration(openProjectOf(returned), 'source')?.id).toBe(
      'job-a'
    )
  })

  it('puts the grid away when an image is brought in instead (#27)', () => {
    // An upload is an answer to "which source", so the run stops asking.
    const state = apply(
      fixtureEditorState(),
      began('run-1', ['job-a', 'job-b']),
      {
        type: 'recordUpload',
        generationId: 'upload-1',
        asset: 'upload-1.png',
        fileName: 'plate.png',
        at: 8,
      }
    )

    expect(activeRunFor(state, ATLAS.id, 'source')).toBeNull()
    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe(
      'upload-1'
    )
  })

  it('forgets old answered runs but never one still being waited on', () => {
    // Forgetting a run whose jobs are still out there would let the sweep
    // adopt them again and re-open a grid nobody asked for.
    const many = Array.from({ length: 30 }, (_, index) =>
      began(`run-${String(index)}`, [`job-${String(index)}`])
    )
    const answered = many.flatMap((start, index) => [
      start,
      { type: 'dismissRun', runId: `run-${String(index)}` } as EditorAction,
    ])

    const dropped = apply(fixtureEditorState(), ...answered)
    expect(dropped.runs.length).toBeLessThan(30)

    const kept = apply(fixtureEditorState(), ...many)
    expect(kept.runs).toHaveLength(30)
    expect(kept.runs.every(run => !run.answered)).toBe(true)
  })

  it('gathers candidates nobody recorded a run for into one', () => {
    // A job that settled before the sweep could adopt it: the first is the
    // image someone was waiting for, and the rest are its siblings — not four
    // separate claims on the selection.
    const state = apply(
      fixtureEditorState(),
      arrival('stray-a', null),
      arrival('stray-b', null)
    )

    expect(selectedGeneration(openProjectOf(state), 'source')?.id).toBe(
      'stray-a'
    )
    // And no grid for a question that was never asked.
    expect(activeRunFor(state, ATLAS.id, 'source')).toBeNull()
  })
})

/**
 * What a frozen run says about the loop (#30).
 *
 * The draft holds an *intent*; the run is a fact, and PRD §4.5 makes the two
 * disagree in both directions — a first/last-frame endpoint loops with the
 * switch off, and a model with no end-frame field does not loop with a
 * carried-over `true` on. What is persisted beside the candidate has to be the
 * fact, or the recipe describes a clip nobody generated.
 */
describe('the frozen recipe records the loop that will happen (#30)', () => {
  /** Atlas, whose style stage has a still selected, on the named model. */
  function animatingWith(modelId: string, options: StageParams): Project {
    return {
      ...ATLAS,
      drafts: {
        ...ATLAS.drafts,
        animate: { ...ATLAS.drafts.animate, modelId, options },
      },
    }
  }

  function frozenAnimate(project: Project): StageRecipe {
    const recipe = freezeRecipe(MODEL_REGISTRY, project, 'animate')
    if (recipe === null) throw new Error('there is no still to animate')
    return recipe
  }

  it('records a loop on a model that cannot run without an end frame', () => {
    const project = animatingWith(
      'blackforestlabs/flux-3/first-last-frame-to-video',
      { rewind: false }
    )

    expect(frozenAnimate(project).options.loop).toBe(true)
    // And the draft keeps the user's own answer, untouched: switching back to
    // a model that offers the choice has to bring it with them.
    expect(project.drafts.animate.options).toEqual({ rewind: false })
  })

  it('records no loop on a model with nowhere to put an end frame', () => {
    // Veo's plain image-to-video. A `true` carried over from an earlier model
    // is an intent nothing acts on, and freezing it would claim a seam that
    // is not there.
    const project = animatingWith('fal-ai/veo3.1/image-to-video', {
      rewind: false,
      loop: true,
    })

    expect(frozenAnimate(project).options.loop).toBe(false)
    expect(project.drafts.animate.options).toEqual({
      rewind: false,
      loop: true,
    })
  })

  it('carries the answer through where the model offers the choice', () => {
    const luma = 'fal-ai/luma-dream-machine/ray-2/image-to-video'

    expect(
      frozenAnimate(animatingWith(luma, { loop: true })).options.loop
    ).toBe(true)
    expect(
      frozenAnimate(animatingWith(luma, { loop: false })).options.loop
    ).toBe(false)
  })
})

/**
 * The project palette (#46).
 *
 * Two claims worth pinning. Seeding resolves the holes *here*, so the draft
 * holds expanded prose and nothing downstream is ever handed a template. And
 * editing the palette reaches forwards only — which is the whole reason it is
 * allowed to be editable at all, where the aspect ratio is not (PRD §11).
 */
describe('the palette (#46)', () => {
  /** Choosing a source scene with its holes filled, as the picker does. */
  function chooseScene(
    id: string,
    values: Record<string, string> = {}
  ): EditorAction {
    const preset = sourcePresetById(id)
    if (preset === null) throw new Error(`no source preset "${id}"`)
    return {
      type: 'choosePreset',
      stage: 'source',
      presetId: id,
      preset,
      values,
    }
  }

  it('expands the holes into the draft, so only prose is ever persisted', () => {
    const state = apply(
      fixtureEditorState(),
      chooseScene('gn-monolith', { subject: 'a brushed steel kettle' })
    )
    const draft = openProjectOf(state).drafts.source

    expect(draft.prompt).toContain('a brushed steel kettle')
    expect(draft.prompt).toContain(colourNameOf(ATLAS.palette.roles.primary))
    expect(draft.prompt).not.toContain('{{')
  })

  it('resolves against this project’s palette rather than the default', () => {
    const recoloured: Project = {
      ...ATLAS,
      palette: {
        ...ATLAS.palette,
        roles: {
          ...ATLAS.palette.roles,
          primary: { hex: '#D9662C', name: 'House orange' },
        },
      },
    }

    const state = apply(
      fixtureEditorState(),
      { type: 'openProject', project: recoloured, directory: '/tmp/atlas' },
      chooseScene('gn-monolith')
    )

    expect(openProjectOf(state).drafts.source.prompt).toContain('House orange')
  })

  it('leaves a hole it cannot fill visible in the box', () => {
    const state = apply(fixtureEditorState(), chooseScene('gn-monolith'))

    expect(openProjectOf(state).drafts.source.prompt).toContain('{{subject}}')
  })

  it('changes what the next pick seeds, and nothing already generated', () => {
    const before = apply(fixtureEditorState(), chooseScene('gn-monolith'))
    const generations = openProjectOf(before).generations

    const after = apply(before, {
      type: 'setPalette',
      palette: {
        ...ATLAS.palette,
        roles: {
          ...ATLAS.palette.roles,
          primary: { hex: '#2FB6BF', name: 'turquoise' },
        },
      },
    })

    // The draft seeded before the edit is untouched — it is prose now, not a
    // reference to a palette.
    expect(openProjectOf(after).drafts.source.prompt).toBe(
      openProjectOf(before).drafts.source.prompt
    )
    expect(openProjectOf(after).generations).toBe(generations)

    // The next pick says the new colour.
    const reseeded = apply(after, chooseScene('gn-monolith'))
    expect(openProjectOf(reseeded).drafts.source.prompt).toContain('turquoise')
  })
})
