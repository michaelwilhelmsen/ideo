/**
 * The preset library, and the one function that turns a preset into a prompt.
 *
 * Two things are worth testing here and they pull in opposite directions. The
 * loader is about *refusing* data — a preset library is committed JSON, so a
 * typo in it is a startup crash rather than a prompt that quietly says less
 * than it meant to. `composePreset` is about producing exactly one string, and
 * the interesting cases are the two values that are deliberately *not* in it:
 * the negative, which must never be concatenated, and the strength, which comes
 * from the model unless the preset overrode it.
 */

import { describe, expect, it } from 'vitest'
import { MODEL_REGISTRY } from './models'
import {
  BUILT_IN_STYLE_PRESETS,
  composePreset,
  isPresetId,
  PRESET_STRENGTH_WINDOW,
  presetIdFrom,
  presetSeedState,
  presetSupportsModel,
  readPresetLibrary,
  readUserPreset,
  STYLE_PRESET_LIBRARY,
  stylePresetById,
  USER_PRESET_FAMILY,
  userPresetFrom,
  writeUserPreset,
  type PresetVariant,
  type StylePreset,
} from './presets'
import { modelById, modelsForStage, type ModelCapabilities } from './registry'

/** A well-formed document, so each test states only what it is about. */
function document(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    preserve: { tags: 'same composition', prose: null },
    presets: [preset()],
    ...overrides,
  }
}

function preset(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'test-preset',
    name: 'Test preset',
    family: 'test',
    variants: { tags: variant(), prose: null },
    ...overrides,
  }
}

function variant(overrides: Partial<PresetVariant> = {}): unknown {
  return {
    transform: 'a look',
    compose: '{preserve}, {transform}',
    negative: 'not that',
    strength: null,
    ...overrides,
  }
}

/** The tags exemplar: a real `negative_prompt`, no strength field (PRD §9). */
const QWEN = modelById(MODEL_REGISTRY, 'fal-ai/qwen-image-2/edit')

/** The one endpoint of 33 with a strength field (PRD §6.3). */
const FLUX_I2I = modelById(MODEL_REGISTRY, 'fal-ai/flux/dev/image-to-image')

/** A `tags` model carrying flux i2i's strength field, which no real one does. */
function tagsModelWithStrength(
  overrides: Partial<ModelCapabilities> = {}
): ModelCapabilities {
  return {
    ...FLUX_I2I,
    promptStyle: 'tags',
    ...overrides,
  }
}

function tagsPreset(
  variantOverrides: Partial<PresetVariant> = {}
): StylePreset {
  const library = readPresetLibrary(
    document({
      presets: [
        preset({ variants: { tags: variant(variantOverrides), prose: null } }),
      ],
    })
  )
  const only = library.presets[0]
  if (only === undefined) throw new Error('the fixture has no presets')
  return only
}

