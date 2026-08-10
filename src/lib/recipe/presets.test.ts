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
import { ASPECTS } from './aspects'
import { DEFAULT_MODEL_IDS, MODEL_REGISTRY } from './models'
import {
  BUILT_IN_SOURCE_PRESETS,
  BUILT_IN_STYLE_PRESETS,
  composePreset,
  isPresetId,
  PRESET_STRENGTH_WINDOW,
  presetIdFrom,
  presetSeedState,
  presetSupportsModel,
  readPresetLibrary,
  readUserPreset,
  SOURCE_PRESET_LIBRARY,
  sourcePresetById,
  STYLE_PRESET_LIBRARY,
  stylePresetById,
  USER_PRESET_FAMILY,
  userPresetFrom,
  writeUserPreset,
  type Preset,
  type PresetVariant,
} from './presets'
import { modelById, modelsForStage, type ModelCapabilities } from './registry'
import type { AspectId } from './types'

/** The one v4 generate recipe that wants lettering, so opts out of `append`. */
const TEXT_EXCEPTION = 'gn-isometric-lineup'

/**
 * A well-formed document, so each test states only what it is about.
 *
 * An override of `undefined` **removes** the key rather than setting it, the way
 * `JSON.stringify` would — these documents stand in for files on disk, and a
 * file cannot hold `undefined`. That distinction is load-bearing here: whether a
 * library declares a block at all is a different question from what the block
 * says.
 */
function document(overrides: Record<string, unknown> = {}): unknown {
  return asDocument({
    version: 1,
    preserve: { tags: 'same composition', prose: null },
    presets: [preset()],
    ...overrides,
  })
}

function preset(overrides: Record<string, unknown> = {}): unknown {
  return asDocument({
    id: 'test-preset',
    name: 'Test preset',
    family: 'test',
    variants: { tags: variant(), prose: null },
    ...overrides,
  })
}

function asDocument(record: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  )
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

/** What a new project's source stage starts on. */
const SOURCE_DEFAULT = modelById(MODEL_REGISTRY, DEFAULT_MODEL_IDS.source)

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

function tagsPreset(variantOverrides: Partial<PresetVariant> = {}): Preset {
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

  it('has a preserve block and no append block', () => {
    // Which block a library declares is the whole difference between the two
    // (#47). A style preset restyles somebody else's composition, so it has
    // something to preserve and nothing standing to append.
    expect(STYLE_PRESET_LIBRARY.preserve).not.toBeNull()
    expect(STYLE_PRESET_LIBRARY.append).toBeNull()
  })

  it('says nothing about aspect, because a restyle inherits its frame', () => {
    for (const style of BUILT_IN_STYLE_PRESETS) {
      expect(style.aspect, style.id).toBeNull()
    }
  })
})

/**
 * The source library — the same type and the same loader as the style one,
 * differing by the block it declares and by carrying an aspect hint (#47).
 */
