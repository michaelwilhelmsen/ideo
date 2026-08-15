/**
 * What a candidate can be exported as (#31).
 *
 * The claims worth pinning here are the ones the panel would otherwise get
 * quietly wrong: that a still is exportable at all, that it is exportable as a
 * *poster* and not as a one-frame video, and that a candidate with no file on
 * disk is a state rather than a crash.
 */

import { describe, expect, it } from 'vitest'
import { ATLAS, type Generation, type StageKind } from '@/lib/recipe'
import {
  anyRequested,
  availableFormats,
  exportBaseName,
  exportSizeOf,
  mediumOf,
  requestedFormats,
  rewindIsRedundant,
  rewindWanted,
} from './deliverables'

/** A candidate of the given stage, holding the given file. */
function candidate(
  stage: StageKind,
  asset: string | null,
  options: Record<string, boolean> = {}
): Generation {
  const template = ATLAS.generations.find(g => g.stage === stage)
  if (template === undefined) throw new Error(`no ${stage} fixture`)

  return {
    ...template,
    asset,
    recipe: {
      ...template.recipe,
      options: { ...template.recipe.options, ...options },
    },
  }
}

describe('what there is to export', () => {
  it('reads a clip from its file rather than from its stage', () => {
    expect(mediumOf(candidate('animate', 'gen-ani-1.mp4'))).toBe('clip')
    expect(mediumOf(candidate('animate', 'gen-ani-1.webm'))).toBe('clip')
  })

  it('reads a still the same way', () => {
    expect(mediumOf(candidate('style', 'gen-sty-2.png'))).toBe('still')
    expect(mediumOf(candidate('source', 'gen-src-2.jpeg'))).toBe('still')
  })

  /** A paid job that never landed. The panel says so; it does not offer a run. */
  it('calls a candidate with no file nothing, rather than guessing', () => {
    expect(mediumOf(candidate('animate', null))).toBe('nothing')
    expect(mediumOf(null)).toBe('nothing')
  })
})

describe('which files a candidate can produce', () => {
  it('offers all three from a clip', () => {
    expect(availableFormats('clip')).toEqual({
      mp4: true,
      webm: true,
      poster: true,
    })
  })

  /**
   * "Export works from the still stage as well as from video" (#31) — and what
   * it produces there is the picture, web-sized. A one-frame MP4 of a still is
   * a file nobody has ever wanted on a landing page.
   */
  it('offers a still its poster and no video', () => {
    expect(availableFormats('still')).toEqual({
      mp4: false,
      webm: false,
      poster: true,
    })
  })

  it('offers nothing at all when there is no file', () => {
    expect(anyRequested(availableFormats('nothing'))).toBe(false)
  })

  it('drops a video that was ticked before the selection became a still', () => {
    const ticked = { mp4: true, webm: true, poster: true }

    expect(requestedFormats(ticked, 'still')).toEqual({
      mp4: false,
      webm: false,
      poster: true,
    })
  })
})

describe('rewind (PRD §4.5)', () => {
  it('starts from what the recipe recorded', () => {
    expect(rewindWanted(candidate('animate', 'a.mp4', { rewind: true }))).toBe(
      true
    )
    expect(rewindWanted(candidate('animate', 'a.mp4', { rewind: false }))).toBe(
      false
    )
  })

  /**
   * The two mechanisms combine rather than conflict, and the combination is
   * merely pointless rather than wrong — so it is said, not refused.
   */
  it('says so when the clip already returns to its first frame', () => {
    const looping = candidate('animate', 'a.mp4', { loop: true })

    expect(rewindIsRedundant(looping, true)).toBe(true)
    expect(rewindIsRedundant(looping, false)).toBe(false)
    expect(
      rewindIsRedundant(candidate('animate', 'a.mp4', { loop: false }), true)
    ).toBe(false)
  })
})

describe('what the files are called', () => {
  it('names them after the project and the candidate, not the id', () => {
    const name = exportBaseName('Atlas — hero', candidate('animate', 'a.mp4'))

    expect(name).toBe('Atlas-hero-animate-1')
  })

  it('keeps the name stable across languages', () => {
    // The stage word is the domain term rather than a translated one: a file
    // name that moved with the app's language would break every link on the
    // page that used it.
    const name = exportBaseName('Ledger', candidate('style', 'a.png'))

    expect(name).toMatch(/-style-\d+$/)
  })

  it('still produces a name when the project name slugs away to nothing', () => {
    expect(exportBaseName('※※', candidate('source', 'a.png'))).toMatch(
      /^export-source-/
    )
  })
})

describe('the size a deliverable ships at', () => {
  // The same cases `export_size` asserts in `export/bake.rs`. Two languages
  // computing one number is only safe while they agree about it, and what the
  // preview draws its pattern at is whatever this says.
  it('caps at the export width and never upscales past it', () => {
    expect(exportSizeOf(3840, 2160)).toEqual([1920, 1080])
    expect(exportSizeOf(2560, 1440)).toEqual([1920, 1080])
    expect(exportSizeOf(1280, 720)).toEqual([1280, 720])
  })

  it('keeps both axes even', () => {
    // An odd height is a hard 4:2:0 failure rather than a slightly wrong
    // picture, which is why the filter graph says `-2` and not `-1`.
    const odd: readonly (readonly [number, number])[] = [
      [1000, 563],
      [1920, 1081],
      [999, 999],
    ]

    for (const [width, height] of odd) {
      const [wide, high] = exportSizeOf(width, height)
      expect(wide % 2).toBe(0)
      expect(high % 2).toBe(0)
    }
  })

  it('still produces something encodable from a degenerate size', () => {
    expect(exportSizeOf(0, 0)).toEqual([2, 2])
    expect(exportSizeOf(1, 1)).toEqual([2, 2])
  })
})
