/**
 * The motion library — the committed built-ins, and the loader that refuses a
 * bad one.
 *
 * The assertions worth making are the ones a careless edit breaks and nothing
 * else catches: a preset whose prompt asks for a camera move (which is the one
 * thing this library exists to avoid), an id a file cannot be named, and a fork
 * that does not survive the round trip through app data.
 */

import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_MOTION_PRESETS,
  isMotionPreset,
  motionPresetById,
  motionPresetFrom,
  motionSeedState,
  readMotionLibrary,
  readUserMotionPreset,
  USER_MOTION_PRESET_VERSION,
  writeUserMotionPreset,
} from './motion'
import { BUILT_IN_STYLE_PRESETS } from './presets'
import { isPresetId } from './presets'

/** A well-formed library, so each test states only what it is about. */
function library(presets: unknown[]): unknown {
  return { version: 1, presets }
}

const PRESET = {
  id: 'my-drift',
  name: 'My drift',
  prompt: 'Locked camera, one slow drift. No pan, no zoom.',
}

describe('the built-in motion library', () => {
  it('loads at import, or the module would not have loaded', () => {
    expect(BUILT_IN_MOTION_PRESETS.length).toBeGreaterThanOrEqual(6)
  })

  it('names every camera move it does not want, in the prompt itself', () => {
    // The acceptance criterion, made checkable. Only Veo has a
    // `negative_prompt` among the eight video endpoints, so on the other seven
    // the negation has to be text in the prompt or it is not sent at all
    // (`docs/research/preset-schema.md` §4).
    for (const preset of BUILT_IN_MOTION_PRESETS) {
      expect(preset.prompt.toLowerCase(), preset.id).toContain('no pan')
      expect(preset.prompt.toLowerCase(), preset.id).toContain('no zoom')
      expect(preset.prompt.toLowerCase(), preset.id).toContain('no dolly')
    }
  })

  it('gives every preset an id a file in app data could be named', () => {
    // A fork keeps the shape of the id it was slugged into, and Rust rejects
    // anything outside `[A-Za-z0-9_-]{1,64}` rather than sanitising it.
    for (const preset of BUILT_IN_MOTION_PRESETS) {
      expect(isPresetId(preset.id), preset.id).toBe(true)
    }
  })

  it('shares no id with the style library, because they are two libraries', () => {
    // A recipe records one `presetId` per stage; an id in both libraries would
    // make "which preset produced this" a question with two answers.
    const styleIds = new Set(BUILT_IN_STYLE_PRESETS.map(preset => preset.id))

    for (const preset of BUILT_IN_MOTION_PRESETS) {
      expect(styleIds.has(preset.id), preset.id).toBe(false)
    }
  })

  it('finds a preset by id and says null rather than guessing', () => {
    expect(motionPresetById('drifting-clouds')?.name).toBe('Drifting clouds')
    expect(motionPresetById('no-such-motion')).toBeNull()
    expect(motionPresetById(null)).toBeNull()
  })
})

describe('readMotionLibrary', () => {
  it('refuses a version this build would misread', () => {
    expect(() => readMotionLibrary({ version: 2, presets: [PRESET] })).toThrow(
      /not version 1/
    )
  })

  it('refuses a library with nothing in it', () => {
    expect(() => readMotionLibrary(library([]))).toThrow(/lists no presets/)
  })

  it('refuses a preset with an empty prompt, naming it', () => {
    expect(() =>
      readMotionLibrary(library([{ ...PRESET, prompt: '  ' }]))
    ).toThrow(/my-drift.*no prompt/)
  })

  it('refuses a preset with no name', () => {
    expect(() => readMotionLibrary(library([{ ...PRESET, name: '' }]))).toThrow(
      /no name/
    )
  })

  it('refuses an id no file could be named', () => {
    expect(() =>
      readMotionLibrary(library([{ ...PRESET, id: '../escape' }]))
    ).toThrow(/not an id a file can be named/)
  })

  it('refuses the same id twice', () => {
    expect(() => readMotionLibrary(library([PRESET, PRESET]))).toThrow(
      /declared twice/
    )
  })

  it('refuses something that is not a library at all', () => {
    expect(() => readMotionLibrary('a string')).toThrow(/Malformed/)
  })
})

describe('a user’s own motion preset', () => {
  it('round-trips through the document written to app data', () => {
    const saved = writeUserMotionPreset(PRESET)

    expect(saved.version).toBe(USER_MOTION_PRESET_VERSION)
    expect(readUserMotionPreset(saved)).toEqual(PRESET)
  })

  it('refuses a saved file from a version this build cannot read', () => {
    expect(() =>
      readUserMotionPreset({ ...writeUserMotionPreset(PRESET), version: 99 })
    ).toThrow(/not version 1/)
  })

  it('refuses a hand-edited file that lost its prompt', () => {
    // Skipped by the caller rather than fatal — one bad fork must not cost the
    // whole library — which is only possible because this throws rather than
    // returning something half-formed.
    expect(() =>
      readUserMotionPreset({ ...writeUserMotionPreset(PRESET), prompt: '' })
    ).toThrow(/no prompt/)
  })

  it('trims what the form gave it, so a stray newline is not a preset', () => {
    expect(
      motionPresetFrom({ id: 'x', name: '  My drift ', prompt: '  drift \n' })
    ).toEqual({ id: 'x', name: 'My drift', prompt: 'drift' })
  })
})

describe('motionSeedState', () => {
  it('says nothing is selected when nothing is', () => {
    expect(motionSeedState('anything', null)).toBe('none')
  })

  it('says seeded while the box says exactly what the preset says', () => {
    expect(motionSeedState(PRESET.prompt, PRESET)).toBe('seeded')
  })

  it('says stale once the prompt has been edited, so a re-seed can be offered', () => {
    expect(motionSeedState(`${PRESET.prompt} and more`, PRESET)).toBe('stale')
  })
})

describe('isMotionPreset', () => {
  it('tells the two libraries apart by their own shape, not by stage', () => {
    expect(isMotionPreset(PRESET)).toBe(true)
    const style = BUILT_IN_STYLE_PRESETS[0]
    expect(style).toBeDefined()
    expect(isMotionPreset(style as object)).toBe(false)
  })

  it('refuses a style preset that has grown a prompt of its own', () => {
    // The check is structural because presets are read from JSON on disk and a
    // required `kind` field would orphan every fork saved before it. So the
    // negative half carries the weight: `variants` is the style library's, and
    // a shape with both is not a movement whatever else it says.
    const impostor = { ...BUILT_IN_STYLE_PRESETS[0], prompt: 'a slow drift' }
    expect(isMotionPreset(impostor)).toBe(false)
  })

  it('refuses a prompt that is not text', () => {
    expect(isMotionPreset({ id: 'x', name: 'x', prompt: 4 })).toBe(false)
  })
})
