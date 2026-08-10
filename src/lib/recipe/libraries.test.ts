/**
 * Three libraries, seen from outside.
 *
 * The claim under test is the one #47 exists to make true: no stage borrows
 * another stage's list, and an id belongs to exactly one library — which is what
 * lets a readout resolve a recipe's `presetId` without knowing which stage it
 * came from.
 */

import { describe, expect, it } from 'vitest'
import {
  builtInPresetIds,
  isBuiltInPresetId,
  presetById,
  presetsForStage,
} from './libraries'
import { BUILT_IN_MOTION_PRESETS } from './motion'
import {
  BUILT_IN_SOURCE_PRESETS,
  BUILT_IN_STYLE_PRESETS,
  presetIdFrom,
} from './presets'
import { STAGE_ORDER } from './types'

describe('the presets on offer for a stage', () => {
  it('gives each stage its own library', () => {
    expect(presetsForStage('source')).toBe(BUILT_IN_SOURCE_PRESETS)
    expect(presetsForStage('style')).toBe(BUILT_IN_STYLE_PRESETS)
    expect(presetsForStage('animate')).toBe(BUILT_IN_MOTION_PRESETS)
  })

  it('never hands one stage another stage’s list', () => {
    // The conflation this issue broke: source used to be handed the style
    // library, which asked a text-to-image model to preserve a composition that
    // did not exist.
    const lists = STAGE_ORDER.map(stage => presetsForStage(stage))

    for (const [index, list] of lists.entries()) {
      expect(list.length, STAGE_ORDER[index]).toBeGreaterThan(0)
      for (const [other, against] of lists.entries()) {
        if (other === index) continue
        expect(list, `${STAGE_ORDER[index]} vs ${STAGE_ORDER[other]}`).not.toBe(
          against
        )
      }
    }
  })
})

describe('looking a preset up by id', () => {
  it('resolves an id from any of the three', () => {
    for (const stage of STAGE_ORDER) {
      for (const preset of presetsForStage(stage)) {
        expect(presetById(preset.id)?.name, `${stage}/${preset.id}`).toBe(
          preset.name
        )
      }
    }
  })

  it('refuses to invent one', () => {
    expect(presetById('no-such-preset')).toBeNull()
    expect(presetById(null)).toBeNull()
  })

  it('keeps every built-in id unique across the three libraries', () => {
    // Otherwise the order the three are tried in would decide the answer, and
    // "which preset produced this" would have two of them.
    const ids = builtInPresetIds()

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      STAGE_ORDER.flatMap(stage =>
        presetsForStage(stage).map(preset => preset.id)
      )
    )
  })
})

/**
 * What keeps that uniqueness true once the user starts forking.
 *
 * Nothing on disk enforces it: a fork is a file in one library's folder, and the
 * folders know nothing about each other (deliberately — #29's rule). So the
 * services ask this before accepting a file, and the picker asks it before
 * minting an id.
 */
describe('an id the built-ins have already taken', () => {
  it('is recognised whichever library holds it', () => {
    for (const stage of STAGE_ORDER) {
      for (const preset of presetsForStage(stage)) {
        expect(isBuiltInPresetId(preset.id), `${stage}/${preset.id}`).toBe(true)
      }
    }
  })

  it('lets anything else through', () => {
    expect(isBuiltInPresetId('warm-dusk')).toBe(false)
  })

  it('makes a fork take a suffix rather than shadow another library', () => {
    // A source fork the user calls "Mesh gradient" would slug straight onto the
    // style built-in, and `presetById` would then answer with the style one.
    const id = presetIdFrom('Mesh gradient', builtInPresetIds())

    expect(id).toBe('mesh-gradient-2')
    expect(isBuiltInPresetId(id)).toBe(false)
  })
})