describe('the built-in library', () => {
  it('validates at import, or the module would not have loaded', () => {
    expect(BUILT_IN_STYLE_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(STYLE_PRESET_LIBRARY.presets).toBe(BUILT_IN_STYLE_PRESETS)
  })

  it('ships no texture-led look, because those are post-effects now', () => {
    // #36 owns grain, dither, halftone and duotone as deterministic kernels;
    // PRD §6.2 measured that asking a model for grain barely registers.
    const banned =
      /grain|halftone|dither|duotone|tritone|riso|scanline|vhs|crt|aberration/i

    for (const style of BUILT_IN_STYLE_PRESETS) {
      for (const idiom of ['tags', 'prose'] as const) {
        const carried = style.variants[idiom]
        expect(carried, `${style.id}/${idiom}`).not.toBeNull()
        expect(
          `${style.id} ${style.name} ${carried?.transform ?? ''}`,
          `${style.id}/${idiom}`
        ).not.toMatch(banned)
      }
    }
  })

  it('speaks both idioms, so no style model is left with nothing to seed', () => {
    // The registry's `promptStyle` splits the style stage: the two Qwen edits
    // read a keyword list, the six instruction-driven edits read prose. A
    // preset with only one variant would cover only one half of the stage.
    for (const style of BUILT_IN_STYLE_PRESETS) {
      expect(Object.keys(style.variants).sort(), style.id).toEqual([
        'prose',
        'tags',
      ])
      expect(style.variants.tags, style.id).not.toBeNull()
      expect(style.variants.prose, style.id).not.toBeNull()
    }
  })

  it('says the same thing in both idioms, negatives included', () => {
    // Two variants are two phrasings of one look, not two looks. The negative
    // is the same subtraction either way — only the positive body changes.
    for (const style of BUILT_IN_STYLE_PRESETS) {
      expect(style.variants.prose?.negative, style.id).toBe(
        style.variants.tags?.negative
      )
      expect(style.variants.prose?.strength, style.id).toBe(
        style.variants.tags?.strength
      )
      // Prose is prose: sentences, not the tag list with the commas kept.
      expect(style.variants.prose?.transform, style.id).toMatch(/\.$/)
    }
  })

  it('keeps every strength override inside the verified window', () => {
    for (const style of BUILT_IN_STYLE_PRESETS) {
      for (const idiom of ['tags', 'prose'] as const) {
        const strength = style.variants[idiom]?.strength ?? null
        if (strength === null) continue
        expect(strength, `${style.id}/${idiom}`).toBeGreaterThanOrEqual(
          PRESET_STRENGTH_WINDOW.min
        )
        expect(strength, `${style.id}/${idiom}`).toBeLessThanOrEqual(
          PRESET_STRENGTH_WINDOW.max
        )
      }
    }
  })

  it('finds a preset by id and refuses to invent one', () => {
    expect(stylePresetById('glass-caustics')?.name).toBe('Glass caustics')
    expect(stylePresetById('no-such-preset')).toBeNull()
    expect(stylePresetById(null)).toBeNull()
  })
})

describe('a preset document that is not what we expect', () => {
  it('accepts the well-formed one, or the rest of these prove nothing', () => {
    expect(readPresetLibrary(document()).presets).toHaveLength(1)
  })

  it('refuses a document that is not a document', () => {
    expect(() => readPresetLibrary(null)).toThrow()
    expect(() => readPresetLibrary([])).toThrow()
  })

  it('refuses a version it was not written to understand', () => {
    expect(() => readPresetLibrary(document({ version: 99 }))).toThrow(
      /version/i
    )
  })

  it('names the preset it could not read', () => {
    expect(() =>
      readPresetLibrary(document({ presets: [preset({ name: '  ' })] }))
    ).toThrow(/test-preset/)
  })

  it('refuses two presets sharing an id', () => {
    expect(() =>
      readPresetLibrary(document({ presets: [preset(), preset()] }))
    ).toThrow(/twice/i)
  })

  it('refuses a preset with no idiom any model can use', () => {
    expect(() =>
      readPresetLibrary(
        document({
          presets: [preset({ variants: { tags: null, prose: null } })],
        })
      )
    ).toThrow(/no prompt idiom/i)
  })

  /**
   * `preset-schema.md` §2: a field that does not apply is explicitly `null`,
   * never omitted, so the app can tell "this model's idiom is unsupported" from
   * "somebody forgot to write it down". The loader has to hold that line, or the
   * distinction is a comment rather than a rule.
   */
  it('tells a null variant from a missing one', () => {
    const missing = document({
      presets: [preset({ variants: { tags: variant() } })],
    })
    expect(() => readPresetLibrary(missing)).toThrow(/prose/)

    const explicit = document({
      presets: [preset({ variants: { tags: variant(), prose: null } })],
    })
    expect(readPresetLibrary(explicit).presets[0]?.variants.prose).toBeNull()
  })

  it('tells a null negative from a missing one', () => {
    const { negative: _dropped, ...withoutNegative } = variant() as Record<
      string,
      unknown
    >
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({ variants: { tags: withoutNegative, prose: null } }),
          ],
        })
      )
    ).toThrow(/negative/i)

    // Explicitly null is the normal case: a look that adds rather than
    // subtracts has nothing to put in the field.
    const library = readPresetLibrary(
      document({
        presets: [
          preset({
            variants: { tags: variant({ negative: null }), prose: null },
          }),
        ],
      })
    )

    expect(library.presets[0]?.variants.tags?.negative).toBeNull()
  })

  it('refuses a compose template that never places the transform', () => {
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({
              variants: {
                tags: variant({ compose: '{preserve}' }),
                prose: null,
              },
            }),
          ],
        })
      )
    ).toThrow(/\{transform\}/)
  })

  it('refuses a preserve placeholder the idiom has no block for', () => {
    // A template asking for a preserve block the library cannot supply would
    // compose a prompt with a hole in it — or worse, silently without the one
    // clause that separates a restyle from a reroll.
    expect(() =>
      readPresetLibrary(document({ preserve: { tags: null, prose: null } }))
    ).toThrow(/preserve/i)
  })

  it('refuses a strength override outside anything a model would accept', () => {
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({
              variants: { tags: variant({ strength: 4 }), prose: null },
            }),
          ],
        })
      )
    ).toThrow(/strength/i)
  })
})

