/**
 * Turning records into words.
 *
 * Generations store an ordinal and presets store their own name, so the
 * English lives here rather than in the data (PRD §10.4). Split out of
 * `shared.tsx` because that file is components only.
 */

import { useTranslation } from 'react-i18next'
import { presetById, type Generation, type StageKind } from '@/lib/recipe'

export function stageNameKey(stage: StageKind): string {
  return `editor.stage.${stage}`
}

/** "Style 3" — the record holds an ordinal, the language lives here. */
export function useGenerationName(): (generation: Generation) => string {
  const { t } = useTranslation()
  return generation =>
    `${t(stageNameKey(generation.stage))} ${generation.ordinal}`
}

/** Presets are user data (PRD §6, fork-to-customize), so no `t()` here. */
export function presetName(presetId: string | null): string {
  return presetById(presetId)?.name ?? '—'
}
