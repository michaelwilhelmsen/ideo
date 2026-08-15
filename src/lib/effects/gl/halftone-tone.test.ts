/**
 * The halftone screen's tone path, replayed on the CPU.
 *
 * There is no GPU on a CI runner, and #54 is a defect that only shows up as a
 * *measurement*: the screen delivered the wrong amount of ink, by an amount
 * that depended on the ruling, and no amount of reading the shader made that
 * visible. So the tone path is written out a second time here — the same three
 * shape branches, the same footprint bracket, the same sub-sample count — and
 * the property that failed is asserted against it directly.
 *
 * A replica is only worth its fidelity to the original, so `matches the shader
 * it stands in for` pins the arithmetic the two share. What neither can cover
 * is the compile: the GLSL is checked by running the app.
 *
 * There is no `fwidth` here, and that is the point. The shader derives its
 * footprint from the screen angle and the cell size rather than from a hardware
 * derivative, so this model is an exact replica rather than an approximate one
 * — a disagreement is a real disagreement, not a per-quad modelling artefact.
 */

import { describe, expect, it } from 'vitest'
import { fragmentSourceFor } from './shaders'

/** Half the diagonal of a unit cell: the furthest a dot can be from its centre. */
const CORNER = Math.SQRT1_2

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high)

const fract = (value: number) => value - Math.floor(value)

/** The fraction of one cell lying nearer the dot centre than `distance`. */
function nearerThan(distance: number, shape: number): number {
  if (shape === 2) return clamp(2 * distance, 0, 1)
  if (shape === 1) return clamp(4 * distance * distance, 0, 1)
  if (distance <= 0.5) return Math.PI * distance * distance
  if (distance >= CORNER) return 1
  const segment =
    distance * distance * Math.acos(0.5 / distance) -
    0.5 * Math.sqrt(Math.max(distance * distance - 0.25, 0))
  return clamp(Math.PI * distance * distance - 4 * segment, 0, 1)
}

/** How many sub-samples across the pixel, at this ruling. */
function tapsFor(cell: number): number {
  return clamp(Math.ceil(16 / Math.max(cell, 1)), 1, 6)
}

/** What the shader writes as the paper fraction at one output pixel. */
function paperAt(
  x: number,
  y: number,
  cell: number,
  angle: number,
  shape: number,
  ink: number
): number {
  const size = Math.max(cell, 1)
  const turnX = Math.cos((angle * Math.PI) / 180)
  const turnY = Math.sin((angle * Math.PI) / 180)
  const perPixel = (Math.abs(turnX) + Math.abs(turnY)) / size

  const taps = tapsFor(cell)
  const stride = 1 / taps
  const furthest = shape === 0 ? CORNER : 0.5

  let covered = 0
  for (let row = 0; row < taps; row++) {
    for (let column = 0; column < taps; column++) {
      const atX = x + (column + 0.5) * stride - 0.5
      const atY = y + (row + 0.5) * stride - 0.5
      const offsetX = fract((turnX * atX - turnY * atY) / size) - 0.5
      const offsetY = fract((turnY * atX + turnX * atY) / size) - 0.5

      let distance: number
      let reach: number
      if (shape === 0) {
        distance = Math.hypot(offsetX, offsetY)
        const alongX = offsetX * turnX + offsetY * turnY
        const alongY = offsetY * turnX - offsetX * turnY
        reach =
          (stride * (Math.abs(alongX) + Math.abs(alongY))) /
          (Math.max(distance, 1e-6) * size)
      } else {
        distance =
          shape === 1
            ? Math.max(Math.abs(offsetX), Math.abs(offsetY))
            : Math.abs(offsetY)
        reach = stride * perPixel
      }

      const nearArea = nearerThan(Math.max(distance - reach * 0.5, 0), shape)
      const farArea = nearerThan(
        Math.min(distance + reach * 0.5, furthest),
        shape
      )
      covered +=
        farArea - nearArea < 1e-9
          ? nearArea < ink
            ? 1
            : 0
          : clamp((ink - nearArea) / (farArea - nearArea), 0, 1)
    }
  }
  return 1 - covered / (taps * taps)
}

/**
 * The ink actually delivered over a patch of one flat tone.
 *
 * A patch rather than a pixel, because the whole question is what a *pattern*
 * averages to. The patch is sized in cells rather than in pixels so that every
 * ruling is judged over the same number of cells and none of them is judged on
 * a window that cuts its pattern off mid-dot: 24 cells holds the window's own
 * edge under a ten-thousandth, which is where these numbers stop moving.
 */
function deliveredInk(
  cell: number,
  angle: number,
  shape: number,
  ink: number,
  cellsAcross = 24
): number {
  const side = Math.round(cellsAcross * cell)
  let sum = 0
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++)
      sum += 1 - paperAt(x + 0.5, y + 0.5, cell, angle, shape, ink)
  }
  return sum / (side * side)
}

