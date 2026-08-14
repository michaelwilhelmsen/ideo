/**
 * A treatment, and the two things it has to survive.
 *
 * **Being written down**, because that failure mode is *silent*: `readParams`
 * drops what it does not recognise by design, so a treatment read the same way
 * would reopen as a project that looks like nobody ever treated anything. That
 * is the one this file starts with.
 *
 * **Arriving from #53**, because four recipes already say what has to happen to
 * them and the whole point of that ticket was that #36 would not have to
 * re-derive four intentions from English. The rule under test is the one #53
 * states about its own fields: a seed, never a lock.
 */

import { describe, expect, it } from 'vitest'
import { readManifest, writeManifest } from '@/lib/recipe/manifest'
import { DEFAULT_PALETTE } from '@/lib/recipe/palettes'
import {
  sourcePresetById,
  stylePresetById,
  type Preset,
} from '@/lib/recipe/presets'
import { ATLAS } from '@/lib/recipe/fixtures'
import type { Project, Treatment } from '@/lib/recipe/types'
import { BUILT_IN_LOOKS, lookById, type EffectsLook } from './looks'
import {
  readTreatment,
  resolveTreatment,
  seedTreatmentFrom,
  treatmentFor,
  withKnob,
  writeTreatment,
} from './treatment'

const HALFTONE = lookById('fx-halftone') as EffectsLook
const DUOTONE = lookById('fx-duotone-dither') as EffectsLook

/** The project fixture with one candidate treated. */
function treated(treatment: Treatment): Project {
  return {
    ...ATLAS,
    generations: ATLAS.generations.map((generation, at) =>
      at === 0 ? { ...generation, treatment } : generation
    ),
  }
}

describe('a treatment survives a write and a reopen', () => {
  it('keeps its values, its look and its modified flag', () => {
    // The assertion this file exists for. Nothing about it is visible when it
    // regresses: the project simply reopens untreated.
    const nudged = withKnob(
      treatmentFor(HALFTONE, DEFAULT_PALETTE),
      HALFTONE,
      'angle',
      15
    )
    const project = treated(nudged)

    const reopened = readManifest(
      JSON.parse(JSON.stringify(writeManifest(project, 0)))
    )

    expect(reopened.generations[0]?.treatment).toEqual(nudged)
    expect(reopened.generations[0]?.treatment?.lookModified).toBe(true)
    expect(reopened.generations[1]?.treatment).toBeNull()
  })

  it('keeps a value for a knob this build does not know about', () => {
    // A manifest written by a newer build, or a fork with a knob we have not
    // shipped yet. Dropping it here would downgrade somebody's treatment on
    // the way through a build that merely did not recognise it.
    const reloaded = readTreatment(
      writeTreatment({
        lookId: 'fx-halftone',
        values: { angle: 15, fromTheFuture: 'x' },
        lookModified: true,
      })
    )

    expect(reloaded?.values.fromTheFuture).toBe('x')
  })

  it('is not resolved against the library on the way in', () => {
    // A look can be forked, renamed, or live in a folder this build has not
    // loaded. Refusing the record over that would lose it to a file that is
    // merely elsewhere.
    const reloaded = readTreatment({
      lookId: 'a-look-nobody-here-has',
      values: { levels: 3 },
      lookModified: false,
    })

    expect(reloaded?.lookId).toBe('a-look-nobody-here-has')
  })

  it('is not a treatment without a look to name', () => {
    expect(readTreatment(null)).toBeNull()
    expect(readTreatment({ values: {} })).toBeNull()
    expect(readTreatment({ lookId: '' })).toBeNull()
    // An array is an object too — the case a naive record check would pass.
    expect(readTreatment([])).toBeNull()
  })

  it('drops a value no knob could ever hold', () => {
    const reloaded = readTreatment({
      lookId: 'fx-halftone',
      values: { angle: 15, nested: { a: 1 }, missing: null },
      lookModified: false,
    })

    expect(reloaded?.values).toEqual({ angle: 15 })
  })
})

describe('rendering a treatment through a look', () => {
  it('fills in a knob the treatment says nothing about', () => {
    const values = resolveTreatment(
      { lookId: HALFTONE.id, values: { angle: 15 }, lookModified: true },
      HALFTONE,
      DEFAULT_PALETTE
    )

    expect(values.angle).toBe(15)
    expect(values.cell).toBe(6)
    expect(values.inkDark).toBe(DEFAULT_PALETTE.roles.ink.hex)
  })

  it('clamps a hand-edited manifest quietly rather than refusing to open', () => {
    // The loud refusal belongs to the library loader, where a bad value is a
    // bad *declaration*. Here it is one number in a file, and a tab that will
    // not open over it is worse than a control that has moved.
    const values = resolveTreatment(
      {
        lookId: HALFTONE.id,
        values: { cell: 9_000, shape: 'hexagon' },
        lookModified: true,
      },
      HALFTONE,
      DEFAULT_PALETTE
    )

    expect(values.cell).toBe(32)
    expect(values.shape).toBe('round')
  })

  it('drops a value for a knob the look no longer has', () => {
    const values = resolveTreatment(
      { lookId: HALFTONE.id, values: { levels: 4 }, lookModified: true },
      HALFTONE,
      DEFAULT_PALETTE
    )

    expect(values.levels).toBeUndefined()
  })
})

