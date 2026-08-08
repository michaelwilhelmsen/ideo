/**
 * The impure half of a run: ids, seeds, the clock — and, for the source stage,
 * the model call itself.
 *
 * The reducer stays pure by taking finished facts: a run is dispatched with
 * the id, the seed and the file that already exist. For a fixture stage those
 * are rolled here; for the source stage they come back from fal, which means
 * the recorded seed is the one that was *used* rather than the one we hoped
 * for (PRD §4.3).
 */

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { EditorAction, Project, StageKind } from '@/lib/recipe'
import { useGenerateImage } from '@/services/generate'
import { useEditorStore } from '@/store/editor-store'
import { generationErrorMessage } from './errors'

export function runStageAction(stage: StageKind, count: number): EditorAction {
  return {
    type: 'runStage',
    stage,
    runs: Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      seed: rollSeed(),
      asset: null,
    })),
    at: Date.now(),
  }
}

/** A seed to pin when there is no generation to take one from. */
export function rollSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}

/**
 * Running a stage, whether or not there is a model behind it yet.
 *
 * Source calls fal and records what came back. Style and animate are still
 * fixtures (#28, #29), so they mint a candidate with no file — which is
 * exactly the `asset: null` case the manifest and the cleanup pass already
 * understand, rather than a special state.
 */
export function useRunStage(
  project: Project,
  stage: StageKind,
  batch: number
): { run: () => void; isRunning: boolean } {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const generate = useGenerateImage()

  if (stage !== 'source') {
    return {
      run: () => dispatch(runStageAction(stage, batch)),
      isRunning: false,
    }
  }

  const draft = project.drafts.source

  return {
    isRunning: generate.isPending,
    run: () => {
      // Minted here because the file is named after it — the manifest entry
      // and the file on disk agree by construction.
      const generationId = crypto.randomUUID()

      generate.mutate(
        {
          projectId: project.id,
          generationId,
          prompt: draft.prompt,
          aspect: project.aspect,
          pinnedSeed: draft.seed.mode === 'pinned' ? draft.seed.value : null,
        },
        {
          onSuccess: generation => {
            dispatch({
              type: 'runStage',
              stage: 'source',
              runs: [
                {
                  id: generationId,
                  // A u64 crosses the boundary as a string; a model that
                  // returned no seed at all leaves the roll standing, and the
                  // registry decides whether that is recorded.
                  seed:
                    generation.seed === null
                      ? rollSeed()
                      : Number(generation.seed),
                  asset: generation.asset,
                },
              ],
              at: Date.now(),
            })
          },
          onError: error => {
            // A failure mints nothing: an empty candidate that never had a
            // file would look like an orphan to the cleanup pass and like a
            // result to everyone else.
            toast.error(generationErrorMessage(t, error))
          },
        }
      )
    },
  }
}
