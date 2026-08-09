/**
 * The registry's rules, checked against the three aspect idioms the live
 * schemas actually use (`docs/research/model-schemas.md`).
 *
 * The interesting cases are all arithmetic: a free-dimension model is not
 * "compatible with 21:9" as a fact you can look up, it is compatible if a
 * legal size at exactly 7:3 exists inside its bounds. That calculation is the
 * thing #25 added and the thing that can silently go wrong.
 */

import { describe, expect, it } from 'vitest'
import {
  aspectRequestFields,
  controlAvailability,
  declaresParam,
  estimateCost,
  imageParamShape,
  legalSizeFor,
  modelAvailability,
  reconcileParams,
  serializeDuration,
  validateRegistry,
  type DimensionConstraints,
  type ModelCapabilities,
} from './registry'

/** A minimal well-formed entry, so each test states only what it is about. */
function model(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    id: 'test/model',
    label: 'Test model',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    supportsSeed: true,
    imageParam: null,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: null,
    notes: 'A fixture.',
    ...overrides,
  }
}

const UNCONSTRAINED: DimensionConstraints = {
  multipleOf: 16,
  minEdge: 256,
  maxEdge: 4096,
  minPixels: 65_536,
  maxPixels: 16_777_216,
  maxRatio: null,
}

describe('legalSizeFor', () => {
  it('reaches 21:9 exactly rather than approximately', () => {
    // 7:3 in lowest terms — a size that is merely close would break the lock
    // the project put on its ratio (PRD §4.4).
    const size = legalSizeFor(UNCONSTRAINED, '21:9')

    if (size === null) throw new Error('21:9 should be reachable')
    expect(size.width / size.height).toBe(21 / 9)
    expect(size.width % 16).toBe(0)
    expect(size.height % 16).toBe(0)
  })

  it('finds flux-2-pro the largest legal 21:9 inside its declared bounds', () => {
    // Multiples of 16, 256–2560 per side, ≤ 4.19 MP. On that grid 21:9 steps
    // in units of 112×48, so the ceiling is the 22nd step. The doc's worked
    // example, 2352×1008, is the 21st — also legal, just not the largest.
    const size = legalSizeFor(
      {
        multipleOf: 16,
        minEdge: 256,
        maxEdge: 2560,
        minPixels: 65_536,
        maxPixels: 4_194_304,
        maxRatio: null,
      },
      '21:9'
    )

    expect(size).toEqual({ width: 2464, height: 1056 })
    expect(2464 / 1056).toBe(21 / 9)
  })

  it('refuses a ratio the model declares it will not go past', () => {
    // gpt-image-2 caps at 3:1. 21:9 is 2.33:1, so it passes; a hypothetical
    // 4:1 would not — checked here through the cap itself.
    expect(legalSizeFor({ ...UNCONSTRAINED, maxRatio: 2 }, '21:9')).toBeNull()
    expect(
      legalSizeFor({ ...UNCONSTRAINED, maxRatio: 3 }, '21:9')
    ).not.toBeNull()
  })

  it('refuses a ratio no size inside the pixel budget can express', () => {
    const tiny = { ...UNCONSTRAINED, maxPixels: 10_000 }

    expect(legalSizeFor(tiny, '21:9')).toBeNull()
  })

  it('stays inside every bound it is given', () => {
    const constraints: DimensionConstraints = {
      multipleOf: 16,
      minEdge: 256,
      maxEdge: 2560,
      minPixels: 262_144,
      maxPixels: 4_194_304,
      maxRatio: 3,
    }

    for (const aspect of ['16:9', '21:9', '2:1', '3:2', '1:1'] as const) {
      const size = legalSizeFor(constraints, aspect)
      if (size === null) throw new Error(`no legal size for ${aspect}`)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2560)
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(256)
      expect(size.width * size.height).toBeLessThanOrEqual(4_194_304)
    }
  })
})

/**
 * #28 — the style stage splits three ways on how the image field is *shaped*,
 * and the wrong primitive is a 422 at the one step that costs money.
 */
