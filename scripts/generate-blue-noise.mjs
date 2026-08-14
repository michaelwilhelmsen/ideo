/**
 * The void-and-cluster generator behind `src/lib/effects/gl/blue-noise.ts`.
 *
 *   node scripts/generate-blue-noise.mjs
 *
 * #36 wants a blue-noise threshold mask as the video-safe substitute for error
 * diffusion — fully parallel, and *temporally stable by construction*, which is
 * exactly what Floyd–Steinberg and Atkinson catastrophically lack. It also asks
 * that we generate it ourselves with the generator committed, rather than
 * lifting one of the published sets: most of those have vague or
 * non-commercial terms, and this texture ends up baked into files users ship
 * commercially.
 *
 * The algorithm is Ulichney's void-and-cluster (1993), in its usual three
 * phases. What it produces is a *ranking* of every cell — the order in which
 * cells would be turned on to fill the tile as evenly as possible at every
 * density — and a ranking is exactly what a threshold matrix is.
 *
 * **Deliberately not a PNG.** #36 says "the generator committed next to the
 * PNG"; what lands beside this is a TypeScript module holding the same bytes in
 * base64. The reason for the change is the reason the ticket gave for
 * generating it at all: it has to be *ours*, and it has to be checkable. A
 * module is testable in CI without a PNG decoder, needs no asset pipeline, and
 * cannot be swapped for a differently-licensed file that happens to have the
 * same name. The licensing argument the ticket actually makes is untouched.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** One tile. 64 is the usual size: large enough that the tiling is invisible. */
const SIZE = 64
const N = SIZE * SIZE

/**
 * The energy filter's width, in cells.
 *
 * Ulichney's own value. It is the only free parameter: too tight and the
 * measure is local enough to leave clumps, too wide and every cell looks the
 * same as every other.
 */
const SIGMA = 1.5

/** How much of the tile the prototype pattern starts filled. */
const INITIAL_DENSITY = 0.1

/** Deterministic, so re-running this produces the byte-identical module. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The filter, precomputed over every wrapped offset.
 *
 * Wrapped because the mask tiles: a cluster that straddles the edge is a
 * cluster, and a filter that stopped at the boundary would leave a visible
 * seam every 64 pixels.
 */
function gaussian() {
  const kernel = new Float64Array(N)
  for (let dy = 0; dy < SIZE; dy++) {
    for (let dx = 0; dx < SIZE; dx++) {
      const wx = Math.min(dx, SIZE - dx)
      const wy = Math.min(dy, SIZE - dy)
      kernel[dy * SIZE + dx] = Math.exp(
        -(wx * wx + wy * wy) / (2 * SIGMA * SIGMA)
      )
    }
  }
  return kernel
}

const KERNEL = gaussian()

/** Add or remove one cell's contribution to the energy field. */
function splat(energy, index, sign) {
  const cy = (index / SIZE) | 0
  const cx = index % SIZE
  for (let y = 0; y < SIZE; y++) {
    const dy = (y - cy + SIZE) % SIZE
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx + SIZE) % SIZE
      energy[y * SIZE + x] += sign * KERNEL[dy * SIZE + dx]
    }
  }
}

/** The set cell sitting in the tightest cluster — the most energetic one. */
function tightestCluster(pattern, energy) {
  let best = -1
  let bestEnergy = -Infinity
  for (let i = 0; i < N; i++) {
    if (pattern[i] === 1 && energy[i] > bestEnergy) {
      bestEnergy = energy[i]
      best = i
    }
  }
  return best
}

/** The clear cell in the largest void — the least energetic one. */
function largestVoid(pattern, energy) {
  let best = -1
  let bestEnergy = Infinity
  for (let i = 0; i < N; i++) {
    if (pattern[i] === 0 && energy[i] < bestEnergy) {
      bestEnergy = energy[i]
      best = i
    }
  }
  return best
}