describe('turning a knob', () => {
  it('records that the look was nudged', () => {
    const chosen = treatmentFor(DUOTONE, DEFAULT_PALETTE)
    expect(chosen.lookModified).toBe(false)

    expect(withKnob(chosen, DUOTONE, 'levels', 4).lookModified).toBe(true)
  })

  it('leaves the treatment alone when the value would not stick', () => {
    // A control that appears to take a value it then ignores is worse than one
    // that does not move.
    const chosen = treatmentFor(DUOTONE, DEFAULT_PALETTE)

    expect(withKnob(chosen, DUOTONE, 'kernel', 'sierra')).toBe(chosen)
    expect(withKnob(chosen, DUOTONE, 'notAKnob', 3)).toBe(chosen)
  })

  it('does not call setting a knob to what it already says a nudge', () => {
    const chosen = treatmentFor(DUOTONE, DEFAULT_PALETTE)
    expect(withKnob(chosen, DUOTONE, 'kernel', 'bayer8')).toBe(chosen)
  })
})

describe('#53’s declarations arriving in the tab', () => {
  /** The four recipes that declare a post-treatment, from both libraries. */
  const DECLARING = [
    'rs-duotone-dither',
    'rs-halftone-highkey',
    'gn-duotone-landscape',
    'gn-halftone-highkey',
  ] as const

  function presetOf(id: string): Preset {
    const preset = stylePresetById(id) ?? sourcePresetById(id)
    expect(preset, id).not.toBeNull()
    return preset as Preset
  }

  it('seeds each of the four with the kernel it declares', () => {
    for (const id of DECLARING) {
      const preset = presetOf(id)
      const seeded = seedTreatmentFrom(preset, BUILT_IN_LOOKS, DEFAULT_PALETTE)

      expect(seeded, id).not.toBeNull()
      expect(seeded?.values.kernel, id).toBe(preset.ditherKernel)
    }
  })

  it('seeds a look that actually offers that kernel', () => {
    const seeded = seedTreatmentFrom(
      presetOf('gn-duotone-landscape'),
      BUILT_IN_LOOKS,
      DEFAULT_PALETTE
    )
    const look = lookById(seeded?.lookId ?? null)

    expect(look?.shader).toBe('duotone')
    expect(seeded?.values.kernel).toBe('atkinson')
  })

  it('is not a nudge — a seeded treatment is the look, unmodified', () => {
    // The flag says "somebody turned this". The recipe already said it, so
    // nobody did.
    const seeded = seedTreatmentFrom(
      presetOf('rs-halftone-highkey'),
      BUILT_IN_LOOKS,
      DEFAULT_PALETTE
    )

    expect(seeded?.lookModified).toBe(false)
  })

  it('says nothing for the forty recipes that declare nothing', () => {
    const quiet = presetOf('rs-cinestill')
    expect(quiet.ditherKernel).toBeNull()
    expect(seedTreatmentFrom(quiet, BUILT_IN_LOOKS, DEFAULT_PALETTE)).toBeNull()
    expect(seedTreatmentFrom(null, BUILT_IN_LOOKS, DEFAULT_PALETTE)).toBeNull()
  })

  it('carries a declared level placement onto the same look', () => {
    // All four leave placement `null` today, so this exercises the mechanism
    // rather than the material — which is the point of having it at all.
    const seeded = seedTreatmentFrom(
      { ...presetOf('rs-duotone-dither'), levelPlacement: 'even' },
      BUILT_IN_LOOKS,
      DEFAULT_PALETTE
    )

    // The duotone look is a ramp between two inks, where the placement knob is
    // inert — so it has none, and the declaration is dropped rather than
    // stored against a control that does not exist.
    expect(seeded?.values.levelPlacement).toBeUndefined()
  })

  it('seeds nothing from a library with no look for that kernel', () => {
    const withoutDuotone = BUILT_IN_LOOKS.filter(
      look => look.shader !== 'duotone' && look.shader !== 'paletteReduced'
    )
    expect(
      seedTreatmentFrom(
        presetOf('rs-duotone-dither'),
        withoutDuotone,
        DEFAULT_PALETTE
      )
    ).toBeNull()
  })
})