describe('imageParamShape', () => {
  it('reads a single url from the singular name and an array from the plural', () => {
    expect(imageParamShape(model({ imageParam: 'image_url' }))).toBe('url')
    expect(imageParamShape(model({ imageParam: 'image_urls' }))).toBe(
      'urlArray'
    )
  })

  it('has nothing to say about a model that takes no image', () => {
    expect(imageParamShape(model())).toBeNull()
  })

  it('knows all three spellings the video endpoints use for a start frame', () => {
    // #29 — the still to animate goes in `image_url` on five of the eight
    // endpoints, `start_image_url` on two and `first_frame_url` on one. All
    // three are a single URL; a name missing from the table is a startup crash.
    for (const param of ['image_url', 'start_image_url', 'first_frame_url']) {
      expect(imageParamShape(model({ imageParam: param })), param).toBe('url')
    }
  })

  it('refuses to guess at a name nobody has recorded', () => {
    // `null` here is what `validateRegistry` turns into a startup crash.
    expect(
      imageParamShape(model({ imageParam: 'reference_images' }))
    ).toBeNull()
  })
})

describe('modelAvailability', () => {
  it('serves any ratio when the model inherits its geometry', () => {
    const kling = model({ aspects: { kind: 'inheritsFromSource' } })

    expect(modelAvailability(kling, '21:9').state).toBe('available')
    expect(modelAvailability(kling, '2:1').state).toBe('available')
  })

  it('refuses a ratio missing from an enum, with a reason', () => {
    const veo = model({
      aspects: {
        kind: 'ratioEnum',
        param: 'aspect_ratio',
        values: { '16:9': '16:9' },
      },
    })

    expect(modelAvailability(veo, '16:9').state).toBe('available')

    const refused = modelAvailability(veo, '21:9')
    expect(refused).toEqual({
      state: 'disabled',
      reasonKey: 'editor.reason.aspectUnsupported',
    })
  })

  it('decides a free-dimension model by arithmetic, not by a ratio list', () => {
    const roomy = model({
      aspects: {
        kind: 'freeDimensions',
        param: 'image_size',
        constraints: UNCONSTRAINED,
      },
    })
    const cramped = model({
      aspects: {
        kind: 'freeDimensions',
        param: 'image_size',
        constraints: { ...UNCONSTRAINED, maxRatio: 1.5 },
      },
    })

    expect(modelAvailability(roomy, '21:9').state).toBe('available')
    expect(modelAvailability(cramped, '21:9').state).toBe('disabled')
    expect(modelAvailability(cramped, '1:1').state).toBe('available')
  })
})

describe('aspectRequestFields', () => {
  it('sends the provider’s own token, which need not be our ratio id', () => {
    const tokenised = model({
      aspects: {
        kind: 'ratioEnum',
        param: 'image_size',
        values: { '16:9': 'landscape_16_9' },
      },
    })

    expect(aspectRequestFields(tokenised, '16:9')).toEqual({
      image_size: 'landscape_16_9',
    })
  })

  it('sends explicit dimensions for a free-dimension model', () => {
    const free = model({
      aspects: {
        kind: 'freeDimensions',
        param: 'image_size',
        constraints: UNCONSTRAINED,
      },
    })

    const fields = aspectRequestFields(free, '1:1')

    expect(fields).toEqual({ image_size: { width: 4096, height: 4096 } })
  })

  it('sends nothing at all when geometry comes from the input image', () => {
    expect(aspectRequestFields(model(), '21:9')).toEqual({})
  })

  it('throws rather than sending a ratio the model cannot serve', () => {
    const veo = model({
      aspects: {
        kind: 'ratioEnum',
        param: 'aspect_ratio',
        values: { '16:9': '16:9' },
      },
    })

    expect(() => aspectRequestFields(veo, '21:9')).toThrow('21:9')
  })
})

