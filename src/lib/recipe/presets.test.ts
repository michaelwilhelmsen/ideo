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
  colourNameOf,
  namesPaletteSlot,
  nearestColourName,
  readPalette,
  type Palette,
} from './palette'
import { DEFAULT_PALETTE } from './palettes'
import {
  BUILT_IN_SOURCE_PRESETS,
  BUILT_IN_STYLE_PRESETS,
  composePreset,
  unresolvedVariables,
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

  it('says out loud where a look is only half done without #36', () => {
    // The inverse of the rule #28's proving set followed. That set shipped no
    // texture-led look at all, because PRD §6.2 measured that asking a model
    // for grain barely registers and #36 owns the deterministic kernels. #48
    // brings the reduction and print families in anyway, and the reason it is
    // not a reversal is this: the model does the *reduction*, which it is good
    // at, and the recipe carries a note saying the dither is still to come.
    //
    // So the assertion is not "no dither" any more. It is that a preset asking
    // to be dithered says so — silence there is the failure, because a two-ink
    // reduction nobody dithered reads as a preset that came out wrong.
    //
    // Over **both** libraries, and keyed on the recipe rather than on its
    // family. The two scenes are filed under `illustration` and the two looks
    // under `reduction`, so a check that keys on family sees half of them and
    // reports the other half as fine — which is exactly how the count in this
    // module's own header comment drifted to "four" on a library holding two.
    //
    // `ordered bayer` is in the note check because a Bayer matrix *is* ordered
    // dithering — the source note names the kernel where the style note names
    // the effect, and a check that only knew the word "dither" would call the
    // terser of the two a preset with no note worth reading.
    const wantsPost = /\bdither|halftone dot|two-entry palette|ordered bayer/i
    const everyBuiltIn = [...BUILT_IN_SOURCE_PRESETS, ...BUILT_IN_STYLE_PRESETS]

    // Two ways a recipe can be one the model cannot finish, and a note is owed
    // for either. A **hard quantise** — no third colour, no tone between the two
    // inks — is a palette reduction #36 does exactly and a model approximates.
    // **Tone from density alone** is the same problem one step on: the greys
    // have to come out of a dot pattern rather than out of grey paint, which is
    // #36's ordered screen.
    //
    // Deliberately *not* keyed on "two colours" alone, which would drag in
    // `rs-riso`. A riso asks for two spot inks that overlap into a third mixed
    // tone, on purpose — it is a print simulation the model attempts whole, not
    // a quantise-then-dither pipeline, and its halftone is one artefact among
    // misregistration and roller streaks rather than a kernel we owe it.
    //
    // And "purely by density" rather than a bare "density alone", which would
    // drag in the engraving pair. Those build tone from *line* density —
    // hatching the model draws, not a screen laid over the output afterwards.
    const cannotFinishInTheModel =
      /no third colour|no intermediate tones|two-entry|purely (by|through) density/i

    const owed = everyBuiltIn.filter(preset => {
      const prose = preset.variants.prose
      if (prose === null) return false
      return cannotFinishInTheModel.test(
        `${prose.transform} ${prose.negative ?? ''}`
      )
    })

    // Pinned, or the loop below passes by matching nothing at all — which is
    // how a regex-gated invariant quietly stops being an invariant.
    expect(owed).toHaveLength(4)

    for (const preset of owed) {
      expect(preset.note, preset.id).not.toBeNull()
      expect(preset.note ?? '', preset.id).toMatch(wantsPost)
    }

    // And that the note is nowhere it is not earned: a note is an unfinished
    // step, so one on a look that is finished would be permanent scaffolding.
    const noted = everyBuiltIn.filter(preset => preset.note !== null)
    expect(noted.map(preset => preset.id)).toEqual([
      'gn-duotone-landscape',
      'gn-halftone-highkey',
      'rs-duotone-dither',
      'rs-halftone-highkey',
    ])
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

  it('says the same thing in both idioms, and subtracts more in tags', () => {
    // Two variants are two phrasings of one look, not two looks — but they are
    // not word-for-word translations either (#48). Prose can be conditional
    // ("halation ONLY around light sources bright enough to exceed the film's
    // latitude"); a comma-separated list has no word for "only", so the tags
    // variant states the positive plainly and pushes the excluded readings into
    // the negative.
    //
    // That is safe because `promptStyle: 'tags'` and a non-null
    // `negativePromptParam` are the same four models — a constraint migrating
    // out of the positive lands in a field that exists on exactly the models
    // reading the variant it migrated in. Asserted for real further down, in
    // "every tags-idiom model has somewhere to put a negative".
    //
    // So the invariant is one-directional: tags subtracts everything prose
    // subtracts, and is allowed to subtract more. Equality would forbid the
    // translation this library is built on; no relation at all would let a
    // careless tags rewrite quietly drop a constraint neither variant states.
    for (const style of BUILT_IN_STYLE_PRESETS) {
      const prose = style.variants.prose
      const tags = style.variants.tags
      expect(prose?.negative, style.id).not.toBeNull()
      expect(tags?.negative, style.id).not.toBeNull()

      for (const clause of (prose?.negative ?? '').split(', ')) {
        expect(tags?.negative ?? '', `${style.id}: ${clause}`).toContain(clause)
      }

      expect(prose?.strength, style.id).toBe(tags?.strength)
      // Prose is prose: sentences, not the tag list with the commas kept.
      expect(prose?.transform, style.id).toMatch(/\.$/)
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
        const composed = composePreset(source, model, DEFAULT_PALETTE)

        if (composed === null) throw new Error(`${where} seeded nothing`)

        // Every slot resolved. `{{…}}` survives on purpose — see below — so
        // this is about the single-brace slots the loader owns.
        expect(composed.prompt.replaceAll(/\{\{|\}\}/g, ''), where).not.toMatch(
          /[{}]/
        )
        // The transform, with its holes filled — so this checks the wording
        // survived composition without asserting that a variable did not
        // resolve, which is the neighbouring test's job.
        const transform = source.variants[model.promptStyle]?.transform ?? ''
        for (const fragment of transform.split(/\{\{[a-z0-9_]+\}\}/)) {
          if (fragment.trim() === '') continue
          expect(composed.prompt, where).toContain(fragment)
        }

        // Never in the body — routed or dropped, per the registry (PRD §9).
        const negative = source.variants[model.promptStyle]?.negative ?? null
        expect(composed.negative, where).toBe(
          model.negativePromptParam === null ? null : negative
        )
      }
    }
  })

  it('resolves its colour holes against the palette, and leaves the rest', () => {
    const monolith = sourcePresetById('gn-monolith')
    if (monolith === null) throw new Error('the proving set lost a scene')

    const composed = composePreset(monolith, SOURCE_DEFAULT, DEFAULT_PALETTE)

    // A colour hole becomes a *word* — never the hex, which text encoders read
    // erratically and silently (#46).
    expect(composed?.prompt).toContain(
      colourNameOf(DEFAULT_PALETTE.roles.primary)
    )
    expect(composed?.prompt).not.toContain('{{primary}}')
    expect(composed?.prompt).not.toContain('#')

    // A free-text hole nobody has filled stays visible, because a gap would
    // read as a sentence the preset forgot to finish.
    expect(composed?.prompt).toContain('{{subject}}')
  })

  it('names every colour hole after a role this app actually has', () => {
    // A `{{brand_color}}` would compose as a literal in a paid prompt and never
    // say so — the failure is silent, so the check has to be at load.
    const holes = new Set<string>()
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      for (const carried of Object.values(source.variants)) {
        for (const match of (carried?.transform ?? '').matchAll(
          /\{\{([a-z0-9_]+)\}\}/g
        )) {
          holes.add(match[1] ?? '')
        }
      }
    }

    expect(holes.size).toBeGreaterThan(0)
    for (const hole of holes) {
      // `{{brand_color}}` is the shape this is looking for: a hole plainly
      // about colour that the palette cannot answer.
      if (!/colou?r/i.test(hole)) continue
      expect(namesPaletteSlot(hole), hole).toBe(true)
    }
  })
})