describe('the built-in source library', () => {
  it('validates at import, or the module would not have loaded', () => {
    expect(BUILT_IN_SOURCE_PRESETS.length).toBeGreaterThanOrEqual(4)
    expect(SOURCE_PRESET_LIBRARY.presets).toBe(BUILT_IN_SOURCE_PRESETS)
  })

  it('has an append block and no preserve block', () => {
    // The mirror of the style library's assertion. There is no composition to
    // preserve when the recipe *is* the composition.
    expect(SOURCE_PRESET_LIBRARY.append).not.toBeNull()
    expect(SOURCE_PRESET_LIBRARY.preserve).toBeNull()
  })

  it('is a different library from style, not the same list twice', () => {
    // The conflation #47 exists to break: source borrowed the style list, which
    // asked a text-to-image model to preserve a composition that did not exist.
    const styleIds = new Set(BUILT_IN_STYLE_PRESETS.map(preset => preset.id))

    for (const source of BUILT_IN_SOURCE_PRESETS) {
      expect(styleIds.has(source.id), source.id).toBe(false)
    }
  })

  it('speaks both idioms, so no source model is left with nothing to seed', () => {
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      expect(source.variants.tags, source.id).not.toBeNull()
      expect(source.variants.prose, source.id).not.toBeNull()
    }
  })

  it('names an aspect it was composed for, from the curated list', () => {
    const offered = new Set(ASPECTS.map(aspect => aspect.id))

    for (const source of BUILT_IN_SOURCE_PRESETS) {
      expect(source.aspect, source.id).not.toBeNull()
      expect(offered.has(source.aspect as AspectId), source.id).toBe(true)
    }

    // More than one, or the hint would be proving nothing about the picker not
    // sorting or dimming on it.
    expect(
      new Set(BUILT_IN_SOURCE_PRESETS.map(source => source.aspect)).size
    ).toBeGreaterThan(1)
  })

  it('appends the no-text clause to every scene that wants it', () => {
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      if (source.id === TEXT_EXCEPTION) continue

      for (const idiom of ['tags', 'prose'] as const) {
        const appended = SOURCE_PRESET_LIBRARY.append?.[idiom] ?? ''
        expect(appended, idiom).not.toBe('')
        expect(
          source.variants[idiom]?.compose,
          `${source.id}/${idiom}`
        ).toContain(appended)
      }
    }
  })

  it('leaves the one scene that wants lettering out of it', () => {
    // The opt-out is the mechanism preserve already had: a preset that does not
    // want the block leaves the placeholder out of its own template. No flag, no
    // second mechanism.
    const labelled = sourcePresetById(TEXT_EXCEPTION)
    if (labelled === null) throw new Error('the proving set lost its exception')

    for (const idiom of ['tags', 'prose'] as const) {
      const appended = SOURCE_PRESET_LIBRARY.append?.[idiom] ?? ''
      expect(labelled.variants[idiom]?.compose, idiom).not.toContain(appended)
    }
  })

  it('seeds every built-in on every source model the registry lists', () => {
    const models = modelsForStage(MODEL_REGISTRY, 'source')
    expect(models.length).toBeGreaterThanOrEqual(4)

    for (const model of models) {
      for (const source of BUILT_IN_SOURCE_PRESETS) {
        const where = `${source.id} on ${model.id}`
        const composed = composePreset(source, model)

        if (composed === null) throw new Error(`${where} seeded nothing`)

        // Every slot resolved. `{{…}}` survives on purpose — see below — so
        // this is about the single-brace slots the loader owns.
        expect(composed.prompt.replaceAll(/\{\{|\}\}/g, ''), where).not.toMatch(
          /[{}]/
        )
        expect(composed.prompt, where).toContain(
          source.variants[model.promptStyle]?.transform ?? ''
        )

        // Never in the body — routed or dropped, per the registry (PRD §9).
        const negative = source.variants[model.promptStyle]?.negative ?? null
        expect(composed.negative, where).toBe(
          model.negativePromptParam === null ? null : negative
        )
      }
    }
  })

  it('seeds a template variable literally, until #46 can resolve it', () => {
    // #46 owns the palette and the resolution; this library only has to carry
    // the holes. Unresolved, `{{subject}}` arrives in the prompt box as those
    // nine characters — visible and editable like any other text, which is what
    // #46 settled on for a placeholder it cannot fill either.
    const withVariables = BUILT_IN_SOURCE_PRESETS.filter(source =>
      Object.values(source.variants).some(carried =>
        carried?.transform.includes('{{')
      )
    )
    expect(withVariables.length).toBeGreaterThan(0)

    const monolith = sourcePresetById('gn-monolith')
    if (monolith === null) throw new Error('the proving set lost a scene')

    expect(composePreset(monolith, SOURCE_DEFAULT)?.prompt).toContain(
      '{{subject}}'
    )
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

  it('refuses an append placeholder the idiom has no block for', () => {
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({
              variants: {
                tags: variant({ compose: '{transform}, {append}' }),
                prose: null,
              },
            }),
          ],
        })
      )
    ).toThrow(/append/i)
  })

  /**
   * A library declaring neither block is not the same mistake as a block that
   * forgot an idiom. The first is a library whose presets are all self-contained;
   * the second is data nobody finished writing.
   */
  it('tells a library with no such block from a block missing an idiom', () => {
    const noBlocks = readPresetLibrary(
      document({
        preserve: undefined,
        presets: [
          preset({
            variants: {
              tags: variant({ compose: '{transform}' }),
              prose: null,
            },
          }),
        ],
      })
    )
    expect(noBlocks.preserve).toBeNull()
    expect(noBlocks.append).toBeNull()

    expect(() =>
      readPresetLibrary(document({ append: { tags: 'no text' } }))
    ).toThrow(/prose append/i)
  })

  it('resolves the append block into the template, once, at load', () => {
    const library = readPresetLibrary(
      document({
        preserve: undefined,
        append: { tags: 'no text', prose: null },
        presets: [
          preset({
            variants: {
              tags: variant({ compose: '{transform}, {append}' }),
              prose: null,
            },
          }),
        ],
      })
    )

    expect(library.presets[0]?.variants.tags?.compose).toBe(
      '{transform}, no text'
    )
  })

  /**
   * The one style recipe wanting stricter preserve wording (v4's `rs-blueprint`)
   * needs no new mechanism: it omits `{preserve}` and writes its own clause into
   * its own template. Proved here rather than shipped as content, because the
   * content is #48's.
   */
  it('lets a preset carry stricter wording in its own template', () => {
    const strict =
      'Preserve the exact silhouette and edge position of every object.'
    const library = readPresetLibrary(
      document({
        presets: [
          preset({
            variants: {
              tags: variant({ compose: `${strict} {transform}` }),
              prose: null,
            },
          }),
        ],
      })
    )

    const only = library.presets[0]
    if (only === undefined) throw new Error('the fixture has no presets')

    expect(composePreset(only, QWEN)?.prompt).toBe(`${strict} a look`)
    // And the library's standard block is nowhere in it.
    expect(composePreset(only, QWEN)?.prompt).not.toContain('same composition')
  })

  it('refuses an aspect hint that is not a ratio we offer', () => {
    expect(() =>
      readPresetLibrary(document({ presets: [preset({ aspect: '4:5' })] }))
    ).toThrow(/aspect/i)
  })

  it('takes a missing aspect as no hint, since most presets have none', () => {
    expect(readPresetLibrary(document()).presets[0]?.aspect).toBeNull()
    expect(
      readPresetLibrary(document({ presets: [preset({ aspect: '21:9' })] }))
        .presets[0]?.aspect
    ).toBe('21:9')
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

        const preserve =
          STYLE_PRESET_LIBRARY.preserve?.[model.promptStyle] ?? ''
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
    aspect: null,
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
    const both: Preset = {
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