const SHAPES = ['round', 'square', 'line'] as const
const INKS = [0.1, 0.25, 0.5, 0.75, 0.9]
/** The ends of the shipped `cell` range, and octave steps between them. */
const CELLS = [2, 3, 6, 12, 32]
const ANGLES = [0, 15, 45]

/**
 * What #54 asks for, and roughly what the eye can hold against a neighbouring
 * patch. Tighter is not available at the fine end: at cell 2 a dot is two
 * pixels across and the tone rides on partial pixels, which the sub-sampling
 * recovers but not without limit. The worst case here is 0.017.
 */
const TOLERANCE = 0.02

describe('what the halftone screen delivers', () => {
  /**
   * The defect, stated as the property it broke.
   *
   * Cell size sets how big the dots are; it does not set how dark the picture
   * is. Before #54 the antialias band doubled as a tone curve, and the same
   * frame printed differently at different rulings — 10% ink arriving as 15.5%
   * and 75% as 69.5% at cell 2, converging to correct only as the cell grew.
   * A compression toward mid grey, not a darkening, which is why it could not
   * be taken out with a single-sided correction to the radius.
   */
  it.each(SHAPES.map((name, shape) => [name, shape] as const))(
    'holds a %s dot to the ink it was asked for, at every ruling',
    (_name, shape) => {
      const missed: string[] = []
      for (const angle of ANGLES) {
        for (const ink of INKS) {
          for (const cell of CELLS) {
            const got = deliveredInk(cell, angle, shape, ink)
            if (Math.abs(got - ink) > TOLERANCE)
              missed.push(
                `ink ${ink} at cell ${cell}, ${angle}°: ${got.toFixed(4)}`
              )
          }
        }
      }
      expect(missed).toEqual([])
    }
  )

  /**
   * Not an artefact of grid alignment.
   *
   * 0° is the hard one and the reason this is here: the cell grid lines up with
   * the pixel grid, every cell is sampled at the same place inside itself, and
   * a screen that leans on the pattern averaging out across cells has nothing
   * left to average over.
   */
  it('says the same thing at every screen angle', () => {
    const missed: string[] = []
    for (const angle of [0, 7, 15, 30, 45, 60, 75]) {
      for (let shape = 0; shape < SHAPES.length; shape++) {
        for (const cell of CELLS) {
          for (const ink of [0.1, 0.5, 0.9]) {
            const got = deliveredInk(cell, angle, shape, ink, 12)
            if (Math.abs(got - ink) > TOLERANCE)
              missed.push(
                `${SHAPES[shape]} ink ${ink} at cell ${cell}, ${angle}°: ${got.toFixed(4)}`
              )
          }
        }
      }
    }
    expect(missed).toEqual([])
  })

  /** Paper is paper and solid is solid, or the tone range has no ends. */
  it('leaves ink 0 as clean paper and ink 1 as solid', () => {
    for (const angle of ANGLES) {
      for (let shape = 0; shape < SHAPES.length; shape++) {
        for (const cell of CELLS) {
          expect(deliveredInk(cell, angle, shape, 0, 4)).toBe(0)
          expect(deliveredInk(cell, angle, shape, 1, 4)).toBe(1)
        }
      }
    }
  })

  /**
   * The edge is still an edge.
   *
   * Making the tone exact would be trivial with a hard threshold — and would
   * stair-step at every fine ruling, which is what the band was there for in
   * the first place. Across a dot at cell 3 there have to be plenty of pixels
   * that are neither paper nor ink.
   */
  it('still softens the dot edge rather than stepping it', () => {
    for (let shape = 0; shape < SHAPES.length; shape++) {
      const partial = new Set<number>()
      for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
          const value = paperAt(x + 0.5, y + 0.5, 3, 15, shape, 0.5)
          if (value > 0.02 && value < 0.98) partial.add(Math.round(value * 100))
        }
      }
      expect(partial.size).toBeGreaterThan(8)
    }
  })

  it('matches the shader it stands in for', () => {
    const source = fragmentSourceFor('halftone')
    // The three shapes' area laws, which are what the old radius constants were
    // shorthand for — see `keeps each shape's constant` in shaders.test.ts.
    expect(source).toContain('2.0 * d, 0.0, 1.0')
    expect(source).toContain('4.0 * d * d, 0.0, 1.0')
    expect(source).toContain('3.14159265 * d * d')
    // The cell's corner, as the end of the round dot's range rather than as a
    // radius. Sizing the dot itself by the half-diagonal is the old defect, and
    // there is no radius here to size that way any more.
    expect(source).toContain('0.70710678')
    expect(source).not.toContain('sqrt(ink)')
    // The soft edge itself: the requested ink placed between the two areas
    // that bracket the footprint, rather than a hard threshold against one.
    expect(source).toContain(
      'clamp((ink - nearArea) / (farArea - nearArea), 0.0, 1.0)'
    )
    // And the two numbers this model replays to reproduce that footprint.
    expect(source).toContain('ceil(16.0 / size), 1.0, 6.0')
    expect(source).toContain('1.0 / float(taps)')
  })
})