describe('serializeDuration', () => {
  // PRD §5 — the wrong primitive is a 422, and all three idioms are live.
  it('sends Kling an integer', () => {
    const kling = model({
      stage: 'animate',
      durationParam: 'duration',
      durations: ['3', '5'],
      durationFormat: 'integer',
    })

    expect(serializeDuration(kling, '5')).toBe(5)
  })

  it('sends Veo a second-suffixed string', () => {
    const veo = model({
      stage: 'animate',
      durationParam: 'duration',
      durations: ['4s', '8s'],
      durationFormat: 'secondsSuffixed',
    })

    expect(serializeDuration(veo, '8s')).toBe('8s')
    expect(serializeDuration(veo, '8')).toBe('8s')
  })

  it('sends a bare-string model a bare string, not a number', () => {
    const bare = model({
      stage: 'animate',
      durationParam: 'duration',
      durations: ['5'],
      durationFormat: 'string',
    })

    expect(serializeDuration(bare, '5s')).toBe('5')
  })
})

describe('reconcileParams', () => {
  it('carries a value across models that share the field name', () => {
    const target = model({
      strengthParam: 'strength',
      defaults: { strength: 0.7 },
    })

    expect(reconcileParams(target, { strength: 0.8 })).toEqual({
      strength: 0.8,
    })
  })

  it('drops a value the new model has never heard of', () => {
    // Kling's `duration` must not survive onto Luma, where the same concept is
    // spelled "5s" and the bare integer is a 422.
    const luma = model({
      stage: 'animate',
      durationParam: 'duration',
      durations: ['5s', '9s'],
      durationFormat: 'secondsSuffixed',
      defaults: { duration: '5s' },
    })

    expect(reconcileParams(luma, { negative_prompt: 'blurry' })).toEqual({
      duration: '5s',
    })
  })

  it('replaces a missing value with ours, never the provider’s', () => {
    // PRD §6.3 — fal defaults strength to 0.95, which discards the input.
    const restyle = model({
      stage: 'style',
      strengthParam: 'strength',
      defaults: { strength: 0.7 },
    })

    expect(reconcileParams(restyle, {})).toEqual({ strength: 0.7 })
  })
})

describe('estimateCost', () => {
  it('multiplies a per-image price by the batch', () => {
    const perImage = model({
      price: { amount: 0.04, unit: 'image', verifiedOn: '2026-08-09' },
    })

    expect(estimateCost(perImage, { aspect: '16:9', batch: 4 })).toBeCloseTo(
      0.16
    )
  })

  it('rounds a per-megapixel price up, the way fal bills it', () => {
    const perMegapixel = model({
      aspects: {
        kind: 'freeDimensions',
        param: 'image_size',
        constraints: {
          multipleOf: 16,
          minEdge: 256,
          maxEdge: 2560,
          minPixels: 65_536,
          maxPixels: 4_194_304,
          maxRatio: null,
        },
      },
      price: { amount: 0.04, unit: 'megapixel', verifiedOn: '2026-08-09' },
    })

    // 2352×1008 is 2.37 MP, billed as 3.
    expect(
      estimateCost(perMegapixel, { aspect: '21:9', batch: 1 })
    ).toBeCloseTo(0.12)
  })

  it('multiplies a per-second price by the chosen duration', () => {
    const perSecond = model({
      stage: 'animate',
      durationParam: 'duration',
      durations: ['5', '10'],
      durationFormat: 'integer',
      defaults: { duration: '5' },
      price: { amount: 0.112, unit: 'second', verifiedOn: '2026-08-09' },
    })

    expect(
      estimateCost(perSecond, { aspect: '16:9', batch: 1, duration: '10' })
    ).toBeCloseTo(1.12)
    // Falls back to our default when the draft has not chosen one.
    expect(estimateCost(perSecond, { aspect: '16:9', batch: 1 })).toBeCloseTo(
      0.56
    )
  })

  it('moves with the duration, which is what makes the length a cost lever', () => {
    // #29 — Seedance's widened enum is the reason the control is worth having:
    // the two ends of it are $1.89 and $14.19, and the estimate has to say so
    // before the click (PRD §10.2).
    const seedance = model({
      stage: 'animate',
      imageParam: 'image_url',
      durationParam: 'duration',
      durations: ['4', '30'],
      durationFormat: 'string',
      defaults: { duration: '4' },
      price: { amount: 0.473, unit: 'second', verifiedOn: '2026-08-09' },
    })

    expect(
      estimateCost(seedance, { aspect: '16:9', batch: 1, duration: '4' })
    ).toBeCloseTo(1.892)
    expect(
      estimateCost(seedance, { aspect: '16:9', batch: 1, duration: '30' })
    ).toBeCloseTo(14.19)
  })

  it('says nothing rather than guessing when the model has no price', () => {
    // gpt-image-2 is token-priced; a made-up per-image figure would be worse
    // than silence (PRD §10.2).
    expect(estimateCost(model(), { aspect: '16:9', batch: 1 })).toBeNull()
  })
})

