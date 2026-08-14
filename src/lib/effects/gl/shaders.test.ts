/**
 * The two things about the shaders that CI *can* check.
 *
 * #36 writes down the gap honestly: there is no GPU on a CI runner, so whether
 * the six looks are any good is golden images run locally plus the maintainer's
 * eye, and testing the shader indirectly through a mock would only prove the
 * mock works. What is left is worth having anyway, because both failures are
 * silent:
 *
 * 1. **The blue-noise mask** is committed data with a generator beside it, so it
 *    is checkable exactly like a preset library is.
 * 2. **The uniform indices** — a choice knob binds as the *index* of its option,
 *    which is what makes the binding generic, and that only works while the
 *    option list a look declares is in the order the shader indexes.
 */

import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_LOOKS,
  EFFECT_KERNELS,
  EFFECT_LEVEL_PLACEMENTS,
  EFFECT_SHADERS,
} from '../looks'
import { BLUE_NOISE_MASK, BLUE_NOISE_SIZE } from './blue-noise'
import {
  fragmentSourceFor,
  KNOBS_BOUND_VIA_INKS,
  SHADER_KERNEL_ORDER,
  SHADER_PLACEMENT_ORDER,
} from './shaders'

describe('the option indices the shaders read', () => {
  it('agrees with the kernel vocabulary, in order', () => {
    // `u_kernel` is the index of the chosen option. If a look's list and this
    // one ever disagreed, picking Atkinson would silently render clustered dot
    // — a wrong picture with no error anywhere.
    expect([...SHADER_KERNEL_ORDER]).toEqual([...EFFECT_KERNELS])
    expect([...SHADER_PLACEMENT_ORDER]).toEqual([...EFFECT_LEVEL_PLACEMENTS])
  })

  it('is the order every shipped look declares its options in', () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const knob of look.knobs) {
        if (knob.kind !== 'choice') continue
        if (knob.key === 'kernel') {
          expect([...knob.options], look.id).toEqual([...SHADER_KERNEL_ORDER])
        }
        if (knob.key === 'levelPlacement') {
          expect([...knob.options], look.id).toEqual([
            ...SHADER_PLACEMENT_ORDER,
          ])
        }
      }
    }
  })
})

describe('the source each shader is assembled from', () => {
  it('gives every shader the shared preamble and a body of its own', () => {
    const seen = new Set<string>()
    for (const shader of EFFECT_SHADERS) {
      const source = fragmentSourceFor(shader)
      expect(source.startsWith('#version 300 es'), shader).toBe(true)
      expect(source, shader).toContain('void main()')
      // The encode on the way out. The drawing buffer is sRGB-encoded, so a
      // shader that forgot this writes linear values into it and the whole look
      // comes out washed out.
      expect(source, shader).toContain('encode(')
      expect(seen.has(source), shader).toBe(false)
      seen.add(source)
    }
  })

  it('binds every knob a look declares to a uniform of that name', () => {
    // The payoff of declaring a knob once: `u_<key>` and nothing in between. A
    // knob with no uniform is a control the picture does not answer to. The one
    // documented exception is checked rather than skipped, so the hole cannot
    // quietly grow a second entry.
    for (const look of BUILT_IN_LOOKS) {
      const source = fragmentSourceFor(look.shader)
      for (const knob of look.knobs) {
        if (KNOBS_BOUND_VIA_INKS.includes(knob.key)) continue
        expect(source, `${look.id}.${knob.key}`).toContain(`u_${knob.key}`)
      }
    }
  })

  it('routes the one exception through the ink list instead', () => {
    expect(KNOBS_BOUND_VIA_INKS).toEqual(['entries'])
    expect(fragmentSourceFor('paletteReduced')).toContain('uInkCount')
    expect(fragmentSourceFor('paletteReduced')).not.toContain('u_entries')
  })
})

