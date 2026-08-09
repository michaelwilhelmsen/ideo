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
import { buildRequest, sentRecipe } from './request'
import type { SeedSetting, StageParams, StageRecipe } from './types'

function recipe(
  overrides: { seed?: SeedSetting; params?: StageParams } = {}
): StageRecipe {
  return {
    modelId: 'unused',
    prompt: 'a lighthouse at dusk',
    presetId: null,
    presetModified: false,
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
  it('sends Kling a string of digits, because its enum is one', () => {
    // Re-read on 2026-08-09: Kling's `duration` is a *string* enum ("3".."10"),
    // and a bare integer against a string enum is a 422 at the paid step. The
    // registry said `integer` until #29 checked.
    const request = buildRequest(
      model('fal-ai/kling-video/o1/image-to-video'),
      '16:9',
      recipe({ params: { duration: '8' } })
    )

    expect(request.params.duration).toBe('8')
  })

  it('sends LTX a bare integer, because its enum really is one', () => {
    // The counterexample that keeps `durationFormat` honest: three idioms
    // across eight video endpoints, and this one takes the number.
    const request = buildRequest(
      model('fal-ai/ltx-2.3/image-to-video'),
      '16:9',
      recipe({ params: { duration: '8' } })
    )

    expect(request.params.duration).toBe(8)
  })

  it('strips the seconds suffix a draft may carry into a string enum', () => {
    // A duration restored from a recipe written against Luma reads "9s"; on a
    // string-enum model the value has to arrive as "9".
    const request = buildRequest(
      model('bytedance/seedance-2.5/image-to-video'),
      '16:9',
      recipe({ params: { duration: '30s' } })
    )

    expect(request.params.duration).toBe('30')
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

  it('never carries an image field, whatever a draft claims about it', () => {
    // The image field holds a whole picture (#28), read and encoded on the Rust
    // side from the generation the recipe names. A value here could only be a
    // stale URL out of a hand-edited manifest — and would restyle the wrong
    // picture without anything on screen saying so.
    const request = buildRequest(
      model('fal-ai/flux/dev/image-to-image'),
      '16:9',
      recipe({ params: { image_url: 'https://example.invalid/old.png' } })
    )

    expect(request.params).not.toHaveProperty('image_url')

    const qwen = buildRequest(
      model('fal-ai/qwen-image-2/edit'),
      '16:9',
      recipe({ params: { image_urls: 'https://example.invalid/old.png' } })
    )

    expect(qwen.params).not.toHaveProperty('image_urls')
  })

  it('drops an extra field only the model that opted into it may send', () => {
    // `guidance_scale` is real on some endpoints and unknown on this one. A
    // shared whitelist would have let it through to a 422 at the paid step.
    const kontext = buildRequest(
      model('fal-ai/flux-pro/kontext/text-to-image'),
      '16:9',
      recipe({ params: { guidance_scale: 3.5, num_inference_steps: 40 } })
    )

    expect(kontext.params.guidance_scale).toBeUndefined()
    expect(kontext.params.num_inference_steps).toBeUndefined()

    const schnell = buildRequest(
      model('fal-ai/flux/schnell'),
      '16:9',
      recipe({ params: { guidance_scale: 3.5, num_inference_steps: 8 } })
    )

    expect(schnell.params.guidance_scale).toBeUndefined()
    expect(schnell.params.num_inference_steps).toBe(8)
  })

  it('turns Seedance’s audio off, because it is billed and a hero is silent', () => {
    const request = buildRequest(
      model('bytedance/seedance-2.5/image-to-video'),
      '21:9',
      recipe()
    )

    expect(request.params.generate_audio).toBe(false)
    expect(request.params.duration).toBe('5')
  })

  it('names the model it built for, which is what Rust submits against', () => {
    const request = buildRequest(model('fal-ai/flux/schnell'), '16:9', recipe())

    expect(request.modelId).toBe('fal-ai/flux/schnell')
  })
})

/**
 * AC10 — the persisted recipe has to be the one that ran.
 *
 * The draft is not it: three things are decided between the form and the wire,
 * and a recipe missing them says "21:9 somehow, seed unknown" about a generation
 * whose request said `{width: 1344, height: 576}` and `seed: 42`. Re-runnability
 * is the premise the whole recipe model rests on (PRD §1), so this is asserted on
 * the values rather than on "it copied something".
 */
describe('sentRecipe', () => {
  const flux = model('fal-ai/flux/schnell')

  it('records the geometry the request resolved, not the ratio the form knew', () => {
    const draft = recipe()
    const sent = sentRecipe(draft, buildRequest(flux, '21:9', draft))

    const size = sent.params.image_size as { width: number; height: number }
    expect(size.width / size.height).toBe(21 / 9)
    expect(draft.params.image_size).toBeUndefined()
  })

  it('records the seed that went out', () => {
    const draft = recipe({ seed: { mode: 'pinned', value: 42 } })
    const sent = sentRecipe(draft, buildRequest(flux, '16:9', draft))

    expect(sent.params.seed).toBe(42)
  })

  it('records our defaults, since the form never showed them', () => {
    const i2i = model('fal-ai/flux/dev/image-to-image')
    const draft = recipe()
    const sent = sentRecipe(draft, buildRequest(i2i, '16:9', draft))

    // PRD §6.3 — ours is 0.7 where fal's own is 0.95, and which one produced the
    // image is exactly what a recipe is for.
    expect(sent.params.strength).toBe(0.7)
  })

  it('leaves everything else about the recipe alone', () => {
    const draft = recipe({ params: { num_inference_steps: 8 } })
    const sent = sentRecipe(draft, buildRequest(flux, '16:9', draft))

    expect(sent.prompt).toBe(draft.prompt)
    expect(sent.seed).toEqual(draft.seed)
    expect(sent.presetId).toBe(draft.presetId)
    expect(sent.params.num_inference_steps).toBe(8)
  })

  it('does not let a recorded seed outlive being unpinned', () => {
    // A recipe restored into the form (`restoreRecipe`) brings the seed it was
    // sent with along in its parameters. Carried through, it would keep pinning
    // the seed after the user had unpinned it — the pin would be unremovable.
    const pinned = recipe({ seed: { mode: 'pinned', value: 42 } })
    const restored = sentRecipe(pinned, buildRequest(flux, '16:9', pinned))
    const unpinned: StageRecipe = { ...restored, seed: { mode: 'roll' } }

    expect(buildRequest(flux, '16:9', unpinned).params.seed).toBeUndefined()
  })
})