/**
 * PRD §10.1's three states, on the two controls that promise something the
 * request builder does not send yet (#30).
 *
 * These are the assertions that stop a switch selling a feature: `buildRequest`
 * never reads `options.loop` or `options.rewind`, so an available loop toggle
 * would take money for a clip that ends where it ends. When #30 lands, the two
 * "not ready" cases below are the ones that change.
 */
describe('controlAvailability — loop and rewind (#30)', () => {
  it('disables looping on a model that has an end frame, and says why', () => {
    const availability = controlAvailability(
      model({ endFrameParam: 'end_image_url' }),
      'loop'
    )

    expect(availability).toEqual({
      state: 'disabled',
      reasonKey: 'editor.reason.loopNotReady',
    })
  })

  it('still blames the missing field on a model that has none', () => {
    // Two different refusals, and the model-shaped one stays the truer answer:
    // #30 will not make a loop possible on a model with nowhere to put the
    // second frame.
    expect(controlAvailability(model(), 'loop')).toEqual({
      state: 'disabled',
      reasonKey: 'editor.reason.noEndFrame',
    })
  })

  it('disables rewind everywhere, end frame or not', () => {
    // Rewind is an ffmpeg pass rather than a registry column (PRD §4.5), so it
    // is not the model that is missing anything — the pass ships with #30.
    for (const endFrameParam of [null, 'end_image_url']) {
      expect(controlAvailability(model({ endFrameParam }), 'rewind')).toEqual({
        state: 'disabled',
        reasonKey: 'editor.reason.rewindNotReady',
      })
    }
  })

  it('leaves the controls it does not gate alone', () => {
    // The guard above is about two switches, not about the panel: a regression
    // that disabled everything would otherwise pass the three tests above.
    expect(controlAvailability(model(), 'seed')).toEqual({
      state: 'available',
    })
    expect(
      controlAvailability(
        model({
          durationParam: 'duration',
          durations: ['5'],
          durationFormat: 'string',
        }),
        'duration'
      )
    ).toEqual({ state: 'available' })
  })
})