describe('composePreset', () => {
  it('puts the preserve block in front of the transform, per the template', () => {
    const composed = composePreset(tagsPreset(), QWEN)

    expect(composed?.prompt).toBe('same composition, a look')
  })

  it('follows the preset’s own template rather than a rule in code', () => {
    // PRD §6.1 — assembly order is preset data, so a look that has to dominate
    // can lead with the style.
    const composed = composePreset(
      tagsPreset({ compose: '{transform}. {preserve}' }),
      QWEN
    )

    expect(composed?.prompt).toBe('a look. same composition')
  })

  it('returns nothing for a model whose idiom the preset does not support', () => {
    // Not an error and not a fallback: an explicit null means the preset has
    // nothing to say to a prose model, and the caller offers a re-seed instead
    // of composing something in the wrong idiom.
    expect(composePreset(tagsPreset(), FLUX_I2I)).toBeNull()
  })

  it('never folds the negative into the prompt', () => {
    // Settled 2026-08-09 (PRD §9): "no gradients" concatenated into a positive
    // prompt is a request for gradients.
    const composed = composePreset(
      tagsPreset({ negative: 'flat colour' }),
      QWEN
    )

    expect(composed?.negative).toBe('flat colour')
    expect(composed?.prompt).not.toContain('flat colour')
  })

  it('drops the negative on a model with no field to put it in', () => {
    const model = tagsModelWithStrength({ negativePromptParam: null })
    const composed = composePreset(
      tagsPreset({ negative: 'flat colour' }),
      model
    )

    expect(composed?.negative).toBeNull()
    expect(composed?.prompt).not.toContain('flat colour')
  })

  it('takes the strength the registry defaults to when the preset has none', () => {
    // PRD §6.3 — 0.7, never fal's 0.95.
    const composed = composePreset(tagsPreset(), tagsModelWithStrength())

    expect(composed?.strength).toBe(0.7)
  })

  it('has no strength at all on a model with no strength field', () => {
    // Only one endpoint of 33 has one, so null is the normal answer.
    expect(composePreset(tagsPreset({ strength: 0.7 }), QWEN)?.strength).toBe(
      null
    )
  })

  it('clamps a preset’s override to the verified window', () => {
    // Below 0.65 nothing happens; above 0.8 the composition drifts and at 0.95
    // the input is discarded (PRD §6.3). A preset may not ask for either.
    const model = tagsModelWithStrength()

    expect(composePreset(tagsPreset({ strength: 0.95 }), model)?.strength).toBe(
      PRESET_STRENGTH_WINDOW.max
    )
    expect(composePreset(tagsPreset({ strength: 0.2 }), model)?.strength).toBe(
      PRESET_STRENGTH_WINDOW.min
    )
    expect(composePreset(tagsPreset({ strength: 0.75 }), model)?.strength).toBe(
      0.75
    )
  })

  /**
   * #28's acceptance criterion: the same preset produces a styled result on
   * every style-stage model, via its own compose templates. Both halves of the
   * stage are exercised here — eight presets against every row the registry
   * lists, whichever idiom that row reads.
   */
  it('seeds every built-in on every style model the registry lists', () => {
    const models = modelsForStage(MODEL_REGISTRY, 'style')
    expect(models.length).toBeGreaterThanOrEqual(8)

    for (const model of models) {
      for (const style of BUILT_IN_STYLE_PRESETS) {
        const where = `${style.id} on ${model.id}`
        const composed = composePreset(style, model)

        if (composed === null) throw new Error(`${where} seeded nothing`)

        // A prompt with the look in it, led by the clause that keeps the
        // composition — the one thing separating a restyle from a reroll.
        expect(composed.prompt.length, where).toBeGreaterThan(60)
        expect(composed.prompt, where).not.toContain('{')

        const preserve = STYLE_PRESET_LIBRARY.preserve[model.promptStyle] ?? ''
        expect(composed.prompt.startsWith(preserve), where).toBe(true)
        expect(composed.prompt, where).toContain(
          style.variants[model.promptStyle]?.transform ?? ''
        )

        // Never in the body — routed or dropped, per the registry (PRD §9).
        const negative = style.variants[model.promptStyle]?.negative ?? null
        expect(composed.negative, where).toBe(
          model.negativePromptParam === null ? null : negative
        )

        // And a strength only where there is a field to put one in.
        expect(composed.strength === null, where).toBe(
          model.strengthParam === null
        )
      }
    }
  })

  it('composes a real preset on the real stage default', () => {
    const glass = stylePresetById('glass-caustics')
    if (glass === null) throw new Error('the built-in library lost a preset')

    const composed = composePreset(glass, QWEN)

    expect(composed?.prompt).toContain('caustic light patterns')
    expect(composed?.prompt.startsWith('same composition')).toBe(true)
    expect(composed?.negative).toBe(
      'opaque surface, flat lighting, matte finish'
    )
  })
})