/**
 * The hero-recipes v4 material, as shipped (#48).
 *
 * Forty-four recipes went in: twenty-four `generate` as source scenes, twenty
 * `restyle` joining the eight the style library already had. What is worth
 * asserting is not that forty-four strings exist but the handful of rules that
 * are cheap to break and expensive to notice — a look that says less than it
 * meant to does not fail a test, it just comes out worse.
 */
describe('the v4 recipes', () => {
  const BOTH = [...BUILT_IN_SOURCE_PRESETS, ...BUILT_IN_STYLE_PRESETS]

  it('landed all forty-four, in the right library', () => {
    expect(BUILT_IN_SOURCE_PRESETS).toHaveLength(24)
    expect(BUILT_IN_STYLE_PRESETS).toHaveLength(28)

    // The v4 tracks map onto our stages by prefix, and nothing crossed over: a
    // `generate` recipe is a whole scene and would ask a restyle model to
    // preserve a composition nobody supplied.
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      expect(source.id, source.id).toMatch(/^gn-/)
    }
    expect(
      BUILT_IN_STYLE_PRESETS.filter(style => style.id.startsWith('rs-'))
    ).toHaveLength(20)
  })

  it('carries a negative on both variants of every one of them', () => {
    // Never `null`, whose documented meaning is "this look has nothing to
    // subtract". Dropped per-model by `composePreset` on the prose idiom, which
    // is a routing decision and not a reason to write down something untrue.
    for (const preset of BOTH) {
      for (const idiom of ['tags', 'prose'] as const) {
        expect(
          preset.variants[idiom]?.negative,
          `${preset.id}/${idiom}`
        ).not.toBeNull()
      }
    }
  })

  it('leaves no strength opinion on any of the forty-four', () => {
    // Exactly one style-stage model has a strength parameter and no source
    // model does, so an opinion here would be an opinion about one endpoint
    // dressed as a property of the look. The three that do carry one are #28's
    // proving set, which measured them.
    const opinionated = BOTH.filter(preset =>
      (['tags', 'prose'] as const).some(
        idiom => preset.variants[idiom]?.strength !== null
      )
    )

    expect(opinionated.map(preset => preset.id)).toEqual([
      'mesh-gradient',
      'topographic-contour',
      'brutalist-monochrome',
    ])
  })

  it('leaves no hole open but the palette roles and the subject', () => {
    // The one-off keys — a botanical name, a camera angle, a ranking metric —
    // are inlined with concrete values rather than left as fields. #28's reason
    // for fork-to-customize is that editing a seeded prompt is how somebody
    // learns the prompt language, and a specific value teaches where a bare
    // `{{surface}}` teaches nothing and reads as unfinished.
    const allowed = new Set(['primary', 'secondary', 'ink', 'paper', 'subject'])
    const found = new Set<string>()

    for (const preset of BOTH) {
      for (const idiom of ['tags', 'prose'] as const) {
        const carried = preset.variants[idiom]
        if (carried === null || carried === undefined) continue
        for (const key of unresolvedVariables(
          `${carried.compose} ${carried.transform} ${carried.negative ?? ''}`
        )) {
          expect(allowed.has(key), `${preset.id}/${idiom}: {{${key}}}`).toBe(
            true
          )
          found.add(key)
        }
      }
    }

    // Every allowed hole is actually used, or the list above is aspirational
    // rather than a description of the library.
    expect([...found].sort()).toEqual([...allowed].sort())
  })

  it('binds colour to a role rather than hardcoding a value', () => {
    // #46 made `ink` mandatory in every palette precisely so the reduction and
    // print families could follow the user's colours instead of near-black.
    for (const preset of BOTH) {
      for (const idiom of ['tags', 'prose'] as const) {
        const carried = preset.variants[idiom]
        expect(
          `${carried?.transform ?? ''} ${carried?.negative ?? ''}`,
          `${preset.id}/${idiom}`
        ).not.toMatch(/#[0-9a-f]{6}/i)
      }
    }

    const duotone = stylePresetById('rs-duotone-dither')
    expect(duotone?.variants.prose?.transform).toContain('{{ink}}')
    expect(duotone?.variants.prose?.transform).toContain('{{primary}}')
  })

  it('flattens the one blocks-format recipe with its labels intact', () => {
    // `gn-vintage-surreal` was authored as five labelled blocks. The labels are
    // part of the prompt text rather than scaffolding around it — they are how
    // the original steers the model through the sections — so concatenation is
    // the flattening, not stripping.
    const surreal = sourcePresetById('gn-vintage-surreal')
    const prose = surreal?.variants.prose?.transform ?? ''

    for (const label of [
      'The Key Aesthetic:',
      'The Colour Palette:',
      'The Signature Effect:',
      'The Final Layout:',
    ]) {
      expect(prose, label).toContain(label)
    }

    // One string, and the opener leads it — the labels are inside the prose,
    // not a structure something downstream would have to reassemble.
    expect(prose.startsWith('A highly detailed vintage')).toBe(true)
  })

  it('gives every built-in a blurb, and every scene a headline zone', () => {
    for (const preset of BOTH) {
      expect(preset.blurb, preset.id).not.toBeNull()
      expect(preset.family, preset.id).not.toBe('')
    }

    // Source only: where a scene leaves room for type is a fact about a
    // composition, and a restyle inherits whatever composition it was given.
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      expect(source.headlineZone, source.id).not.toBeNull()
    }
    for (const style of BUILT_IN_STYLE_PRESETS) {
      expect(style.headlineZone, style.id).toBeNull()
    }
  })

  it('groups into families a picker can be read down', () => {
    // The reason `family` stopped being decorative: 28 and 24 entries flat is a
    // list you have to read end to end.
    for (const library of [BUILT_IN_SOURCE_PRESETS, BUILT_IN_STYLE_PRESETS]) {
      const families = new Set(library.map(preset => preset.family))
      expect(families.size).toBeGreaterThan(3)
      expect(families.size).toBeLessThan(library.length)
    }
  })

  it('subtracts at least as much in tags as in prose, on the scenes too', () => {
    // The style library's version of this rule, applied to source. Same
    // argument: the tags rewrite may migrate a constraint out of the positive,
    // and must never quietly drop one.
    for (const source of BUILT_IN_SOURCE_PRESETS) {
      const prose = source.variants.prose?.negative ?? ''
      const tags = source.variants.tags?.negative ?? ''
      for (const clause of prose.split(', ')) {
        expect(tags, `${source.id}: ${clause}`).toContain(clause)
      }
    }
  })

  it('has a negative field on every model that reads the tags idiom', () => {
    // The alignment the whole two-idiom design rests on. If a tags model ever
    // ships without a `negative_prompt`, the constraints this library migrates
    // out of the positive would reach nothing at all — silently, and only on
    // the looks whose palette those constraints hold down.
    const models = [
      ...modelsForStage(MODEL_REGISTRY, 'source'),
      ...modelsForStage(MODEL_REGISTRY, 'style'),
    ]

    const tagsModels = models.filter(model => model.promptStyle === 'tags')
    expect(tagsModels.length).toBeGreaterThan(0)

    for (const model of tagsModels) {
      expect(model.negativePromptParam, model.id).not.toBeNull()
    }
  })
})

