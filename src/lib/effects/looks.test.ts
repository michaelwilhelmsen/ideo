/**
 * The effects library loader, and the rules its material has to keep.
 *
 * Two kinds of test, pulling the same way `presets.test.ts` does. The loader is
 * about **refusing** data: the built-ins are committed JSON, so a typo in them
 * should be a startup crash rather than a control with no range on it, and a
 * hand-edited fork should cost that one file rather than the library. The
 * library tests are about **our own material** — that the six looks are the six
 * looks, that every knob a shader reads is declared, and that a hand-edited
 * value is held to the declaration that drew the control.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE } from '@/lib/recipe/palettes'
import {
  BUILT_IN_LOOKS,
  coerceKnobValue,
  defaultKnobValues,
  EFFECT_KERNELS,
  EFFECT_SHADERS,
  EFFECTS_LIBRARY,
  isBuiltInLookId,
  isDiffusionKernel,
  lookById,
  lookFrom,
  readEffectsLibrary,
  readUserLook,
  SHADER_KNOBS,
  USER_LOOK_VERSION,
  wrapAngle,
  writeUserLook,
  type EffectsLook,
  type KnobDescriptor,
} from './looks'

/**
 * A well-formed document, so each test states only what it is about.
 *
 * An override of `undefined` removes the key rather than setting it, the way
 * `JSON.stringify` would — these stand in for files on disk, and a file cannot
 * hold `undefined`.
 */
function document(overrides: Record<string, unknown> = {}): unknown {
  return prune({ version: 1, looks: [look()], ...overrides })
}

function look(overrides: Record<string, unknown> = {}): unknown {
  return prune({
    id: 'my-posterise',
    name: 'My posterise',
    shader: 'posterised',
    blurb: null,
    knobs: [
      { key: 'levels', kind: 'slider', min: 2, max: 12, step: 1, value: 5 },
    ],
    ...overrides,
  })
}

function prune(value: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  )
}

describe('the committed library', () => {
  it('loads, and is #36’s six reductive looks plus the three gradients', () => {
    expect(BUILT_IN_LOOKS).toHaveLength(9)
    expect(EFFECTS_LIBRARY.version).toBe(1)
  })

  it('has one look per shader, so every shader is reachable', () => {
    // Two looks may share a shader — that is the growth path — but a shader
    // nothing names is a program the user cannot get to.
    const named = new Set(BUILT_IN_LOOKS.map(entry => entry.shader))
    expect([...named].sort()).toEqual([...EFFECT_SHADERS].sort())
  })

  it('gives every look a blurb, because six looks need telling apart', () => {
    for (const entry of BUILT_IN_LOOKS) {
      expect(entry.blurb, entry.id).not.toBeNull()
    }
  })

  it('draws every knob its shader reads, in the shader’s order', () => {
    for (const entry of BUILT_IN_LOOKS) {
      expect(
        entry.knobs.map(knob => knob.key),
        entry.id
      ).toEqual(SHADER_KNOBS[entry.shader])
    }
  })

  it('offers every kernel somewhere, so none is a value nothing can spell', () => {
    const offered = new Set(
      BUILT_IN_LOOKS.flatMap(entry =>
        entry.knobs.flatMap(knob =>
          knob.kind === 'choice' && knob.key === 'kernel' ? knob.options : []
        )
      )
    )
    expect([...offered].sort()).toEqual([...EFFECT_KERNELS].sort())
  })

  it('takes its inks from the project rather than from us', () => {
    // A duotone whose inks arrive as our hex would open wearing somebody else's
    // brand — #46 exists so the project's own six are what a look reaches for.
    const duotone = lookById('fx-duotone-dither')
    expect(duotone).not.toBeNull()
    const inks = duotone?.knobs.filter(knob => knob.kind === 'colour') ?? []
    expect(inks.map(knob => knob.value)).toEqual(['ink', 'paper'])

    const values = defaultKnobValues(duotone as EffectsLook, DEFAULT_PALETTE)
    expect(values.inkDark).toBe(DEFAULT_PALETTE.roles.ink.hex)
    expect(values.inkLight).toBe(DEFAULT_PALETTE.roles.paper.hex)
  })

  it('tells the diffusion kernels from the ordered ones by what they are', () => {
    // The partition is a property of the kernels (#53), so nothing restates it
    // per look — and it is the one property that decides where a look renders.
    expect(EFFECT_KERNELS.filter(isDiffusionKernel)).toEqual([
      'floydSteinberg',
      'atkinson',
    ])
  })
})