/**
 * #28 — a preset is a seed, so the interesting question is not "which preset"
 * but "does the form still say what it seeded". That is asked of what is on
 * screen rather than of a recorded field, so these are the cases that make the
 * re-seed offer appear and disappear.
 */
describe('whether the form still says what the preset says', () => {
  it('offers a preset only in an idiom it speaks', () => {
    const tagsOnly = tagsPreset()

    expect(presetSupportsModel(tagsOnly, QWEN)).toBe(true)
    expect(presetSupportsModel(tagsOnly, FLUX_I2I)).toBe(false)
  })

  it('is seeded while the box holds the composed prompt', () => {
    const composed = composePreset(tagsPreset(), QWEN)

    expect(presetSeedState(composed?.prompt ?? '', tagsPreset(), QWEN)).toEqual(
      {
        state: 'seeded',
      }
    )
  })

  it('has nothing to say when no preset is selected', () => {
    expect(presetSeedState('anything', null, QWEN)).toEqual({ state: 'none' })
  })

  it('reports the model’s idiom as unsupported rather than offering a re-seed', () => {
    // Cross-sending is what the null variant exists to prevent, so there is no
    // re-seed to offer here — the picker disables the preset and says why.
    expect(presetSeedState('anything', tagsPreset(), FLUX_I2I).state).toBe(
      'unsupported'
    )
  })

  it('knows a box stranded by a model switch from one the user edited', () => {
    const bothIdioms = readPresetLibrary(
      document({
        presets: [
          preset({
            variants: {
              tags: variant({ compose: '{transform}', transform: 'a look' }),
              prose: variant({
                compose: '{transform}',
                transform: 'Make it look a certain way.',
              }),
            },
          }),
        ],
      })
    ).presets[0]
    if (bothIdioms === undefined) throw new Error('the fixture has no presets')

    // Seeded on Qwen, then switched to a prose model: the text is kept, and the
    // offer explains itself with the reason it is being made.
    const stranded = presetSeedState('a look', bothIdioms, FLUX_I2I)
    expect(stranded).toEqual({
      state: 'stale',
      reasonKey: 'editor.preset.staleIdiom',
    })

    expect(presetSeedState('my own words', bothIdioms, FLUX_I2I)).toEqual({
      state: 'stale',
      reasonKey: 'editor.preset.staleEdited',
    })
  })
})

/**
 * The fork flow's half of the library. A saved preset is a file in app data
 * that a user may hand-edit and that a repo update must never touch, so it is
 * read exactly as suspiciously as the committed one — and skipped rather than
 * fatal, because one bad file must not cost the whole library.
 */
