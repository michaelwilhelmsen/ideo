/**
 * How tall a preview is allowed to get, and the one place that decides it.
 *
 * Every preview in the editor is sized from its *width* — a box at the
 * project's ratio filling its column, a canvas fitted to the frame it sits in.
 * That is the right rule for a landscape project and silently the wrong one for
 * a portrait project, where width is the short edge: at 9:16 the middle pane
 * hands the box ~700px of width and takes 1244px of height for it, which is a
 * hero nobody can see without scrolling past it.
 *
 * So the height needs a bound, and the bound has to be the same number in both
 * places or the effects tab and the stage editor disagree about how big a
 * picture is. It is expressed against the *viewport* rather than the container
 * because no container here has a height of its own to be a fraction of — they
 * all grow to fit what is in them, which is exactly the problem.
 */

import type { CSSProperties } from 'react'
import { ASPECTS, type AspectId } from '@/lib/recipe'

/**
 * The share of the window a preview may fill vertically.
 *
 * 0.7 leaves room for the pane's own chrome — the stage tabs above, the name
 * and badges below — so a capped preview still reads as one thing among
 * several rather than as the whole screen.
 */
export const PREVIEW_VIEWPORT_FRACTION = 0.7

/**
 * The bound in CSS pixels, for the paths that size a canvas in JavaScript.
 *
 * Read at call time rather than held: the effects preview already re-measures
 * on resize, so it picks up a new window height on the same pass.
 */
export function maxPreviewHeight(): number {
  return window.innerHeight * PREVIEW_VIEWPORT_FRACTION
}

/**
 * The same bound for a box whose height comes from an `aspect-*` class, as a
 * cap on its width.
 *
 * Width rather than height, because these boxes hold the project's locked ratio
 * and `max-height` on an `aspect-ratio` box does not shrink the width to match
 * — it crops, which is the one thing a ratio-locked preview must not do. The
 * fraction is `Aspect`'s own integers rather than a decimal, so the cap cannot
 * drift from the shape it is capping.
 *
 * `undefined` for every landscape and square ratio: their height already
 * follows from a width the column bounds, so a cap would be a second, quieter
 * rule doing nothing.
 */
export function portraitWidthCap(aspect: AspectId): CSSProperties | undefined {
  const entry = ASPECTS.find(candidate => candidate.id === aspect)
  if (entry === undefined || entry.ratio >= 1) return undefined

  const vh = PREVIEW_VIEWPORT_FRACTION * 100

  return {
    maxWidth: `calc(${String(vh)}vh * ${String(entry.width)} / ${String(entry.height)})`,
    marginInline: 'auto',
  }
}
