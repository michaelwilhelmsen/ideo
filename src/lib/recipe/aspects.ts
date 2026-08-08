/**
 * The curated aspect ratios (PRD §4.4), and what is known about animating each.
 *
 * Locked at project creation and inherited by every stage. The list is curated
 * rather than free-form because video models are far pickier about dimensions
 * than image models, and a ratio the video model refuses would fail at the last
 * and most expensive step.
 *
 * `animatable` is a claim about *confirmed* support, not about what might work.
 * PRD §9.1 read the live schemas: Luma Ray 2 has an explicit enum containing
 * 21:9 and 16:9, and 1:1 is confirmed on Wan FLF2V. 2:1 and 3:2 appear in no
 * video model's enum — they are reachable only through Kling O1's inherited
 * 0.40–2.50 range, which carries no seed parameter and so cannot be re-run.
 * Marking those two as animatable would be assuming the expensive thing.
 */

import type { AspectId } from './types'

export interface Aspect {
  readonly id: AspectId
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
    ratio: 16 / 9,
    animatable: true,
    noteKey: 'editor.aspect.note.standardWide',
  },
  {
    id: '21:9',
    ratio: 21 / 9,
    animatable: true,
    noteKey: 'editor.aspect.note.ultrawide',
  },
  {
    id: '2:1',
    ratio: 2,
    animatable: false,
    noteKey: 'editor.aspect.note.noVideoEnum',
  },
  {
    id: '3:2',
    ratio: 3 / 2,
    animatable: false,
    noteKey: 'editor.aspect.note.noVideoEnum',
  },
  {
    id: '1:1',
    ratio: 1,
    animatable: true,
    noteKey: 'editor.aspect.note.square',
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