describe('what the loader refuses', () => {
  it('refuses a library from another version', () => {
    expect(() => readEffectsLibrary(document({ version: 2 }))).toThrow(
      /version/
    )
  })

  it('refuses a library with no looks in it', () => {
    expect(() => readEffectsLibrary(document({ looks: [] }))).toThrow(
      /no looks/
    )
  })

  it('refuses a document that is an array rather than a library', () => {
    expect(() => readEffectsLibrary([])).toThrow(/Malformed/)
  })

  it('refuses two looks with one id', () => {
    expect(() =>
      readEffectsLibrary(document({ looks: [look(), look()] }))
    ).toThrow(/declared twice/)
  })

  it('refuses an id no file could be named', () => {
    expect(() =>
      readEffectsLibrary(document({ looks: [look({ id: '../escape' })] }))
    ).toThrow(/a file can be named/)
  })

  it('refuses a shader nobody wrote', () => {
    // The failure this prevents is a look with a name, a blurb and a set of
    // controls that renders a black rectangle.
    expect(() =>
      readEffectsLibrary(
        document({ looks: [look({ shader: 'kaleidoscope' })] })
      )
    ).toThrow(/shader nobody wrote/)
  })

  it('refuses a knob the shader does not read', () => {
    expect(() =>
      readEffectsLibrary(
        document({
          looks: [
            look({
              knobs: [
                {
                  key: 'levels',
                  kind: 'slider',
                  min: 2,
                  max: 12,
                  step: 1,
                  value: 5,
                },
                { key: 'angle', kind: 'angle', value: 45 },
              ],
            }),
          ],
        })
      )
    ).toThrow(/posterised shader reads/)
  })

  it('refuses a shader’s knob left undeclared', () => {
    expect(() =>
      readEffectsLibrary(document({ looks: [look({ knobs: [] })] }))
    ).toThrow(/posterised shader reads/)
  })

  it('refuses a kind it cannot draw', () => {
    expect(() =>
      readEffectsLibrary(
        document({
          looks: [
            look({ knobs: [{ key: 'levels', kind: 'curve', value: 1 }] }),
          ],
        })
      )
    ).toThrow(/kind we cannot draw/)
  })

  it('refuses a slider whose default is outside its own range', () => {
    // The one that would render as a control already showing a value it will
    // never return to.
    expect(() =>
      readEffectsLibrary(
        document({
          looks: [
            look({
              knobs: [
                {
                  key: 'levels',
                  kind: 'slider',
                  min: 2,
                  max: 12,
                  step: 1,
                  value: 40,
                },
              ],
            }),
          ],
        })
      )
    ).toThrow(/outside 2–12/)
  })

  it('refuses a range that is not one, and a step that goes nowhere', () => {
    const slider = (extra: Record<string, unknown>): unknown =>
      document({
        looks: [
          look({
            knobs: [
              {
                key: 'levels',
                kind: 'slider',
                min: 2,
                max: 12,
                step: 1,
                value: 5,
                ...extra,
              },
            ],
          }),
        ],
      })

    expect(() => readEffectsLibrary(slider({ max: 2 }))).toThrow(/not one/)
    expect(() => readEffectsLibrary(slider({ step: 0 }))).toThrow(/step of 0/)
  })

  it('refuses a choice that defaults to something it does not offer', () => {
    expect(() =>
      readEffectsLibrary(
        document({
          looks: [
            look({
              shader: 'pixelated',
              knobs: [
                {
                  key: 'cell',
                  kind: 'choice',
                  options: ['a', 'b'],
                  value: 'c',
                },
              ],
            }),
          ],
        })
      )
    ).toThrow(/does not offer/)
  })

  it('refuses a colour that is neither a colour nor a palette role', () => {
    const colour = (value: unknown): unknown =>
      document({
        looks: [
          look({
            shader: 'pixelated',
            knobs: [{ key: 'cell', kind: 'colour', value }],
          }),
        ],
      })

    expect(() => readEffectsLibrary(colour('cerulean'))).toThrow(
      /neither a colour nor a palette role/
    )
    // A role name is as legitimate a default as a hex, and is the usual case.
    expect(() => readEffectsLibrary(colour('ink'))).not.toThrow()
    expect(() => readEffectsLibrary(colour('#D9662C'))).not.toThrow()
  })

  it('refuses an empty blurb, and takes absent as none', () => {
    expect(() =>
      readEffectsLibrary(document({ looks: [look({ blurb: '  ' })] }))
    ).toThrow(/empty blurb/)
    const library = readEffectsLibrary(
      document({ looks: [look({ blurb: undefined })] })
    )
    expect(library.looks[0]?.blurb).toBeNull()
  })
})