describe('the transfer function, in the three places it exists', () => {
  /**
   * The strongest thing CI can say about GPU/CPU colour agreement.
   *
   * The real assertion #36 asks for is a golden image — the same picture through
   * the shader and through Rust, diffed — and that cannot run here: there is no
   * GPU on the runner, and mocking one would prove the mock works. What *can* be
   * checked is that the three implementations are the same function: the GLSL
   * `encode`, `src-tauri/src/effects/color.rs`, and `inks.ts`. If one of them
   * were quietly rewritten as `pow(x, 1/2.2)`, a duotone would visibly shift the
   * moment somebody switched from an ordered kernel to a diffusion one, and
   * nothing else in this suite would notice.
   *
   * The constants are IEC 61966-2-1's own. `inks.test.ts` pins the TypeScript
   * side to the same numbers and `color.rs` pins the Rust side exhaustively.
   */
  const IEC = ['0.0031308', '1.055', '1.0 / 2.4', '0.055', '12.92']

  it('is the exact sRGB transfer in every shader, not a gamma approximation', () => {
    for (const shader of EFFECT_SHADERS) {
      const source = fragmentSourceFor(shader)
      for (const constant of IEC) {
        expect(source, `${shader} is missing ${constant}`).toContain(constant)
      }
      // The approximation the spike explicitly refused, because it would be a
      // second uncontrolled variable next to the parity being asserted.
      expect(source, shader).not.toContain('2.2')
    }
  })

  it('weights luminance by sRGB’s own primaries', () => {
    // Applied to linear light and never to encoded bytes — the classic mistake
    // both other implementations also have a test against.
    for (const shader of EFFECT_SHADERS) {
      expect(fragmentSourceFor(shader)).toContain(
        'vec3(0.212639, 0.715169, 0.072192)'
      )
    }
  })
})

describe('the blue-noise mask', () => {
  it('is the tile the generator says it is', () => {
    expect(BLUE_NOISE_MASK).toHaveLength(BLUE_NOISE_SIZE * BLUE_NOISE_SIZE)
  })

  it('spends its thresholds evenly across the range', () => {
    // A mask is a *ranking* of every cell, so each threshold byte should be
    // about equally common. A lumpy histogram is a mask that quantises some
    // tones far more coarsely than others.
    const histogram = new Array<number>(256).fill(0)
    for (const value of BLUE_NOISE_MASK) {
      histogram[value] = (histogram[value] ?? 0) + 1
    }

    const expected = BLUE_NOISE_MASK.length / 256
    expect(Math.min(...histogram)).toBeGreaterThanOrEqual(expected * 0.5)
    expect(Math.max(...histogram)).toBeLessThanOrEqual(expected * 2)
  })

  it('is blue rather than white — no clumps and no voids at the midpoint', () => {
    // The property the whole void-and-cluster generator exists for, and the one
    // that separates it from `Math.random()`: at any threshold the set cells
    // are spread, so a 2×2 block is almost never entirely on or entirely off.
    // Asserted against a shuffle of the same bytes rather than against zero —
    // the mask is a real ranking rather than a lattice, so a handful of uniform
    // blocks is expected and an order of magnitude more is the failure.
    const blue = uniformBlocksAt(BLUE_NOISE_MASK, 128)
    const white = uniformBlocksAt(shuffledCopy(BLUE_NOISE_MASK), 128)

    expect(blue).toBeLessThan(BLUE_NOISE_MASK.length / 100)
    expect(white).toBeGreaterThan(blue * 10)
  })
})

/** How many 2×2 blocks are entirely above or entirely below the threshold. */
function uniformBlocksAt(mask: Uint8Array, threshold: number): number {
  const size = BLUE_NOISE_SIZE
  let uniform = 0

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cells = [
        mask[y * size + x],
        mask[y * size + ((x + 1) % size)],
        mask[((y + 1) % size) * size + x],
        mask[((y + 1) % size) * size + ((x + 1) % size)],
      ].map(value => (value as number) < threshold)

      if (cells.every(Boolean) || cells.every(cell => !cell)) uniform += 1
    }
  }

  return uniform
}

/** The same values, in an arbitrary order — a white-noise control. */
function shuffledCopy(mask: Uint8Array): Uint8Array {
  const out = Uint8Array.from(mask)
  // A fixed generator rather than `Math.random`, so a failure here is
  // reproducible instead of an occasional red build.
  let state = 0x9e3779b9
  for (let at = out.length - 1; at > 0; at--) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swap = state % (at + 1)
    const held = out[at] as number
    out[at] = out[swap] as number
    out[swap] = held
  }
  return out
}
