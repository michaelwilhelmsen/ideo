/**
 * The curated aspect ratios (PRD §4.4), and what is known about animating each.
 *
 * Locked at project creation and inherited by every stage. The list is curated
 * rather than free-form because video models are far pickier about dimensions
 * than image models, and a ratio the video model refuses would fail at the last
 * and most expensive step.
 *
 * `animatable` is a claim about *confirmed* support, and the evidence is one
 * thing only: a ratio named in the `aspects` enum of a row in `MODEL_REGISTRY`
 * at the animate stage. `models.test.ts` holds every entry here to that, which
 * is why the claim can be trusted rather than merely read.
 *
 * 3:2 is the only entry that fails it: no video model names it, and it is
 * reachable only through the rows that inherit their geometry from the still
 * (Kling, Seedance), which accept any shape precisely because they are never
 * told one. Reading that as support is the assumption this flag exists to
 * refuse — it is an absence of a constraint, not a confirmation.
 *
 * 2:1 used to sit beside it and no longer does. FLUX 3 declares 2:1 and landed
 * after this list was written; nothing re-examined the flag when it did, so the
 * mark was stale rather than wrong, and the note under it went on saying no
 * video model confirmed the ratio while the registry beside it said otherwise.
 * It is the one animatable ratio whose only declaring row requires an end frame,
 * which means a 2:1 animate is always a loop — since #30 that is what an animate
 * run does by default anyway, and the switch shows itself on and unclickable
 * rather than pretending to be a choice.
 *
 * What the flag does *not* promise is reproducibility. Veo 3.1 is the only
 * animate row with a seed, and it serves 16:9 and 9:16 — so at every other
 * ratio the animate stage is a re-roll, and PRD §10.1 disables the seed control
 * with a reason rather than hiding it. That is a property of the field, not of
 * this list.
 *
 * The two portrait entries are here because a hero is not always a desktop
 * banner — a vertical social post and a full-bleed mobile section are both
 * taller than they are wide, and a landscape-only list makes those unbuildable
 * rather than merely awkward. Note the asymmetry with the landscape half: the
 * ratios video models are shy about are the *wide* ones, so 9:16 arrives better
 * supported than most of what was already offered, and is only the second ratio
 * whose animate stage can be re-run at all.
 */

import type { AspectId } from './types'

export interface Aspect {
  readonly id: AspectId
  /**
   * The ratio in lowest terms. Integers rather than a float because the
   * free-dimension models of PRD §9 are given explicit `{width, height}`, and
   * "the largest legal multiple of 7:3" is arithmetic a float cannot do
   * exactly — 21:9 reduces to 7:3, and 2352×1008 is 336 × (7:3).
   */
  readonly width: number
  readonly height: number
  /** Width divided by height — what a preview box sizes itself from. */
  readonly ratio: number
  /** Whether a video model is confirmed to accept this ratio (PRD §9.1). */
  readonly animatable: boolean
  /** i18n key, never English — the record holds no prose (PRD §10.4). */
  readonly noteKey: string
}

export const ASPECTS: readonly Aspect[] = [
  {
    id: '16:9',
    width: 16,
    height: 9,
    ratio: 16 / 9,
    animatable: true,
    noteKey: 'editor.aspect.note.standardWide',
  },
  {
    id: '21:9',
    width: 7,
    height: 3,
    ratio: 21 / 9,
    animatable: true,
    noteKey: 'editor.aspect.note.ultrawide',
  },
  {
    id: '2:1',
    width: 2,
    height: 1,
    ratio: 2,
    animatable: true,
    noteKey: 'editor.aspect.note.wide',
  },
  {
    id: '3:2',
    width: 3,
    height: 2,
    ratio: 3 / 2,
    animatable: false,
    noteKey: 'editor.aspect.note.noVideoEnum',
  },
  {
    id: '1:1',
    width: 1,
    height: 1,
    ratio: 1,
    animatable: true,
    noteKey: 'editor.aspect.note.square',
  },
  {
    id: '3:4',
    width: 3,
    height: 4,
    ratio: 3 / 4,
    animatable: true,
    noteKey: 'editor.aspect.note.portrait',
  },
  {
    id: '9:16',
    width: 9,
    height: 16,
    ratio: 9 / 16,
    animatable: true,
    noteKey: 'editor.aspect.note.tallPortrait',
  },
]

/** The ratio a new project gets unless the user picks otherwise. */
export const DEFAULT_ASPECT: AspectId = '16:9'

export function aspectById(id: AspectId): Aspect {
  const found = ASPECTS.find(aspect => aspect.id === id)
  if (found === undefined) throw new Error(`No aspect entry for "${id}"`)
  return found
}

/**
 * Whether a string off disk names a ratio we still offer.
 *
 * Manifests are the source of truth (PRD §3.2) and therefore untrusted input:
 * a hand-edited or older manifest can name anything.
 */
export function isAspectId(value: unknown): value is AspectId {
  return ASPECTS.some(aspect => aspect.id === value)
}

/**
 * How far an uploaded image's ratio may sit from the project's before it counts
 * as a different shape (#27).
 *
 * Relative, not absolute, so the same slack applies at 1:1 and at 21:9. 2% is
 * chosen against the *gaps in this list*: the closest two curated ratios are
 * 16:9 (1.778) and 2:1 (2.0), 11% apart, so no tolerance below that can ever
 * confuse one for another. What it does buy is the crop that is off by a few
 * pixels — a 1920×1081 export is plainly a 16:9 image and refusing it would be
 * pedantry, not a check.
 */
export const ASPECT_TOLERANCE = 0.02

/**
 * Whether an image of these pixel dimensions is the shape the project locked.
 *
 * PRD §4.4 fixes the ratio at creation, so an upload of another shape is not a
 * preference to be overridden later — it is the wrong picture for every stage
 * downstream, and the video model at the end is the pickiest of the lot. Asking
 * here is what makes the conflict "caught early" (#27) rather than at the
 * expensive step.
 */
export function matchesAspect(
  width: number,
  height: number,
  aspect: AspectId
): boolean {
  if (!(width > 0) || !(height > 0)) return false

  const target = aspectById(aspect).ratio
  return Math.abs(width / height - target) / target <= ASPECT_TOLERANCE
}

/**
 * The ratio an image actually is, as a label to put in a refusal — "3:2", or
 * a decimal when it is nothing we have a name for.
 *
 * Only ever shown next to a mismatch, so naming the nearest curated ratio is
 * more useful than exactness: "this is 3:2, the project is 16:9" is a sentence
 * someone can act on.
 */
export function describeRatio(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '—'

  const ratio = width / height
  const named = ASPECTS.find(
    aspect => Math.abs(ratio - aspect.ratio) / aspect.ratio <= ASPECT_TOLERANCE
  )

  return named?.id ?? `${ratio.toFixed(2)}:1`
}
