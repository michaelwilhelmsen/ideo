import { describe, it, expect } from 'vitest'
import {
  ASPECTS,
  aspectById,
  describeRatio,
  isAspectId,
  matchesAspect,
} from './aspects'

describe('the aspect catalogue', () => {
  it('offers exactly the curated list of PRD §4.4', () => {
    expect(ASPECTS.map(a => a.id)).toEqual([
      '16:9',
      '21:9',
      '2:1',
      '3:2',
      '1:1',
      '3:4',
      '9:16',
    ])
  })

  it('marks every entry for whether animation is possible', () => {
    // PRD §4.4 — the mark is the point: a ratio the video model refuses would
    // fail at the last and most expensive step.
    for (const aspect of ASPECTS) {
      expect(typeof aspect.animatable).toBe('boolean')
    }
  })

  it('only claims animation where a video model confirms the ratio', () => {
    // PRD §9.1 — Luma Ray 2 has an explicit 21:9/16:9 enum, and 1:1 is
    // confirmed on Wan FLF2V. 2:1 and 3:2 are reachable only through Kling's
    // inherited range, which is not the same as a confirmed enum.
    expect(aspectById('16:9').animatable).toBe(true)
    expect(aspectById('21:9').animatable).toBe(true)
    expect(aspectById('1:1').animatable).toBe(true)
    expect(aspectById('2:1').animatable).toBe(false)
    expect(aspectById('3:2').animatable).toBe(false)
    // The portrait pair, on the same evidence: 9:16 is in five video enums,
    // 3:4 in FLUX 3's and Luma Ray 2's.
    expect(aspectById('9:16').animatable).toBe(true)
    expect(aspectById('3:4').animatable).toBe(true)
  })

  it('gives every entry a reason string key rather than English', () => {
    for (const aspect of ASPECTS) {
      expect(aspect.noteKey).toMatch(/^editor\.aspect\./)
    }
  })

  it('recognises a stored ratio, and refuses one it never offered', () => {
    // A manifest is read from disk, so its aspect is untrusted input.
    expect(isAspectId('21:9')).toBe(true)
    expect(isAspectId('4:3')).toBe(false)
    expect(isAspectId('')).toBe(false)
  })

  it('describes each ratio numerically, so a preview can size itself', () => {
    expect(aspectById('16:9').ratio).toBeCloseTo(16 / 9)
    expect(aspectById('1:1').ratio).toBe(1)
  })
})

describe('an upload has to be the shape the project locked (#27)', () => {
  it('accepts an image at exactly the project ratio', () => {
    expect(matchesAspect(1920, 1080, '16:9')).toBe(true)
    expect(matchesAspect(2352, 1008, '21:9')).toBe(true)
    expect(matchesAspect(1024, 1024, '1:1')).toBe(true)
  })

  it('accepts a crop that is off by a pixel or two, which is still 16:9', () => {
    // Refusing a 1920×1081 export would be pedantry, not a check.
    expect(matchesAspect(1920, 1081, '16:9')).toBe(true)
  })

  it('refuses a genuinely different shape', () => {
    // The closest two curated ratios are 11% apart, so no adjacent pair can
    // be confused for one another at this tolerance.
    expect(matchesAspect(1500, 1000, '16:9')).toBe(false)
    expect(matchesAspect(1920, 1080, '1:1')).toBe(false)
    expect(matchesAspect(2000, 1000, '21:9')).toBe(false)
  })

  it('refuses dimensions that are not an image at all', () => {
    expect(matchesAspect(0, 1080, '16:9')).toBe(false)
    expect(matchesAspect(1920, 0, '16:9')).toBe(false)
    expect(matchesAspect(Number.NaN, 1080, '16:9')).toBe(false)
  })

  it('names the ratio an image actually is, for the refusal', () => {
    expect(describeRatio(1500, 1000)).toBe('3:2')
    expect(describeRatio(1920, 1080)).toBe('16:9')
    // Nothing we have a name for is said as a number rather than guessed at.
    expect(describeRatio(1000, 1000 / 1.23)).toBe('1.23:1')
  })
})
