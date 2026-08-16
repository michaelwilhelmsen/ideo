/**
 * What lets a card be as tall as its own picture without dragging its row with
 * it (#55).
 *
 * CSS has no masonry anyone can ship yet — `grid-template-rows: masonry` is
 * still a proposal, and multi-column would lay the library out top-to-bottom
 * per column, which reorders a list whose whole point is that the newest work
 * is first. So the grid keeps its columns and its reading order, and gets rows
 * one pixel tall: a card claims as many of them as it is high, and the
 * auto-placement algorithm drops the next card into the first gap that fits.
 *
 * The height is measured rather than derived. It could be computed — the
 * project's ratio is known, and the caption underneath is two lines — but "two
 * lines" is a claim about English at one font size, and the caption wraps
 * differently in every other language (PRD §10.4). Measuring is right in all of
 * them.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/** The row unit the grid is built from, in pixels. */
const ROW_PX = 1

/**
 * A tuple rather than an object, because a hook may hand a ref back but a
 * component may not read one off a property during render (`react-hooks/refs`).
 */
export function useMasonrySpan(
  gapPx: number
): readonly [React.RefObject<HTMLDivElement | null>, CSSProperties] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)

  // Layout, not effect: the first measurement has to land before the browser
  // paints, or the first frame is every card overlapping every other one at a
  // pixel tall. A synchronous read here re-renders with the real spans in the
  // same frame; the observer after it is for everything later — a window
  // resize narrowing the columns, a thumbnail arriving, a language change.
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return

    const measure = () => setHeight(node.getBoundingClientRect().height)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [
    ref,
    {
      // Rounded up rather than down, so the rounding error is a hairline of
      // extra space and never a card clipped by the one below it.
      gridRowEnd:
        height === null
          ? undefined
          : `span ${Math.max(1, Math.ceil((height + gapPx) / ROW_PX))}`,
    },
  ] as const
}

/** The row track and gutter the spans above are counted in. */
export const MASONRY_GAP_PX = 24

export const masonryGridStyle: CSSProperties = {
  gridAutoRows: `${ROW_PX}px`,
  // The gap between rows is part of what each card spans, so the grid itself
  // must not add one on top of it.
  rowGap: 0,
}
