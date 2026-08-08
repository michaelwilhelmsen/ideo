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
  estimateCost,
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
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
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

  it('says nothing rather than guessing when the model has no price', () => {
    // gpt-image-2 is token-priced; a made-up per-image figure would be worse
    // than silence (PRD §10.2).
    expect(estimateCost(model(), { aspect: '16:9', batch: 1 })).toBeNull()
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