/**
 * Template variables (#46).
 *
 * The rule that matters most is the one about *what is persisted*: only the
 * expanded prose ever reaches a recipe, because a recipe that resolves against
 * a library we can still edit is not a recipe. Everything else here is the
 * order of precedence, which is what decides whether the prompt says what the
 * project's colours say or what the preset's author guessed.
 */
describe('template variables', () => {
  /** A palette with two unroled extras, for the positional cases. */
  const withExtras: Palette = readPalette({
    roles: {
      primary: { hex: '#D9662C', name: 'burnt orange' },
      secondary: { hex: '#1F4E79', name: 'deep cobalt' },
      accent: { hex: '#B5352A', name: 'scarlet' },
      ink: { hex: '#14110F' },
      paper: { hex: '#F4EFE6' },
      neutral: { hex: '#8A8079' },
    },
    extras: [{ hex: '#A3B18A', name: 'sage' }, { hex: '#12384F' }],
  })

  function holed(transform: string, defaults?: Record<string, string>): Preset {
    return tagsPreset({ transform, compose: '{transform}', ...{ defaults } })
  }

  it('resolves a role to the colour’s name', () => {
    const composed = composePreset(holed('{{primary}} walls'), QWEN, withExtras)

    expect(composed?.prompt).toBe('burnt orange walls')
  })

  it('resolves an extra by position, and never wraps back to the first', () => {
    // Wrapping would assign one colour to both sides of a distinction the look
    // is built on, which is exactly what a recipe wanting many colours wants
    // kept apart.
    const composed = composePreset(
      holed('{{extra1}} and {{extra3}}'),
      QWEN,
      withExtras
    )

    expect(composed?.prompt).toBe('sage and {{extra3}}')
  })

  it('names an unnamed colour from the curated table', () => {
    const composed = composePreset(holed('{{extra2}} sky'), QWEN, withExtras)

    expect(composed?.prompt).toBe(`${nearestColourName('#12384F')} sky`)
  })

  it('falls back to the authored default where the palette has nothing', () => {
    const composed = composePreset(
      holed('{{subject}} on a plinth', { subject: 'a ceramic vase' }),
      QWEN,
      withExtras
    )

    expect(composed?.prompt).toBe('a ceramic vase on a plinth')
  })

  it('prefers a typed value to both the palette and the default', () => {
    const composed = composePreset(
      holed('{{primary}} and {{subject}}', { subject: 'a vase' }),
      QWEN,
      withExtras,
      { primary: 'oxblood', subject: 'a kettle' }
    )

    expect(composed?.prompt).toBe('oxblood and a kettle')
  })

  it('leaves a hole nothing can fill visible, and reports it', () => {
    const composed = composePreset(
      holed('{{subject}} on a plinth'),
      QWEN,
      withExtras
    )

    expect(composed?.prompt).toBe('{{subject}} on a plinth')
    expect(composed?.variables).toEqual([
      { key: 'subject', fromPalette: false, value: '' },
    ])
    expect(unresolvedVariables(composed?.prompt ?? '')).toEqual(['subject'])
  })

  it('says a palette hole is a palette hole even when the slot is empty', () => {
    // The difference the field has to explain: `extra3` is a colour this
    // project does not have, not free text nobody has typed yet.
    const composed = composePreset(holed('{{extra3}}'), QWEN, withExtras)

    expect(composed?.variables).toEqual([
      { key: 'extra3', fromPalette: true, value: '' },
    ])
  })

  it('lists each hole once, in the order it first appears', () => {
    const composed = composePreset(
      holed('{{subject}} in {{primary}}, {{subject}} again'),
      QWEN,
      withExtras
    )

    expect(composed?.variables.map(variable => variable.key)).toEqual([
      'subject',
      'primary',
    ])
  })

  it('counts a preset that is seeded with its holes filled as seeded', () => {
    // Otherwise every variable-carrying preset would report as hand-edited the
    // moment it was picked, and offer a re-seed that changes nothing.
    const preset = holed('{{subject}} on a plinth')
    const values = { subject: 'a kettle' }
    const composed = composePreset(preset, QWEN, withExtras, values)

    expect(
      presetSeedState(composed?.prompt ?? '', preset, QWEN, withExtras, values)
    ).toEqual({ state: 'seeded' })
  })

  it('expands the negative from the same values, and offers it a field', () => {
    // A negative goes on the wire exactly as a prompt does, so a hole in one is
    // a hole in something a model is paid to read.
    const preset = tagsPreset({
      transform: 'a plinth',
      compose: '{transform}',
      negative: 'no {{secondary}} anywhere',
    })
    const composed = composePreset(preset, QWEN, withExtras)

    expect(composed?.negative).toBe('no deep cobalt anywhere')
    expect(composed?.variables.map(variable => variable.key)).toContain(
      'secondary'
    )
  })

  it('treats a field the user emptied as an answer, not as untouched', () => {
    // Otherwise clearing a palette-backed field would refill it from the
    // palette, and the field and the prompt box would say different things.
    const preset = holed('{{primary}} walls')

    expect(
      composePreset(preset, QWEN, withExtras, { primary: '' })?.prompt
    ).toBe('{{primary}} walls')
  })

  it('refuses a default for a hole the template does not have', () => {
    // A silent typo otherwise: the value never appears anywhere, and the recipe
    // reads as if the author simply forgot to write it.
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({
              variants: {
                tags: variant({
                  transform: '{{subject}} on a plinth',
                  compose: '{transform}',
                  defaults: { subjekt: 'a vase' },
                } as Partial<PresetVariant>),
                prose: null,
              },
            }),
          ],
        })
      )
    ).toThrow(/subjekt/)
  })

  it('refuses an empty default', () => {
    expect(() =>
      readPresetLibrary(
        document({
          presets: [
            preset({
              variants: {
                tags: variant({
                  transform: '{{subject}}',
                  compose: '{transform}',
                  defaults: { subject: '  ' },
                } as Partial<PresetVariant>),
                prose: null,
              },
            }),
          ],
        })
      )
    ).toThrow(/subject/)
  })

  it('reads a variant with no defaults block at all', () => {
    // Unlike `negative` and `strength`, absent is allowed: the absent-versus-
    // null rule is about an idiom being unanswered, and a variant with no
    // defaults has answered fully.
    const only = tagsPreset({ transform: '{{subject}}' })

    expect(only.variants.tags?.defaults).toEqual({})
  })

  it('keeps no defaults on a fork, because the capture is already expanded', () => {
    const fork = userPresetFrom({
      id: 'mine',
      name: 'Mine',
      promptStyle: 'tags',
      prompt: 'a kettle, {{subject}} left open on purpose',
      negative: null,
      strength: null,
      aspect: null,
      headlineZone: null,
      note: null,
    })

    expect(fork.variants.tags?.defaults).toEqual({})
    // And it still loads: a `{{` somebody left in an editable box is legal
    // prose, not a malformed file.
    expect(() => readUserPreset(writeUserPreset(fork))).not.toThrow()
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

    expect(composePreset(only, QWEN, DEFAULT_PALETTE)?.prompt).toBe(
      `${strict} a look`
    )
    // And the library's standard block is nowhere in it.
    expect(composePreset(only, QWEN, DEFAULT_PALETTE)?.prompt).not.toContain(
      'same composition'
    )
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

  it('refuses a headline zone the layout has no word for', () => {
    // Same argument as the aspect hint: this is displayed next to a layout
    // decision, and a zone nobody has a word for names a region of the frame
    // the reader cannot go and find.
    expect(() =>
      readPresetLibrary(
        document({ presets: [preset({ headlineZone: 'middle-ish' })] })
      )
    ).toThrow(/headline zone/i)
  })

  it('refuses a blurb or a note that is there but empty', () => {
    // Absent means nobody wrote one, which is a fork's normal state. The empty
    // string is a field somebody started and left, and it renders as a blank
    // line where a sentence should be — which reads as a bug, not as silence.
    for (const field of ['blurb', 'note'] as const) {
      expect(
        () =>
          readPresetLibrary(document({ presets: [preset({ [field]: '  ' })] })),
        field
      ).toThrow(new RegExp(field, 'i'))
    }
  })

  it('takes a missing blurb, note or zone as nothing to say', () => {
    const only = readPresetLibrary(document()).presets[0]

    expect(only?.blurb).toBeNull()
    expect(only?.note).toBeNull()
    expect(only?.headlineZone).toBeNull()
  })

  it('round-trips the display-only fields through a saved fork', () => {
    // They are on `writeUserPreset` because a fork of a scene that has to be
    // dithered is still a scene that has to be dithered. The blurb is not: it
    // is a line about one of ours.
    const forked = userPresetFrom({
      id: 'mine',
      name: 'Mine',
      promptStyle: 'tags',
      prompt: 'a keyword list',
      negative: null,
      strength: null,
      aspect: '16:9',
      headlineZone: 'leftThird',
      note: 'Dither this afterwards.',
    })

    expect(forked.blurb).toBeNull()
    expect(readUserPreset(writeUserPreset(forked))).toEqual(forked)
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
    const composed = composePreset(tagsPreset(), QWEN, DEFAULT_PALETTE)

    expect(composed?.prompt).toBe('same composition, a look')
  })

  it('follows the preset’s own template rather than a rule in code', () => {
    // PRD §6.1 — assembly order is preset data, so a look that has to dominate
    // can lead with the style.
    const composed = composePreset(
      tagsPreset({ compose: '{transform}. {preserve}' }),
      QWEN,
      DEFAULT_PALETTE
    )

    expect(composed?.prompt).toBe('a look. same composition')
  })

  it('returns nothing for a model whose idiom the preset does not support', () => {
    // Not an error and not a fallback: an explicit null means the preset has
    // nothing to say to a prose model, and the caller offers a re-seed instead
    // of composing something in the wrong idiom.
    expect(composePreset(tagsPreset(), FLUX_I2I, DEFAULT_PALETTE)).toBeNull()
  })

  it('never folds the negative into the prompt', () => {
    // Settled 2026-08-09 (PRD §9): "no gradients" concatenated into a positive
    // prompt is a request for gradients.
    const composed = composePreset(
      tagsPreset({ negative: 'flat colour' }),
      QWEN,
      DEFAULT_PALETTE
    )

    expect(composed?.negative).toBe('flat colour')
    expect(composed?.prompt).not.toContain('flat colour')
  })

  it('drops the negative on a model with no field to put it in', () => {
    const model = tagsModelWithStrength({ negativePromptParam: null })
    const composed = composePreset(
      tagsPreset({ negative: 'flat colour' }),
      model,
      DEFAULT_PALETTE
    )

    expect(composed?.negative).toBeNull()
    expect(composed?.prompt).not.toContain('flat colour')
  })

  it('takes the strength the registry defaults to when the preset has none', () => {
    // PRD §6.3 — 0.7, never fal's 0.95.
    const composed = composePreset(
      tagsPreset(),
      tagsModelWithStrength(),
      DEFAULT_PALETTE
    )

    expect(composed?.strength).toBe(0.7)
  })

  it('has no strength at all on a model with no strength field', () => {
    // Only one endpoint of 33 has one, so null is the normal answer.
    expect(
      composePreset(tagsPreset({ strength: 0.7 }), QWEN, DEFAULT_PALETTE)
        ?.strength
    ).toBe(null)
  })

  it('clamps a preset’s override to the verified window', () => {
    // Below 0.65 nothing happens; above 0.8 the composition drifts and at 0.95
    // the input is discarded (PRD §6.3). A preset may not ask for either.
    const model = tagsModelWithStrength()

    expect(
      composePreset(tagsPreset({ strength: 0.95 }), model, DEFAULT_PALETTE)
        ?.strength
    ).toBe(PRESET_STRENGTH_WINDOW.max)
    expect(
      composePreset(tagsPreset({ strength: 0.2 }), model, DEFAULT_PALETTE)
        ?.strength
    ).toBe(PRESET_STRENGTH_WINDOW.min)
    expect(
      composePreset(tagsPreset({ strength: 0.75 }), model, DEFAULT_PALETTE)
        ?.strength
    ).toBe(0.75)
  })

  /**
   * #28's acceptance criterion: the same preset produces a styled result on
   * every style-stage model, via its own compose templates. Both halves of the
   * stage are exercised here — all twenty-eight presets against every row the
   * registry lists, whichever idiom that row reads.
   */
  it('seeds every built-in on every style model the registry lists', () => {
    const models = modelsForStage(MODEL_REGISTRY, 'style')
    expect(models.length).toBeGreaterThanOrEqual(8)

    for (const model of models) {
      for (const style of BUILT_IN_STYLE_PRESETS) {
        const where = `${style.id} on ${model.id}`
        const composed = composePreset(style, model, DEFAULT_PALETTE)

        if (composed === null) throw new Error(`${where} seeded nothing`)

        // A prompt with the look in it, led by the clause that keeps the
        // composition — the one thing separating a restyle from a reroll.
        expect(composed.prompt.length, where).toBeGreaterThan(60)
        expect(composed.prompt, where).not.toContain('{')

        const preserve =
          STYLE_PRESET_LIBRARY.preserve?.[model.promptStyle] ?? ''
        expect(composed.prompt.startsWith(preserve), where).toBe(true)

        // Every literal run of the transform, rather than the transform whole:
        // the composed prompt has its `{{…}}` filled in by now, so the raw
        // template is not a substring of it once a look references the palette.
        // Checking the pieces either side of each hole says the same thing
        // without re-implementing the substitution the assertion is testing.
        const transform = style.variants[model.promptStyle]?.transform ?? ''
        for (const literal of transform.split(/\{\{[A-Za-z0-9_]+\}\}/)) {
          if (literal === '') continue
          expect(composed.prompt, `${where}: ${literal}`).toContain(literal)
        }

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

    const composed = composePreset(glass, QWEN, DEFAULT_PALETTE)

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
    const composed = composePreset(tagsPreset(), QWEN, DEFAULT_PALETTE)

    expect(
      presetSeedState(
        composed?.prompt ?? '',
        tagsPreset(),
        QWEN,
        DEFAULT_PALETTE
      )
    ).toEqual({
      state: 'seeded',
    })
  })

  it('has nothing to say when no preset is selected', () => {
    expect(presetSeedState('anything', null, QWEN, DEFAULT_PALETTE)).toEqual({
      state: 'none',
    })
  })

  it('reports the model’s idiom as unsupported rather than offering a re-seed', () => {
    // Cross-sending is what the null variant exists to prevent, so there is no
    // re-seed to offer here — the picker disables the preset and says why.
    expect(
      presetSeedState('anything', tagsPreset(), FLUX_I2I, DEFAULT_PALETTE).state
    ).toBe('unsupported')
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
    const stranded = presetSeedState(
      'a look',
      bothIdioms,
      FLUX_I2I,
      DEFAULT_PALETTE
    )
    expect(stranded).toEqual({
      state: 'stale',
      reasonKey: 'editor.preset.staleIdiom',
    })

    expect(
      presetSeedState('my own words', bothIdioms, FLUX_I2I, DEFAULT_PALETTE)
    ).toEqual({
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
    headlineZone: null,
    note: null,
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
    expect(composePreset(fork, QWEN, DEFAULT_PALETTE)?.prompt).toBe(
      capture.prompt
    )
  })

  it('carries the seeded fields the model had a place for', () => {
    const fork = userPresetFrom(capture)

    expect(composePreset(fork, QWEN, DEFAULT_PALETTE)?.negative).toBe(
      'cold light'
    )
    // Qwen has no strength field, so the saved opinion is simply not routed.
    expect(composePreset(fork, QWEN, DEFAULT_PALETTE)?.strength).toBeNull()
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
          defaults: {},
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
      expect(composePreset(taught, prose, DEFAULT_PALETTE)?.prompt).toBe(
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
