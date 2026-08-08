/**
 * The impure half of a run: ids, seeds and the clock.
 *
 * It lives outside the reducer so the reducer can be tested by hand, and
 * outside the components so nothing rolls a seed during render.
 */

import type { EditorAction, StageKind } from '@/lib/recipe'

export function runStageAction(stage: StageKind, count: number): EditorAction {
  return {
    type: 'runStage',
    stage,
    runs: Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      seed: Math.floor(Math.random() * 1_000_000_000),
    })),
    at: Date.now(),
  }
}

/** A seed to pin when there is no generation to take one from. */
export function rollSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}
