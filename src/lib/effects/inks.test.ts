/**
 * The colours a reduction reduces to, and the transfer function underneath.
 *
 * The transfer is here rather than left implicit because it is the one thing
 * three implementations have to agree on — this file, the shader's `encode`, and
 * `src-tauri/src/effects/color.rs`. If they drift, a duotone visibly shifts the
 * moment somebody switches from an ordered kernel to a diffusion one, with the
 * same inks and the same image and no explanation on screen. The values pinned
 * below are the ones the Rust tests pin, deliberately.
 */

import { describe, expect, it } from 'vitest'
import type { Palette } from '@/lib/recipe/palette'
import { DEFAULT_PALETTE } from '@/lib/recipe/palettes'
import {
  hexFromLinear,
  inksFor,
  linearRgb,
  rampBetween,
  relativeLuminance,
  srgbToLinear,
} from './inks'

describe('the working space', () => {
  it('puts the encoded midpoint where sRGB actually puts it', () => {
    // The whole reason linear light matters: sRGB 128 is about 21.6% of the
    // light, not 50%. `spikes/post-effects/src/color.rs` pins this same number.
    expect(srgbToLinear(128)).toBeCloseTo(0.2158, 3)
  })

  it('pins its endpoints exactly', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(255)).toBe(1)
    expect(hexFromLinear([0, 0, 0])).toBe('#000000')
    expect(hexFromLinear([1, 1, 1])).toBe('#FFFFFF')
  })

  it('round-trips every byte, so nothing drifts on the way through', () => {
    for (let byte = 0; byte <= 255; byte++) {
      const hex = `#${byte.toString(16).padStart(2, '0').repeat(3)}`
      const [r, g, b] = linearRgb(hex)
      expect(hexFromLinear([r, g, b]), hex).toBe(hex.toUpperCase())
    }
  })

  it('weights green most, the way sRGB’s primaries do', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#00FF00')).toBeGreaterThan(
      relativeLuminance('#FF0000')
    )
    expect(relativeLuminance('#FF0000')).toBeGreaterThan(
      relativeLuminance('#0000FF')
    )
  })
})

describe('a duotone’s ramp', () => {
  it('keeps its two endpoints exactly', () => {
    const ramp = rampBetween('#14110F', '#F4EFE6', 4)
    expect(ramp).toHaveLength(4)
    expect(ramp[0]?.hex).toBe('#14110F')
    expect(ramp[3]?.hex).toBe('#F4EFE6')
  })

  it('climbs in luminance rather than wandering', () => {
    // The shape of the reduction is index → colour, so a ramp that is not
    // monotonic maps a dithered mask onto colours in the wrong order.
    const ramp = rampBetween('#14110F', '#F4EFE6', 6)
    const light = ramp.map(ink => ink.luminance)
    expect(
      light.every((v, at) => at === 0 || v > (light[at - 1] as number))
    ).toBe(true)
  })

  it('interpolates the light and not the bytes', () => {
    // The midpoint of black and white in linear light encodes to sRGB 188, not
    // to 128. Getting this wrong is the same mistake as dithering encoded
    // values, one stage earlier — and the midtones are where a three-level
    // duotone lives.
    const middle = rampBetween('#000000', '#FFFFFF', 3)[1]
    expect(middle?.hex).toBe('#BCBCBC')
    // Half the light, to within the byte the hex could hold it in.
    expect(middle?.luminance).toBeCloseTo(0.5, 2)
  })

  it('is never fewer than two inks, whatever it is asked for', () => {
    expect(rampBetween('#000000', '#FFFFFF', 1)).toHaveLength(2)
    expect(rampBetween('#000000', '#FFFFFF', 0)).toHaveLength(2)
  })
})

describe('the inks a palette offers', () => {
  it('comes back darkest first', () => {
    const inks = inksFor(DEFAULT_PALETTE, 4)
    const light = inks.map(ink => ink.luminance)
    expect(
      light.every((v, at) => at === 0 || v >= (light[at - 1] as number))
    ).toBe(true)
  })

  it('always keeps both ends', () => {
    // A two-ink reduction has to mean "ink on paper" rather than "two of the
    // six, whichever happened to sort first".
    const all = inksFor(DEFAULT_PALETTE, 6)
    const two = inksFor(DEFAULT_PALETTE, 2)

    expect(two).toHaveLength(2)
    expect(two[0]?.hex).toBe(all[0]?.hex)
    expect(two[1]?.hex).toBe(all[all.length - 1]?.hex)
  })

  it('never offers the same colour twice', () => {
    // Two slots at one hex would be a reduction to fewer entries than it says.
    // An extra rather than a role, because the roles are already held apart by
    // `readPalette`'s own invariant and the extras are not.
    const twinned: Palette = {
      ...DEFAULT_PALETTE,
      extras: [{ hex: DEFAULT_PALETTE.roles.primary.hex, name: null }],
    }
    const inks = inksFor(twinned, 7)
    expect(new Set(inks.map(ink => ink.hex)).size).toBe(inks.length)
  })

  it('gives back what it has rather than padding', () => {
    expect(inksFor(DEFAULT_PALETTE, 40).length).toBeLessThanOrEqual(
      6 + DEFAULT_PALETTE.extras.length
    )
    expect(inksFor(DEFAULT_PALETTE, 1)).toHaveLength(2)
  })

  it('uses an extra colour the project added', () => {
    const withExtra: Palette = {
      ...DEFAULT_PALETTE,
      extras: [{ hex: '#7F7F7F', name: null }],
    }
    expect(inksFor(withExtra, 8).map(ink => ink.hex)).toContain('#7F7F7F')
  })
})