describe('validateRegistry', () => {
  it('accepts a well-formed registry unchanged', () => {
    const registry = [model()]

    expect(validateRegistry(registry)).toBe(registry)
  })

  it('names the offending entry when something is wrong', () => {
    expect(() =>
      validateRegistry([model({ id: 'fal-ai/broken', label: '  ' })])
    ).toThrow(/fal-ai\/broken/)
  })

  it('refuses two entries claiming the same id', () => {
    expect(() => validateRegistry([model(), model()])).toThrow(/declared twice/)
  })

  it('refuses a duration enum with no format to send it in', () => {
    expect(() =>
      validateRegistry([
        model({
          durationParam: 'duration',
          durations: ['5'],
          durationFormat: null,
        }),
      ])
    ).toThrow(/durationFormat/)
  })

  it('refuses a default for a parameter the model does not have', () => {
    expect(() =>
      validateRegistry([model({ defaults: { strength: 0.7 } })])
    ).toThrow(/undeclared parameter "strength"/)
  })

  // The blind spot a shared whitelist of "extras" used to open: every name on
  // it counted as declared on every model, so both the check above and the
  // request builder's filter waved these through.
  it('refuses an extra-parameter default the model has not opted into', () => {
    expect(() =>
      validateRegistry([model({ defaults: { guidance_scale: 3.5 } })])
    ).toThrow(/undeclared parameter "guidance_scale"/)
  })

  it('accepts one the model opts into by name', () => {
    expect(() =>
      validateRegistry([
        model({
          extraParams: ['guidance_scale'],
          defaults: { guidance_scale: 3.5 },
        }),
      ])
    ).not.toThrow()
  })

  it('refuses an unnamed extra parameter', () => {
    expect(() => validateRegistry([model({ extraParams: [' '] })])).toThrow(
      /unnamed extra parameter/
    )
  })

  it('refuses a default the model does not offer', () => {
    expect(() =>
      validateRegistry([
        model({
          durationParam: 'duration',
          durations: ['5s', '9s'],
          durationFormat: 'secondsSuffixed',
          defaults: { duration: '7s' },
        }),
      ])
    ).toThrow(/not offered/)
  })

  it('refuses an undated price, because the date is what makes it honest', () => {
    expect(() =>
      validateRegistry([
        model({ price: { amount: 0.04, unit: 'image', verifiedOn: 'august' } }),
      ])
    ).toThrow(/undated price/)
  })

  /**
   * #28 — the source image has to reach fal under the model's own field name,
   * and the three rules below are the ones a careless row breaks: a style model
   * with nowhere to put the image, a source model claiming an input it cannot
   * take, and a name that is only whitespace.
   */
  it('refuses a style model with no image parameter', () => {
    expect(() =>
      validateRegistry([model({ stage: 'style', imageParam: null })])
    ).toThrow(/no image parameter/)
  })

  it('refuses an animate model with nowhere to put the still', () => {
    // #29 — the same rule one stage later. A video model that never receives
    // the still would bill for a text-to-video of the motion prompt.
    expect(() =>
      validateRegistry([model({ stage: 'animate', imageParam: null })])
    ).toThrow(/no image parameter/)
  })

  it('refuses a model that requires an end frame it has no field for', () => {
    expect(() =>
      validateRegistry([
        model({
          stage: 'animate',
          imageParam: 'image_url',
          endFrameParam: null,
          endFrameRequired: true,
        }),
      ])
    ).toThrow(/names no field to put one in/)
  })

  it('refuses a source model claiming an input image', () => {
    expect(() =>
      validateRegistry([model({ stage: 'source', imageParam: 'image_url' })])
    ).toThrow(/no input image/)
  })

  it('refuses an unnamed image parameter', () => {
    expect(() =>
      validateRegistry([model({ stage: 'style', imageParam: ' ' })])
    ).toThrow(/unnamed image parameter/)
  })

  it('refuses an image field whose shape nobody has recorded', () => {
    // The name decides whether a string or an array goes on the wire (#28), so
    // a model with a differently-named input is a crash that asks for its shape
    // rather than a guess that ships and 422s at the paid step.
    expect(() =>
      validateRegistry([
        model({ stage: 'style', imageParam: 'reference_images' }),
      ])
    ).toThrow(/whose shape is not recorded/)
  })

  it('counts the image field as one the model declares', () => {
    // The request builder filters a persisted draft against this set, so a
    // field the registry knows about must not be dropped on the way to fal.
    expect(
      declaresParam(
        model({ stage: 'style', imageParam: 'image_url' }),
        'image_url'
      )
    ).toBe(true)
    expect(declaresParam(model(), 'image_url')).toBe(false)
  })

  it('refuses an aspect enum that serves nothing', () => {
    expect(() =>
      validateRegistry([
        model({
          aspects: { kind: 'ratioEnum', param: 'aspect_ratio', values: {} },
        }),
      ])
    ).toThrow(/no ratios/)
  })

  it('refuses dimension bounds that admit none of the curated ratios', () => {
    expect(() =>
      validateRegistry([
        model({
          aspects: {
            kind: 'freeDimensions',
            param: 'image_size',
            constraints: {
              ...UNCONSTRAINED,
              minEdge: 1,
              maxEdge: 15,
              minPixels: 1,
            },
          },
        }),
      ])
    ).toThrow(/none of the curated ratios/)
  })
})
