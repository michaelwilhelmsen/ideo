/**
 * The palette: what it refuses, and what it calls a colour.
 *
 * Two things are worth testing and they are the two ways a palette fails
 * silently. A palette whose entries sit at the same lightness turns every
 * recipe that reduces to two inks to mud, with nothing on screen to explain
 * it — so the invariant is checked wherever a palette enters the app. And a hex
 * in a prompt fails erratically rather than loudly, so every path out of here
 * has to end in a *word*.
 */

import { describe, expect, it } from 'vitest'
import {
  COLOUR_NAMES,
  colourNameOf,
  copyPalette,
  DEFAULT_PALETTE,
  isHex,
  lightnessOf,
  MIN_ROLE_LIGHTNESS_GAP,
  nearestColourName,
  PALETTE_ROLES,
  paletteEntryFor,
  paletteProblem,
  readPalette,
  type Palette,
} from './palette'

/** A well-formed document, so each test states only what it is about. */
function document(roles: Record<string, unknown> = {}, extras?: unknown) {
  return {
    roles: {
      primary: { hex: '#D9662C' },
      secondary: { hex: '#1F4E79' },
      accent: { hex: '#B5352A' },
      ink: { hex: '#14110F' },
      paper: { hex: '#F4EFE6' },
      neutral: { hex: '#8A8079' },
      ...roles,
    },
    extras: extras ?? [],
  }
}

describe('the default palette', () => {
  it('validates at import, or the module would not have loaded', () => {
    expect(paletteProblem(DEFAULT_PALETTE)).toBeNull()
    expect(Object.keys(DEFAULT_PALETTE.roles).sort()).toEqual(
      [...PALETTE_ROLES].sort()
    )
  })

  it('takes every name from the curated table, so nothing reads odd', () => {
    // Named by derivation rather than by an authored copy, which is what keeps
    // a built-in palette and a colour the user types sounding alike.
    for (const role of PALETTE_ROLES) {
      const entry = DEFAULT_PALETTE.roles[role]
      expect(entry.name, role).toBeNull()
      expect(
        COLOUR_NAMES.some(colour => colour.name === colourNameOf(entry)),
        role
      ).toBe(true)
    }
  })

  it('reads as the editorial triple it was chosen as', () => {
    // Pinned because the words are what a model is paid to read. A table edit
    // that moves one of these is a change to every prompt the app will seed.
    expect(colourNameOf(DEFAULT_PALETTE.roles.primary)).toBe('burnt orange')
    expect(colourNameOf(DEFAULT_PALETTE.roles.secondary)).toBe('deep cobalt')
    expect(colourNameOf(DEFAULT_PALETTE.roles.accent)).toBe('scarlet')
  })

  it('is copied rather than shared, so editing one project leaves others', () => {
    const copy = copyPalette(DEFAULT_PALETTE)

    expect(copy).toEqual(DEFAULT_PALETTE)
    expect(copy.roles.primary).not.toBe(DEFAULT_PALETTE.roles.primary)
    expect(copy.extras).not.toBe(DEFAULT_PALETTE.extras)
  })
})

describe('the lightness invariant', () => {
  it('accepts the well-formed one, or the rest of these prove nothing', () => {
    expect(paletteProblem(readPalette(document()))).toBeNull()
  })

  it('refuses a palette where something is darker than ink', () => {
    // The reduction and print families key on ink being the darkest thing
    // there is; without that they have nothing to reduce towards.
    const problem = paletteProblem(
      readPaletteUnchecked(document({ secondary: { hex: '#000000' } }))
    )

    expect(problem).toEqual({ kind: 'inkNotDarkest', slot: 'secondary' })
  })

  it('refuses a palette where something is lighter than paper', () => {
    const problem = paletteProblem(
      readPaletteUnchecked(document({ neutral: { hex: '#FFFFFF' } }))
    )

    expect(problem).toEqual({ kind: 'paperNotLightest', slot: 'neutral' })
  })

  it('looks at the extras too, not only the six roles', () => {
    const problem = paletteProblem(
      readPaletteUnchecked(document({}, [{ hex: '#000000' }]))
    )

    expect(problem).toEqual({ kind: 'inkNotDarkest', slot: 'extra1' })
  })

  it('refuses two mid roles that would collapse into one ink', () => {
    // Roughly ten recipes in the incoming library reduce to two inks. A flat
    // palette turns all of them to mud with no visible explanation, which is
    // exactly why this is a refusal rather than a hint.
    const flat = readPaletteUnchecked(document({ accent: { hex: '#D9662C' } }))
    const problem = paletteProblem(flat)

    expect(problem?.kind).toBe('rolesTooClose')
    expect(problem).toMatchObject({ slot: 'primary', other: 'accent' })
  })

  it('names the offending entries, because "invalid" is not actionable', () => {
    expect(() =>
      readPalette(document({ secondary: { hex: '#000000' } }))
    ).toThrow(/ink.*secondary|secondary.*ink/i)
  })

  it('clears the shipped default by a real margin, not by a hair', () => {
    // The constant is a floor rather than a number reverse-engineered from the
    // default. If the two ever meet, one of them was chosen wrong.
    const gaps = [
      Math.abs(
        lightnessOf(DEFAULT_PALETTE.roles.primary.hex) -
          lightnessOf(DEFAULT_PALETTE.roles.accent.hex)
      ),
      Math.abs(
        lightnessOf(DEFAULT_PALETTE.roles.secondary.hex) -
          lightnessOf(DEFAULT_PALETTE.roles.accent.hex)
      ),
    ]

    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(MIN_ROLE_LIGHTNESS_GAP)
    }
  })
})

