import { describe, it, expect } from 'vitest'
import { ASPECTS, aspectById, isAspectId } from './aspects'

describe('the aspect catalogue', () => {
  it('offers exactly the curated list of PRD §4.4', () => {
    expect(ASPECTS.map(a => a.id)).toEqual([
      '16:9',
      '21:9',
      '2:1',
      '3:2',
      '1:1',
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
