import { describe, expect, it } from 'vitest'
import { ASPECTS } from '@/lib/recipe'
import { portraitWidthCap, PREVIEW_VIEWPORT_FRACTION } from './preview-bounds'

describe('the height bound a preview gets', () => {
  it('caps the portrait ratios and leaves the rest alone', () => {
    // Landscape and square boxes take their height from a width the column
    // already bounds, so a cap there would be a second rule doing nothing.
    expect(portraitWidthCap('16:9')).toBeUndefined()
    expect(portraitWidthCap('21:9')).toBeUndefined()
    expect(portraitWidthCap('1:1')).toBeUndefined()

    expect(portraitWidthCap('9:16')?.maxWidth).toBe('calc(70vh * 9 / 16)')
    expect(portraitWidthCap('3:4')?.maxWidth).toBe('calc(70vh * 3 / 4)')
  })

  it('caps every entry the catalogue calls taller than it is wide', () => {
    // Read off `ASPECTS` rather than listed, so a portrait ratio added later
    // cannot arrive uncapped and several screens tall.
    for (const aspect of ASPECTS) {
      expect(portraitWidthCap(aspect.id) === undefined, aspect.id).toBe(
        aspect.ratio >= 1
      )
    }
  })

  it('keeps the ratio exact, which is why it caps width and not height', () => {
    // `max-height` on an `aspect-ratio` box does not shrink the width to match;
    // it crops. A capped preview of a locked ratio that is no longer that ratio
    // would be worse than an uncapped one.
    for (const aspect of ASPECTS.filter(entry => entry.ratio < 1)) {
      const cap = portraitWidthCap(aspect.id)?.maxWidth

      expect(cap, aspect.id).toBe(
        `calc(${String(PREVIEW_VIEWPORT_FRACTION * 100)}vh * ${String(aspect.width)} / ${String(aspect.height)})`
      )
    }
  })
})
