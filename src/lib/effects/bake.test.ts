/**
 * The frame loop a bake runs.
 *
 * Two of #36's promises live entirely here, and both are the sort of thing that
 * is claimed in a comment and never checked: **progress is determinate**, and
 * **cancel actually cancels**. The loop is pure — a driver in, side effects out
 * — precisely so those can be asserted without a canvas, a GPU or an encoder.
 */

import { describe, expect, it, vi } from 'vitest'
import { bakeFrames, BakeCancelled, loadImage, type BakeProgress } from './bake'

const SIZE = { width: 1920, height: 1080 }

/** A driver that records what happened, with a cancel you can arm. */
function driver(options: { cancelAfter?: number } = {}) {
  const treated: number[] = []
  const stored: number[] = []
  const reports: BakeProgress[] = []

  return {
    treated,
    stored,
    reports,
    treat: vi.fn(async (job: { index: number }) => {
      treated.push(job.index)
      return new Uint8Array([job.index])
    }),
    store: vi.fn(async (index: number) => {
      stored.push(index)
    }),
    report: (progress: BakeProgress) => reports.push(progress),
    cancelled: () =>
      options.cancelAfter !== undefined &&
      treated.length >= options.cancelAfter,
  }
}

describe('baking a sequence', () => {
  it('treats every frame, in order', () => {
    // Out of order is a clip whose frames play in the wrong sequence, which
    // looks like a decode bug rather than a loop bug.
    const it = driver()

    return bakeFrames(['a', 'b', 'c'], SIZE, it).then(() => {
      expect(it.treated).toEqual([0, 1, 2])
      expect(it.stored).toEqual([0, 1, 2])
    })
  })

  it('renders at the export resolution rather than at the frame’s', async () => {
    // The cell size dialled in has to be the cell size shipped; a pattern
    // rendered small and scaled up is a different pattern.
    const it = driver()
    await bakeFrames(['a'], SIZE, it)

    expect(it.treat).toHaveBeenCalledWith({
      source: 'a',
      index: 0,
      width: 1920,
      height: 1080,
    })
  })

  it('reports a determinate total before the first frame', async () => {
    // The count is known up front, which is what makes a percentage honest
    // here and dishonest for a model call.
    const it = driver()
    await bakeFrames(['a', 'b', 'c'], SIZE, it)

    expect(it.reports[0]).toEqual({ done: 0, total: 3 })
    expect(it.reports).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })

  it('stops on cancel rather than finishing the sequence', async () => {
    // The failure this prevents is a cancel button that stops the *bar* and
    // leaves a hundred frames still rendering behind it.
    const it = driver({ cancelAfter: 2 })

    await expect(
      bakeFrames(['a', 'b', 'c', 'd', 'e'], SIZE, it)
    ).rejects.toBeInstanceOf(BakeCancelled)

    expect(it.treated).toEqual([0, 1])
    expect(it.stored).toEqual([0, 1])
  })

  it('checks for a cancel before each frame, not after', async () => {
    // Checked after, a cancel arriving during frame 40 of 120 would still cost
    // frame 41 — a full-resolution render nobody is waiting for.
    const it = driver({ cancelAfter: 1 })

    await expect(bakeFrames(['a', 'b'], SIZE, it)).rejects.toBeInstanceOf(
      BakeCancelled
    )
    expect(it.treated).toEqual([0])
  })

  it('cancels before doing any work at all when asked early', async () => {
    const it = driver({ cancelAfter: 0 })

    await expect(bakeFrames(['a'], SIZE, it)).rejects.toBeInstanceOf(
      BakeCancelled
    )
    expect(it.treated).toEqual([])
    // The total is still reported, so a bar that appeared says what it was for.
    expect(it.reports).toEqual([{ done: 0, total: 1 }])
  })

  it('lets a failure out rather than encoding a half-treated sequence', async () => {
    // A frame that could not be rendered must not become a clip that is fine
    // for forty frames and then is not.
    const it = driver()
    it.treat.mockRejectedValueOnce(new Error('the context was lost'))

    await expect(bakeFrames(['a', 'b'], SIZE, it)).rejects.toThrow(
      'the context was lost'
    )
    expect(it.stored).toEqual([])
  })

  it('handles a still, which is a sequence of one', async () => {
    const it = driver()
    await bakeFrames(['only'], SIZE, it)

    expect(it.stored).toEqual([0])
    expect(it.reports.at(-1)).toEqual({ done: 1, total: 1 })
  })
})

describe('loading a frame to treat', () => {
  it('asks for CORS before the load starts', async () => {
    // The frames come from the asset protocol, which is a different origin
    // from the page. Without this the image is tainted, and WebGL throws
    // `SecurityError` from `texImage2D` rather than drawing anything — every
    // frame of every bake, on upload. Order matters as much as the value:
    // setting it after `src` leaves the load already running under no-cors.
    const order: string[] = []

    class Recording {
      #crossOrigin: string | null = null
      #src = ''

      set crossOrigin(value: string | null) {
        order.push(`crossOrigin=${value}`)
        this.#crossOrigin = value
      }
      get crossOrigin(): string | null {
        return this.#crossOrigin
      }

      set src(value: string) {
        order.push(`src=${value}`)
        this.#src = value
      }
      get src(): string {
        return this.#src
      }

      decode(): Promise<void> {
        return Promise.resolve()
      }
    }

    vi.stubGlobal('Image', Recording)

    try {
      await loadImage('asset://localhost/frame.png')

      expect(order).toEqual([
        'crossOrigin=anonymous',
        'src=asset://localhost/frame.png',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
