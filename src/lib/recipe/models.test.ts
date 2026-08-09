/**
 * The committed registry, checked against the claims the rest of the app makes
 * about it.
 *
 * Not a re-statement of the data — that would only assert the file equals
 * itself. These are the invariants a careless edit breaks: a default that names
 * a model that is not there, an endpoint id at the wrong stage, a price with no
 * date on it.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_IDS, MODEL_REGISTRY } from './models'
import {
  durationSeconds,
  estimateCost,
  imageParamShape,
  modelAvailability,
  modelById,
  modelsForStage,
} from './registry'
import { STAGE_ORDER } from './types'

describe('MODEL_REGISTRY', () => {
  it('validates at import, or the module would not have loaded', () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0)
  })

  it('offers at least one model per stage', () => {
    for (const stage of STAGE_ORDER) {
      expect(modelsForStage(MODEL_REGISTRY, stage), stage).not.toHaveLength(0)
    }
  })

  it('dates every price it publishes, because staleness has to be visible', () => {
    // PRD §10.2 — an undated price implies a precision we do not have.
    for (const model of MODEL_REGISTRY) {
      if (model.price === null) continue
      expect(model.price.verifiedOn, model.id).toBe('2026-08-09')
    }
  })

  it('puts the image-to-image Kontext endpoint at the style stage, not source', () => {
    // The fixture bug this ticket exists to fix: `fal-ai/flux-pro/kontext`
    // requires an input image, so a text-to-image call against it fails at
    // submit — after the money.
    expect(modelById(MODEL_REGISTRY, 'fal-ai/flux-pro/kontext').stage).toBe(
      'style'
    )
    expect(
      modelById(MODEL_REGISTRY, 'fal-ai/flux-pro/kontext/text-to-image').stage
    ).toBe('source')
  })

  it('refuses an id it has no entry for rather than letting it through', () => {
    // PRD §5 — no arbitrary model ids in v1. Without an entry we cannot build
    // the right request, and the failure would look like an app bug.
    expect(() => modelById(MODEL_REGISTRY, 'fal-ai/whatever')).toThrow(
      'fal-ai/whatever'
    )
  })

  it('never defaults strength to the value that discards the input', () => {
    // PRD §6.3 — fal's own default is 0.95.
    for (const model of MODEL_REGISTRY) {
      if (model.strengthParam === null) continue
      expect(
        Number(model.defaults[model.strengthParam]),
        model.id
      ).toBeLessThanOrEqual(0.85)
    }
  })

  it('never defaults a resolution below 720p', () => {
    // Luma's own default is 540p, which is not a hero (PRD §5). The floor is
    // stated in pixels rather than as "not the lowest option", because LTX's
    // lowest option is already 1080p.
    for (const model of MODEL_REGISTRY) {
      if (model.resolutionParam === null) continue
      const chosen = String(model.defaults[model.resolutionParam])
      expect(model.resolutions, model.id).toContain(chosen)
      expect(Number.parseInt(chosen, 10), model.id).toBeGreaterThanOrEqual(720)
    }
  })

  it('gives every style model somewhere to put the source image', () => {
    // #28 — nothing restyles until the image reaches the provider, and it does
    // that under the model's own field name. Two names are in play and the split
    // is not a matter of taste: FLUX takes `image_url`, Qwen and Nano Banana take
    // an `image_urls` array.
    for (const model of modelsForStage(MODEL_REGISTRY, 'style')) {
      expect(model.imageParam, model.id).toMatch(/^image_urls?$/)
    }
  })

  it('gives every animate model somewhere to put the still', () => {
    // #29 — the still is the whole input to an animate run, and the endpoints
    // disagree about what to call it: `image_url` on five, `start_image_url` on
    // two, `first_frame_url` on one. All three are a single URL.
    for (const model of modelsForStage(MODEL_REGISTRY, 'animate')) {
      expect(model.imageParam, model.id).toMatch(
        /^(image_url|start_image_url|first_frame_url)$/
      )
      expect(imageParamShape(model), model.id).toBe('url')
    }
  })

  it('marks exactly the two endpoints that will not run without an end frame', () => {
    // Both refuse a submit naming only a start frame, and looping is #30 — so
    // until then they are disabled with a reason rather than quietly 422ing.
    const required = MODEL_REGISTRY.filter(model => model.endFrameRequired)

    expect(required.map(model => model.id)).toEqual([
      'blackforestlabs/flux-3/first-last-frame-to-video',
      'fal-ai/veo3.1/first-last-frame-to-video',
    ])
  })

  it('offers Seedance every second from 4 to 30, and never "auto"', () => {
    // The cost lever, made real: 30s is roughly $14 at $0.473/s. `auto` is in
    // the schema and deliberately not here — it hands the length back to the
    // provider (PRD §6.3) and makes the estimate uncomputable (PRD §10.2).
    const seedance = modelById(
      MODEL_REGISTRY,
      'bytedance/seedance-2.5/image-to-video'
    )

    expect(seedance.durations).toHaveLength(27)
    expect(seedance.durations.at(0)).toBe('4')
    expect(seedance.durations.at(-1)).toBe('30')
    expect(seedance.durations).not.toContain('auto')
    expect(
      estimateCost(seedance, { aspect: '16:9', batch: 1, duration: '30' })
    ).toBeCloseTo(14.19)
  })

  it('never lists a duration it cannot turn into seconds', () => {
    // `validateRegistry` enforces this, which is also what keeps "auto" out:
    // an unparseable duration would defeat both the estimate and the wire form.
    for (const model of MODEL_REGISTRY) {
      for (const duration of model.durations) {
        expect(durationSeconds(duration), `${model.id} ${duration}`).not.toBe(
          null
        )
      }
    }
  })

  it('switches Seedance’s audio off, because it is billed and unwanted', () => {
    const seedance = modelById(
      MODEL_REGISTRY,
      'bytedance/seedance-2.5/image-to-video'
    )

    expect(seedance.defaults.generate_audio).toBe(false)
  })
})

describe('DEFAULT_MODEL_IDS', () => {
  it('names a real entry, at the right stage, for every stage', () => {
    for (const stage of STAGE_ORDER) {
      const model = modelById(MODEL_REGISTRY, DEFAULT_MODEL_IDS[stage])
      expect(model.stage, stage).toBe(stage)
    }
  })

  it('can serve every ratio a project is allowed to lock', () => {
    // A default that a new 21:9 project cannot use would mean the picker opens
    // on a refused model.
    for (const stage of STAGE_ORDER) {
      const model = modelById(MODEL_REGISTRY, DEFAULT_MODEL_IDS[stage])
      for (const aspect of ['16:9', '21:9', '2:1', '3:2', '1:1'] as const) {
        expect(
          modelAvailability(model, aspect).state,
          `${stage} @ ${aspect}`
        ).toBe('available')
      }
    }
  })
})
