/**
 * The colours a reduction reduces *to*, taken from the project's own palette.
 *
 * Not a knob, deliberately. A "palette reduced" look with its own list of inks
 * would be a second palette next to the one #46 gave the project, and the first
 * time somebody edited theirs the two would disagree about what the brand is.
 * The knob is *how many*; which ones is the project's answer.
 *
 * Sorted by luminance, always, because the whole shape of the reduction is
 * `index → colour`: a dithered luminance mask mapped onto an unsorted list
 * produces colours in an arbitrary order, which is a bug rather than a look
 * (`spikes/post-effects/src/palette.rs` says the same thing for the same
 * reason).
 */

import { paletteSlots, type Palette } from '@/lib/recipe/palette'

/** One ink, as the renderer wants it. */
export interface Ink {
  readonly hex: string
  /** Relative luminance in linear light, `0..1`. */
  readonly luminance: number
}

/**
 * `count` inks off the project's palette, darkest first.
 *
 * The two ends are always kept and the interior is spread evenly across what is
 * left. Keeping the ends is what makes a two-ink reduction mean "ink on paper"
 * rather than "two of the six, whichever happened to sort first" — and the
 * darkest and lightest are the two roles #46 already holds a rule about.
 *
 * Every slot is a candidate, roles and extras alike: an extra colour somebody
 * added to the project is a colour they want used.
 */
export function inksFor(palette: Palette, count: number): readonly Ink[] {
  const all = paletteSlots(palette)
    .map(([, entry]) => ({
      hex: entry.hex,
      luminance: relativeLuminance(entry.hex),
    }))
    // A palette with two slots at the same hex would otherwise offer the same
    // ink twice, which is a reduction to fewer entries than it claims.
    .filter(
      (ink, at, list) => list.findIndex(other => other.hex === ink.hex) === at
    )
    .sort((a, b) => a.luminance - b.luminance)

  const wanted = Math.max(2, Math.min(Math.round(count), all.length))
  if (all.length <= wanted) return all

  const picked = Array.from({ length: wanted }, (_, at) => {
    const along = (at * (all.length - 1)) / (wanted - 1)
    return all[Math.round(along)] as Ink
  })

  return picked
}

/**
 * `levels` steps between two inks, interpolated **in linear light**.
 *
 * What a duotone reduces to. Built here rather than in the shader so both
 * render paths reduce to the same colours: the shader interpolates the same two
 * endpoints per pixel, and the CPU path is handed this list already resolved.
 *
 * Interpolating the *encoded* bytes instead would put the intermediate steps in
 * the wrong place — the same mistake as dithering encoded values, one stage
 * earlier — and a three- or four-level duotone lives entirely in those steps.
 */
export function rampBetween(
  dark: string,
  light: string,
  levels: number
): readonly Ink[] {
  const steps = Math.max(2, Math.round(levels))
  const from = linearRgb(dark)
  const to = linearRgb(light)

  return Array.from({ length: steps }, (_, at) => {
    const along = at / (steps - 1)
    const mixed: [number, number, number] = [
      from[0] + (to[0] - from[0]) * along,
      from[1] + (to[1] - from[1]) * along,
      from[2] + (to[2] - from[2]) * along,
    ]
    const hex = hexFromLinear(mixed)
    return { hex, luminance: relativeLuminance(hex) }
  })
}

/** Three linear channels back to `#RRGGBB` — the exact inverse transfer. */
export function hexFromLinear(
  channels: readonly [number, number, number]
): string {
  const byte = (linear: number): string => {
    const encoded =
      linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
    return Math.round(Math.min(255, Math.max(0, encoded * 255)))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${byte(channels[0])}${byte(channels[1])}${byte(channels[2])}`.toUpperCase()
}

/**
 * Relative luminance of an sRGB hex, in linear light.
 *
 * The coefficients are sRGB's own primaries, applied to *decoded* values — the
 * classic mistake is applying them to the encoded bytes, which is what
 * `lightnessOf` deliberately does not do either. Held to
 * `spikes/post-effects/src/color.rs` by the parity test.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearRgb(hex)
  return 0.212639 * r + 0.715169 * g + 0.072192 * b
}

/** An sRGB hex as three linear-light channels, `0..1`. */
export function linearRgb(hex: string): readonly [number, number, number] {
  const clean = hex.replace('#', '')
  const byte = (at: number): number =>
    Number.parseInt(clean.slice(at, at + 2), 16) || 0
  return [srgbToLinear(byte(0)), srgbToLinear(byte(2)), srgbToLinear(byte(4))]
}

/**
 * One sRGB-encoded byte to linear light — IEC 61966-2-1, exact.
 *
 * Exact rather than `pow(x, 2.2)`, for the reason the spike gives: an
 * approximation here is a second uncontrolled variable sitting next to the one
 * being looked at, and the GPU path gets the exact transfer for free from
 * `SRGB8_ALPHA8` sampling. If the two disagreed, a duotone would visibly shift
 * when the user switched from an ordered kernel to a diffusion one — same inks,
 * same image, no explanation.
 */
export function srgbToLinear(byte: number): number {
  const s = byte / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