describe('a saved fork', () => {
  const capture = {
    id: 'warm-dusk',
    name: 'Warm dusk',
    promptStyle: 'tags',
    prompt: 'same composition, warm dusk grade',
    negative: 'cold light',
    strength: 0.72,
  } as const

  it('round-trips through the file it is written to', () => {
    const saved = readUserPreset(writeUserPreset(userPresetFrom(capture)))

    expect(saved).toEqual(userPresetFrom(capture))
    expect(saved.family).toBe(USER_PRESET_FAMILY)
  })

  it('claims only the idiom of the model in front of it', () => {
    const fork = userPresetFrom(capture)

    expect(fork.variants.prose).toBeNull()
    expect(fork.variants.tags?.transform).toBe(capture.prompt)
    // Self-contained: what was captured is the whole composed prompt, so
    // composing it again must not re-apply a preserve block on top of one.
    expect(composePreset(fork, QWEN)?.prompt).toBe(capture.prompt)
  })

  it('carries the seeded fields the model had a place for', () => {
    const fork = userPresetFrom(capture)

    expect(composePreset(fork, QWEN)?.negative).toBe('cold light')
    // Qwen has no strength field, so the saved opinion is simply not routed.
    expect(composePreset(fork, QWEN)?.strength).toBeNull()
  })

  /**
   * Updating one in place. The fork on disk may speak both idioms — it was saved
   * once from a prose model and once from a tags one — and a save is a claim
   * about the form in front of you, never a claim that the other idiom has
   * stopped existing.
   */
  describe('updated in place', () => {
    /** A fork that has been taught both idioms, as the file holds it. */
    const both: StylePreset = {
      ...userPresetFrom(capture),
      variants: {
        tags: userPresetFrom(capture).variants.tags,
        prose: {
          transform: 'Grade it towards a warm dusk.',
          compose: '{transform}',
          negative: 'cold light',
          strength: 0.7,
        },
      },
    }

    it('rewrites the current idiom and keeps the other verbatim', () => {
      const updated = userPresetFrom(
        { ...capture, prompt: 'same composition, warmer dusk grade' },
        both
      )

      expect(updated.variants.tags?.transform).toBe(
        'same composition, warmer dusk grade'
      )
      expect(updated.variants.prose).toEqual(both.variants.prose)
    })

    it('teaches a one-idiom fork the other rather than replacing it', () => {
      const prose = modelById(MODEL_REGISTRY, 'fal-ai/flux/dev/image-to-image')
      const taught = userPresetFrom(
        {
          ...capture,
          promptStyle: prose.promptStyle,
          prompt: 'Grade it towards a warm dusk.',
        },
        userPresetFrom(capture)
      )

      expect(taught.variants.tags?.transform).toBe(capture.prompt)
      expect(composePreset(taught, prose)?.prompt).toBe(
        'Grade it towards a warm dusk.'
      )
    })

    it('claims one idiom only when there is no fork to update', () => {
      expect(userPresetFrom(capture).variants.prose).toBeNull()
    })
  })

  it('does not mistake an empty field for an opinion', () => {
    // An empty negative box and a strength field the model does not have both
    // arrive here as blanks; a fork that recorded them would read back as
    // "subtract nothing, at strength zero".
    const blank = userPresetFrom({ ...capture, negative: '  ', strength: 0 })

    expect(blank.variants.tags?.negative).toBeNull()
    expect(blank.variants.tags?.strength).toBeNull()
    expect(() => readUserPreset(writeUserPreset(blank))).not.toThrow()
  })

  it('refuses a document that is not a fork', () => {
    expect(() => readUserPreset(null)).toThrow()
    expect(() => readUserPreset({})).toThrow()
    expect(() =>
      readUserPreset({
        ...writeUserPreset(userPresetFrom(capture)),
        version: 9,
      })
    ).toThrow(/version/i)
  })

  it('refuses an id no file could be named', () => {
    expect(() =>
      readUserPreset({
        ...writeUserPreset(userPresetFrom(capture)),
        id: '../evil',
      })
    ).toThrow(/id/i)
  })

  it('refuses a fork that is not self-contained', () => {
    // A saved fork carries the preserve wording it was saved with. One still
    // asking for `{preserve}` would compose a prompt with a hole in it, because
    // a fork has no library-level block to fill it from.
    expect(() =>
      readUserPreset({
        version: 1,
        id: 'half-written',
        name: 'Half written',
        family: 'user',
        variants: {
          prose: null,
          tags: {
            transform: 'a look',
            compose: '{preserve}, {transform}',
            negative: null,
            strength: null,
          },
        },
      })
    ).toThrow(/preserve/i)
  })
})

describe('minting an id for a fork', () => {
  it('slugifies the name into something Rust will accept', () => {
    const id = presetIdFrom('Warm dusk — grade #2', [])

    expect(isPresetId(id)).toBe(true)
    expect(id).toBe('warm-dusk-grade-2')
  })

  it('suffixes rather than overwriting an id already in use', () => {
    // Two forks called "Warmer" are two forks. Overwriting would break the one
    // promise the user library makes.
    expect(presetIdFrom('Warmer', ['warmer'])).toBe('warmer-2')
    expect(presetIdFrom('Warmer', ['warmer', 'warmer-2'])).toBe('warmer-3')
  })

  it('never collides with a built-in either', () => {
    const taken = BUILT_IN_STYLE_PRESETS.map(builtIn => builtIn.id)
    const id = presetIdFrom('Glass caustics', taken)

    expect(taken).not.toContain(id)
    expect(id).toBe('glass-caustics-2')
  })

  it('still produces an id for a name it cannot slugify', () => {
    // The name is what is shown; the id only has to be a file name.
    expect(presetIdFrom('日本語', [])).toBe('preset')
    expect(presetIdFrom('!!!', ['preset'])).toBe('preset-2')
  })

  it('keeps an id short enough to be a file name', () => {
    const id = presetIdFrom('a'.repeat(200), [])

    expect(isPresetId(id)).toBe(true)
    expect(id.length).toBeLessThanOrEqual(48)
  })
})