describe('holding a value to the knob that drew it', () => {
  const slider: KnobDescriptor = {
    kind: 'slider',
    key: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: 5,
  }

  it('clamps a slider rather than refusing it', () => {
    // Same trade `readBatchSizes` makes: 40 plainly means "as far as it goes",
    // and there is a right answer, so refusing the whole treatment over it
    // would cost more than it saves.
    expect(coerceKnobValue(slider, 40)).toBe(12)
    expect(coerceKnobValue(slider, -1)).toBe(2)
    expect(coerceKnobValue(slider, 7)).toBe(7)
  })

  it('refuses a slider value that is not a number at all', () => {
    expect(coerceKnobValue(slider, 'lots')).toBeNull()
    expect(coerceKnobValue(slider, Number.NaN)).toBeNull()
  })

  it('wraps an angle instead of clamping it', () => {
    // A screen angle wraps: 375° and 15° are the same screen, and a control
    // that stopped at 360 would make the one rotating knob feel like a wall.
    const angle: KnobDescriptor = { kind: 'angle', key: 'angle', value: 45 }
    expect(coerceKnobValue(angle, 375)).toBe(15)
    expect(coerceKnobValue(angle, -15)).toBe(345)
    expect(wrapAngle(360)).toBe(0)
  })

  it('refuses a choice, a colour and a toggle rather than guessing', () => {
    // Unlike a number, none of these has a nearest legal value: a colour that
    // is not a colour has no "as far as it goes".
    const choice: KnobDescriptor = {
      kind: 'choice',
      key: 'shape',
      options: ['round', 'square'],
      value: 'round',
    }
    expect(coerceKnobValue(choice, 'hexagon')).toBeNull()
    expect(coerceKnobValue(choice, 'square')).toBe('square')

    const colour: KnobDescriptor = {
      kind: 'colour',
      key: 'inkDark',
      value: '#000000',
    }
    // A role name is a legitimate *default*; it is not a legitimate value —
    // a treatment stores what a role resolved to, never the role.
    expect(coerceKnobValue(colour, 'ink')).toBeNull()
    expect(coerceKnobValue(colour, '#D9662C')).toBe('#D9662C')

    const toggle: KnobDescriptor = {
      kind: 'toggle',
      key: 'monochrome',
      value: true,
    }
    expect(coerceKnobValue(toggle, 'yes')).toBeNull()
    expect(coerceKnobValue(toggle, false)).toBe(false)
  })
})

describe('the user’s own looks', () => {
  it('round-trips a fork through the file it is written to', () => {
    const original = lookById('fx-halftone') as EffectsLook
    const fork = lookFrom(original, 'my-halftone', '  Newsprint  ', {
      cell: 12,
      angle: 15,
      shape: 'line',
      inkDark: '#101010',
      inkLight: '#F0EFEA',
    })

    expect(fork.name).toBe('Newsprint')
    const reloaded = readUserLook(writeUserLook(fork))
    expect(reloaded).toEqual(fork)
    expect(reloaded.knobs.find(knob => knob.key === 'shape')?.value).toBe(
      'line'
    )
  })

  it('drops a value the fork could not hold rather than saving it', () => {
    // A fork must always be a look that loads — the loader is what refuses a
    // bad declaration, and saving one would mean writing a file the user then
    // has to find and delete by hand.
    const original = lookById('fx-posterised') as EffectsLook
    const fork = lookFrom(original, 'mine', 'Mine', { levels: 'lots' })

    expect(fork.knobs[0]?.value).toBe(5)
    expect(() => readUserLook(writeUserLook(fork))).not.toThrow()
  })

  it('refuses a fork written by another version', () => {
    expect(() =>
      readUserLook({ ...(look() as object), version: USER_LOOK_VERSION + 1 })
    ).toThrow(/version/)
  })

  it('knows which ids are ours', () => {
    expect(isBuiltInLookId('fx-halftone')).toBe(true)
    expect(isBuiltInLookId('my-halftone')).toBe(false)
    expect(lookById(null)).toBeNull()
  })
})