describe('a palette document that is not what we expect', () => {
  it('refuses a document that is not a document', () => {
    expect(() => readPalette(null)).toThrow()
    expect(() => readPalette([])).toThrow()
    expect(() => readPalette({ roles: [] })).toThrow()
  })

  it('refuses a missing role rather than filling it in', () => {
    // No tolerant fallback: substituting ours would turn an unopenable project
    // into one that opens and quietly says something different.
    const { roles, ...rest } = document()
    const { accent: _dropped, ...without } = roles

    expect(() => readPalette({ ...rest, roles: without })).toThrow(/accent/)
  })

  it('refuses anything that is not a #RRGGBB hex', () => {
    expect(() => readPalette(document({ ink: { hex: 'black' } }))).toThrow(
      /ink/
    )
    expect(() => readPalette(document({ ink: { hex: '#000' } }))).toThrow(/ink/)
    expect(isHex('#1F4E79')).toBe(true)
    expect(isHex('1F4E79')).toBe(false)
  })

  it('normalises the case, so two spellings of one colour are one colour', () => {
    const palette = readPalette(document({ primary: { hex: '#d9662c' } }))

    expect(palette.roles.primary.hex).toBe('#D9662C')
  })

  it('reads an unnamed colour as unnamed rather than as empty', () => {
    const palette = readPalette(
      document({ primary: { hex: '#D9662C', name: '  ' } })
    )

    expect(palette.roles.primary.name).toBeNull()
  })

  it('keeps an authored name exactly as it was written', () => {
    // A name is the user's word for their own colour (PRD §6) — no `t()`, and
    // no second-guessing it against the table.
    const palette = readPalette(
      document({ primary: { hex: '#D9662C', name: 'House orange' } })
    )

    expect(colourNameOf(palette.roles.primary)).toBe('House orange')
  })
})

describe('addressing an entry', () => {
  const palette = readPalette(
    document({}, [{ hex: '#A3B18A', name: 'sage' }, { hex: '#12384F' }])
  )

  it('finds a role by its name', () => {
    expect(paletteEntryFor(palette, 'ink')?.hex).toBe('#14110F')
  })

  it('finds an extra by its position', () => {
    expect(paletteEntryFor(palette, 'extra1')?.name).toBe('sage')
    expect(paletteEntryFor(palette, 'extra2')?.hex).toBe('#12384F')
  })

  it('runs out rather than wrapping back to the first entry', () => {
    // A recipe wanting many colours wants them *contrasting*, so wrapping would
    // assign one hex to both sides of a distinction the look is built on.
    expect(paletteEntryFor(palette, 'extra3')).toBeNull()
  })

  it('knows free text from a slot', () => {
    expect(paletteEntryFor(palette, 'subject')).toBeNull()
    expect(paletteEntryFor(palette, 'extra0')).toBeNull()
  })
})

describe('naming a colour', () => {
  it('answers with a curated term for anything at all', () => {
    for (const hex of ['#000000', '#FFFFFF', '#7F7F7F', '#00FF00', '#123456']) {
      expect(
        COLOUR_NAMES.some(colour => colour.name === nearestColourName(hex)),
        hex
      ).toBe(true)
    }
  })

  it('carries roughly the vocabulary a prompt needs, and no CSS keywords', () => {
    expect(COLOUR_NAMES.length).toBeGreaterThanOrEqual(100)
    for (const colour of COLOUR_NAMES) {
      // "darkslategray" is not something worth paying a model to read.
      expect(colour.name, colour.name).not.toMatch(/^[a-z]{12,}$/)
      expect(isHex(colour.hex), colour.name).toBe(true)
    }
  })

  it('ignores a hex typed into the name field', () => {
    // The invariant is "no hex ever reaches a prompt", and it is only a
    // guarantee if it survives a hand-edited manifest.
    const palette = readPalette(
      document({ primary: { hex: '#D9662C', name: '#D9662C' } })
    )

    expect(colourNameOf(palette.roles.primary)).toBe('burnt orange')
  })

  it('never lets a hex out in place of a name', () => {
    const palette: Palette = readPalette(document())
    for (const role of PALETTE_ROLES) {
      expect(colourNameOf(palette.roles[role])).not.toMatch(/#/)
    }
  })
})

/**
 * A palette that has been *read* but not held to the invariant.
 *
 * `readPalette` refuses both at once, which is right for a file — but a test
 * about the invariant needs a palette that got past the structural checks, and
 * so does the editor, where the value is being typed rather than read back.
 */
function readPaletteUnchecked(document: {
  roles: Record<string, unknown>
  extras: unknown
}): Palette {
  const entry = (value: unknown) => {
    const record = value as { hex: string; name?: string }
    return { hex: record.hex.toUpperCase(), name: record.name ?? null }
  }

  return {
    roles: Object.fromEntries(
      PALETTE_ROLES.map(role => [role, entry(document.roles[role])])
    ) as Palette['roles'],
    extras: (document.extras as unknown[]).map(entry),
  }
}
