/**
 * The palette library.
 *
 * Two claims are worth the tests. The first is the one the committed file makes
 * about itself: every built-in satisfies the lightness invariant, and a
 * violation is a crash rather than a palette that turns a two-ink recipe to mud.
 * The second is the one the picker rests on — nothing records where a project's
 * palette came from, so `samePalette` is the only thing standing between a
 * correct label and a confidently wrong one.
 */

import { describe, expect, it } from 'vitest'
import {
  colourNameOf,
  MIN_ROLE_LIGHTNESS_GAP,
  PALETTE_ROLES,
  lightnessOf,
  paletteProblem,
  type Palette,
} from './palette'
import {
  BUILT_IN_PALETTES,
  DEFAULT_PALETTE,
  namedPaletteFor,
  paletteIdFrom,
  PALETTE_LIBRARY_VERSION,
  readPaletteLibrary,
  readUserPalette,
  samePalette,
  USER_PALETTE_VERSION,
  writeUserPalette,
} from './palettes'

/** A palette that passes, so each test states only what it is about. */
function roles(overrides: Record<string, unknown> = {}) {
  return {
    primary: { hex: '#D9662C' },
    secondary: { hex: '#1F4E79' },
    accent: { hex: '#B5352A' },
    ink: { hex: '#14110F' },
    paper: { hex: '#F4EFE6' },
    neutral: { hex: '#8A8079' },
    ...overrides,
  }
}

function document(palettes: unknown[]) {
  return { version: PALETTE_LIBRARY_VERSION, palettes }
}

function entry(overrides: Record<string, unknown> = {}) {
  return { id: 'mine', name: 'Mine', roles: roles(), extras: [], ...overrides }
}

