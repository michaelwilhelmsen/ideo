/**
 * The exact JSON each model gets, against the real registry.
 *
 * Asserted field by field rather than "it has an aspect somewhere", because
 * every difference here is one the schemas actually showed and one that fails
 * with a 422 at the paid step: `image_size` versus `aspect_ratio`, an object
 * versus a token, an integer duration versus `"5s"`, a seed on a model that has
 * no seed field.
 */

import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from './models'
import { modelById } from './registry'
import { buildRequest } from './request'
import type { SeedSetting, StageParams, StageRecipe } from './types'

function recipe(
  overrides: { seed?: SeedSetting; params?: StageParams } = {}
): StageRecipe {
  return {
    modelId: 'unused',
    prompt: 'a lighthouse at dusk',
    presetId: null,
    seed: overrides.seed ?? { mode: 'roll' },
    params: overrides.params ?? {},
    options: {},
    inputGenerationId: null,
  }
}

const model = (id: string) => modelById(MODEL_REGISTRY, id)

describe('buildRequest — aspect idioms', () => {
  it('sends a free-dimension model explicit pixels at exactly the locked ratio', () => {
    const request = buildRequest(model('fal-ai/flux/schnell'), '21:9', recipe())

    const size = request.params.image_size as { width: number; height: number }
    expect(size.width / size.height).toBe(21 / 9)
    expect(size.width % 16).toBe(0)
    expect(request.params.aspect_ratio).toBeUndefined()
  })

  it('sends an enum model its own ratio token and no dimensions', () => {
    const request = buildRequest(
      model('fal-ai/flux-pro/kontext/text-to-image'),
      '21:9',
      recipe()
    )

    expect(request.params.aspect_ratio).toBe('21:9')
    expect(request.params.image_size).toBeUndefined()
  })

  it('sends nothing about geometry when the model inherits it', () => {
    const request = buildRequest(
      model('fal-ai/flux/dev/image-to-image'),
      '21:9',
      recipe()
    )

    expect(request.params.image_size).toBeUndefined()
    expect(request.params.aspect_ratio).toBeUndefined()
  })

  it('refuses to build a body for a ratio the model cannot serve', () => {
    // Reachable only by bypassing the picker, which disables this pairing.
    expect(() =>
      buildRequest(model('fal-ai/veo3.1/image-to-video'), '21:9', recipe())
    ).toThrow('21:9')
  })

  it('never lets a draft override the project’s locked ratio', () => {
    // PRD §4.4 — the ratio belongs to the project, not to the form.
    const request = buildRequest(
      model('fal-ai/flux-pro/kontext/text-to-image'),
      '16:9',
      recipe({ params: { aspect_ratio: '9:16' } })
    )

    expect(request.params.aspect_ratio).toBe('16:9')
  })
})

describe('buildRequest — seeds', () => {
  it('sends a pinned seed to a model that has the field', () => {
    const request = buildRequest(
      model('fal-ai/flux/schnell'),
      '16:9',
      recipe({ seed: { mode: 'pinned', value: 42 } })
    )

    expect(request.params.seed).toBe(42)
  })

  it('sends no seed at all when the recipe rolls one', () => {
    const request = buildRequest(model('fal-ai/flux/schnell'), '16:9', recipe())

    expect(request.params.seed).toBeUndefined()
  })

  it('sends no seed to a model with no seed field, pinned or not', () => {
    // Grok has none. Sending one is a 422, and the control is disabled with a
    // reason upstream of here (PRD §10.1).
    const request = buildRequest(
      model('xai/grok-imagine-image'),
      '16:9',
      recipe({ seed: { mode: 'pinned', value: 42 } })
    )

    expect(request.params.seed).toBeUndefined()
  })
})

describe('buildRequest — durations', () => {
  it('sends Kling a bare integer', () => {
    const request = buildRequest(
      model('fal-ai/kling-video/o1/image-to-video'),
      '16:9',
      recipe({ params: { duration: '8' } })
    )

    expect(request.params.duration).toBe(8)
  })

  it('sends Luma a second-suffixed string', () => {
    const request = buildRequest(
      model('fal-ai/luma-dream-machine/ray-2/image-to-video'),
      '21:9',
      recipe({ params: { duration: '9s' } })
    )

    expect(request.params.duration).toBe('9s')
    expect(request.params.resolution).toBe('1080p')
  })

  it('falls back to our duration, not the provider’s, when the draft has none', () => {
    const request = buildRequest(
      model('fal-ai/veo3.1/image-to-video'),
      '16:9',
      recipe()
    )

    // Veo's own schema default is 8s; ours is 6s.
    expect(request.params.duration).toBe('6s')
  })
})

describe('buildRequest — defaults and unknown fields', () => {
  it('applies our defaults, not fal’s', () => {
    // PRD §6.3 — fal defaults strength to 0.95, which discards the input.
    const request = buildRequest(
      model('fal-ai/flux/dev/image-to-image'),
      '16:9',
      recipe()
    )

    expect(request.params.strength).toBe(0.7)
  })

  it('lets the draft override a default it has touched', () => {
    const request = buildRequest(
      model('fal-ai/flux/dev/image-to-image'),
      '16:9',
      recipe({ params: { strength: 0.8 } })
    )

    expect(request.params.strength).toBe(0.8)
  })

  it('drops a field this model has never heard of', () => {
    // A draft persisted against another model, or another build's registry.
    const request = buildRequest(
      model('fal-ai/flux-pro/kontext/text-to-image'),
      '16:9',
      recipe({ params: { strength: 0.7, negative_prompt: 'blurry' } })
    )

    expect(request.params.strength).toBeUndefined()
    expect(request.params.negative_prompt).toBeUndefined()
  })

  it('turns Seedance’s audio off, because it is billed and a hero is silent', () => {
    const request = buildRequest(
      model('bytedance/seedance-2.5/image-to-video'),
      '21:9',
      recipe()
    )

    expect(request.params.generate_audio).toBe(false)
    expect(request.params.duration).toBe(5)
  })

  it('names the model it built for, which is what Rust submits against', () => {
    const request = buildRequest(model('fal-ai/flux/schnell'), '16:9', recipe())

    expect(request.modelId).toBe('fal-ai/flux/schnell')
  })
})
