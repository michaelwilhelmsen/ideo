/**
 * Turning records into words.
 *
 * Generations store an ordinal and presets store their own name, so the
 * English lives here rather than in the data (PRD §10.4). Split out of
 * `shared.tsx` because that file is components only.
 */

import { useTranslation } from 'react-i18next'
import {
  nodeById,
  nodeIdOf,
  presetById,
  type Generation,
  type StageKind,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'

export function stageNameKey(stage: StageKind): string {
  return `editor.stage.${stage}`
}

/**
 * "Style 3", or "Grain pass 3" once the node has been named.
 *
 * The record holds an ordinal and the language lives here (PRD §10.4). What
 * ADR 0005 changed is the first half: a candidate is named after the **node**
 * that made it, so two style steps produce "Style 3" and "Grain pass 3" rather
 * than two things called Style 3. The node's own title wins where the user has
 * given it one, since that is the whole reason to name a step.
 *
 * Falls back to the kind for a candidate whose node is gone, which the canvas
 * should never show — but a name is the wrong place to discover that.
 */
export function useGenerationName(): (generation: Generation) => string {
  const { t } = useTranslation()
  const project = useEditorStore(store => store.state.project)

  return generation => {
    const node = nodeById(project, nodeIdOf(generation))
    const label = node?.title ?? t(stageNameKey(node?.kind ?? generation.stage))
    return `${label} ${generation.ordinal}`
  }
}

/** Presets are user data (PRD §6, fork-to-customize), so no `t()` here. */
export function presetName(presetId: string | null): string {
  return presetById(presetId)?.name ?? '—'
}