describe('the committed library', () => {
  it('ships palettes that every recipe can use', () => {
    expect(BUILT_IN_PALETTES.length).toBeGreaterThanOrEqual(5)

    for (const named of BUILT_IN_PALETTES) {
      expect(paletteProblem(named.palette), named.id).toBeNull()
    }
  })

  it('leaves every colour to be named by the curated table', () => {
    // An authored name would be a second copy of `colour-names.json` that
    // nothing keeps honest. A built-in whose derived name reads badly is a gap
    // in the vocabulary, and the fix is a term there.
    for (const named of BUILT_IN_PALETTES) {
      for (const role of PALETTE_ROLES) {
        expect(named.palette.roles[role].name, named.id).toBeNull()
      }
      for (const extra of named.palette.extras) {
        expect(extra.name, named.id).toBeNull()
      }
    }
  })

  it('names every built-in colour in words a prompt can use', () => {
    for (const named of BUILT_IN_PALETTES) {
      for (const role of PALETTE_ROLES) {
        expect(colourNameOf(named.palette.roles[role])).not.toMatch(/^#/)
      }
    }
  })

  it('is where the palette a new project copies comes from', () => {
    // One source for those six hexes rather than two that can disagree.
    const first = BUILT_IN_PALETTES[0]
    expect(first).toBeDefined()
    expect(DEFAULT_PALETTE).toBe(first?.palette)
  })

  it('carries at least one palette with extras, so a swap has extras to replace', () => {
    expect(
      BUILT_IN_PALETTES.some(named => named.palette.extras.length > 0)
    ).toBe(true)
  })
})

describe('reading a library', () => {
  it('refuses a palette that would turn a two-ink recipe to mud, naming it', () => {
    expect(() =>
      readPaletteLibrary(
        document([
          entry({ id: 'muddy', roles: roles({ accent: { hex: '#D9662C' } }) }),
        ])
      )
    ).toThrow(/muddy.*too close in lightness/s)
  })

  it('refuses a palette whose ink is not the darkest', () => {
    expect(() =>
      readPaletteLibrary(
        document([entry({ roles: roles({ neutral: { hex: '#000000' } }) })])
      )
    ).toThrow(/darkest/)
  })

  it('refuses a version it was not written for', () => {
    expect(() =>
      readPaletteLibrary({ version: 99, palettes: [entry()] })
    ).toThrow(/version 99/)
  })

  it('refuses a library with nothing in it', () => {
    expect(() => readPaletteLibrary(document([]))).toThrow(/no palettes/)
  })

  it('refuses two palettes with one id', () => {
    expect(() => readPaletteLibrary(document([entry(), entry()]))).toThrow(
      /declared twice/
    )
  })

  it('refuses an id no file could be named', () => {
    expect(() =>
      readPaletteLibrary(document([entry({ id: '../escape' })]))
    ).toThrow(/a file can be named/)
  })

  it('refuses a palette with no name', () => {
    expect(() => readPaletteLibrary(document([entry({ name: '  ' })]))).toThrow(
      /has no name/
    )
  })
})

describe('a saved palette', () => {
  it('comes back exactly as it went in', () => {
    const named = {
      id: 'mine',
      name: 'Mine',
      palette: BUILT_IN_PALETTES[1]?.palette as Palette,
    }

    expect(readUserPalette(writeUserPalette(named))).toEqual(named)
  })

  it('is written with the version an older build would check', () => {
    expect(
      writeUserPalette({ id: 'mine', name: 'Mine', palette: DEFAULT_PALETTE })
    ).toMatchObject({ version: USER_PALETTE_VERSION })
  })

  it('throws when it was hand-edited into something unusable', () => {
    // Skipped and counted by the caller, never selectable: the whole point of
    // refusing an invalid palette in the editor is that none can reach a recipe.
    expect(() =>
      readUserPalette({
        version: USER_PALETTE_VERSION,
        ...entry({ roles: roles({ neutral: { hex: '#FFFFFF' } }) }),
      })
    ).toThrow(/mine.*lightest/s)
  })

  it('throws on a version this build cannot read', () => {
    expect(() => readUserPalette({ version: 99, ...entry() })).toThrow(
      /version 99/
    )
  })

  it('is a copy, so editing the project afterwards cannot reach into it', () => {
    const written = writeUserPalette({
      id: 'mine',
      name: 'Mine',
      palette: DEFAULT_PALETTE,
    })

    expect(written.roles).not.toBe(DEFAULT_PALETTE.roles)
  })
})

describe('telling one palette from another', () => {
  it('matches a palette against itself', () => {
    expect(samePalette(DEFAULT_PALETTE, DEFAULT_PALETTE)).toBe(true)
  })

  it('stops matching the moment one hex changes', () => {
    const edited: Palette = {
      ...DEFAULT_PALETTE,
      roles: {
        ...DEFAULT_PALETTE.roles,
        primary: { hex: '#2FB6BF', name: null },
      },
    }

    expect(samePalette(DEFAULT_PALETTE, edited)).toBe(false)
  })

  it('counts an authored name as part of the palette', () => {
    // A colour called "House orange" is a different thing to say to a model
    // than the same hex named by the table, so the label has to drop to Custom.
    const named: Palette = {
      ...DEFAULT_PALETTE,
      roles: {
        ...DEFAULT_PALETTE.roles,
        primary: { ...DEFAULT_PALETTE.roles.primary, name: 'House orange' },
      },
    }

    expect(samePalette(DEFAULT_PALETTE, named)).toBe(false)
  })

  it('stops matching when an extra is added', () => {
    const withExtra: Palette = {
      ...DEFAULT_PALETTE,
      extras: [{ hex: '#A3B18A', name: null }],
    }

    expect(samePalette(DEFAULT_PALETTE, withExtra)).toBe(false)
  })

  it('finds the library palette a project is carrying, or says nothing does', () => {
    expect(namedPaletteFor(DEFAULT_PALETTE, BUILT_IN_PALETTES)?.id).toBe(
      BUILT_IN_PALETTES[0]?.id
    )

    const custom: Palette = {
      ...DEFAULT_PALETTE,
      extras: [{ hex: '#A3B18A', name: null }],
    }
    expect(namedPaletteFor(custom, BUILT_IN_PALETTES)).toBeNull()
  })
})

describe('minting an id for a saved palette', () => {
  it('slugifies the name, so the file is one somebody can find', () => {
    expect(paletteIdFrom('Warm dusk', [])).toBe('warm-dusk')
  })

  it('suffixes a collision rather than overwriting the earlier palette', () => {
    expect(paletteIdFrom('Warm dusk', ['warm-dusk'])).toBe('warm-dusk-2')
  })

  it('falls back to a palette name rather than a preset one', () => {
    expect(paletteIdFrom('パレット', [])).toBe('palette')
  })

  it('does not avoid preset ids, because nothing records a palette id', () => {
    // Preset ids are unique across all three preset libraries because a recipe
    // records one and it has to resolve to exactly one library. A palette is
    // copied in and its id is never written down anywhere, so a collision with
    // a preset shadows nothing.
    expect(paletteIdFrom('Glass caustics', [])).toBe('glass-caustics')
  })
})

describe('the invariant the library is authored against', () => {
  it('keeps the three mid roles far enough apart to duotone', () => {
    for (const named of BUILT_IN_PALETTES) {
      const mids = (['primary', 'secondary', 'accent'] as const).map(role =>
        lightnessOf(named.palette.roles[role].hex)
      )

      for (const [index, one] of mids.entries()) {
        for (const other of mids.slice(index + 1)) {
          expect(Math.abs(one - other), named.id).toBeGreaterThanOrEqual(
            MIN_ROLE_LIGHTNESS_GAP
          )
        }
      }
    }
  })
})