function main() {
  const random = mulberry32(0x36_53_52)

  // A random start, then relaxed until moving the tightest cluster into the
  // largest void puts it straight back where it came from. That fixed point is
  // Ulichney's "prototype binary pattern", and every phase below starts there.
  const pattern = new Uint8Array(N)
  const energy = new Float64Array(N)
  let ones = 0
  while (ones < Math.round(N * INITIAL_DENSITY)) {
    const at = Math.floor(random() * N)
    if (pattern[at] === 1) continue
    pattern[at] = 1
    splat(energy, at, 1)
    ones++
  }

  for (;;) {
    const cluster = tightestCluster(pattern, energy)
    pattern[cluster] = 0
    splat(energy, cluster, -1)

    const empty = largestVoid(pattern, energy)
    pattern[empty] = 1
    splat(energy, empty, 1)

    if (empty === cluster) break
  }

  const prototype = Uint8Array.from(pattern)
  const rank = new Int32Array(N).fill(-1)

  // Phase 1 — unfill the prototype, tightest cluster first, ranking downward.
  {
    const working = Uint8Array.from(prototype)
    const field = Float64Array.from(energy)
    for (let r = ones - 1; r >= 0; r--) {
      const at = tightestCluster(working, field)
      working[at] = 0
      splat(field, at, -1)
      rank[at] = r
    }
  }

  // Phase 2 — fill the prototype, largest void first, up to half the tile.
  const half = Math.floor(N / 2)
  const filled = Uint8Array.from(prototype)
  const field = Float64Array.from(energy)
  for (let r = ones; r < half; r++) {
    const at = largestVoid(filled, field)
    filled[at] = 1
    splat(field, at, 1)
    rank[at] = r
  }

  // Phase 3 — past halfway the interesting structure is in the *gaps*, so the
  // measure flips: keep filling, but choose the cell that is the tightest
  // cluster of the complement. Ulichney's own third phase, and it is what stops
  // the highlights from clumping the way a naive continuation of phase 2 does.
  {
    const complement = new Uint8Array(N)
    const inverse = new Float64Array(N)
    for (let i = 0; i < N; i++) complement[i] = filled[i] === 1 ? 0 : 1
    for (let i = 0; i < N; i++) {
      if (complement[i] === 1) splat(inverse, i, 1)
    }
    for (let r = half; r < N; r++) {
      const at = tightestCluster(complement, inverse)
      complement[at] = 0
      splat(inverse, at, -1)
      rank[at] = r
    }
  }

  for (let i = 0; i < N; i++) {
    if (rank[i] < 0) throw new Error(`cell ${i} was never ranked`)
  }

  // A rank becomes a threshold byte. 4096 ranks into 256 values is lossy by
  // construction, and harmless: a threshold mask is compared against a tone,
  // and 256 steps is already finer than the 8-bit output it is deciding.
  const bytes = Buffer.alloc(N)
  for (let i = 0; i < N; i++) {
    bytes[i] = Math.round((rank[i] * 255) / (N - 1))
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const out = join(here, '..', 'src', 'lib', 'effects', 'gl', 'blue-noise.ts')

  const base64 = bytes.toString('base64').replace(/(.{76})/g, '$1\n')

  writeFileSync(
    out,
    `/**
 * A ${SIZE}×${SIZE} blue-noise threshold mask — **generated**, do not edit.
 *
 * Produced by \`scripts/generate-blue-noise.mjs\` (void and cluster, sigma
 * ${SIGMA}, deterministic seed). Re-run that script to reproduce this file byte
 * for byte; the seed is fixed precisely so that a regenerated mask is either
 * identical or a deliberate change.
 *
 * Why this exists at all: #36's video-safe substitute for error diffusion. A
 * precomputed mask is fully parallel and *temporally stable by construction*,
 * which is what the crawling error-diffusion pattern lacks, and it looks far
 * closer to error diffusion than Bayer does — organic, non-directional, no
 * visible grid. Ours rather than one of the published sets, because most of
 * those carry vague or non-commercial terms and this texture ends up baked into
 * files users ship commercially.
 */

const PACKED = \`
${base64}
\`

/** The mask, row-major, one threshold byte per cell. */
export const BLUE_NOISE_SIZE = ${SIZE}

export const BLUE_NOISE_MASK: Uint8Array = decode(PACKED)

function decode(packed: string): Uint8Array {
  const binary = atob(packed.replace(/\\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
`
  )

  console.log(`wrote ${out} (${N} cells)`)
}

main()
