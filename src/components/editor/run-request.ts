/**
 * The impure half of a run: ids, seeds, the clock — and, for the source stage,
 * putting the job on the queue.
 *
 * The reducer stays pure by taking finished facts. For a fixture stage those
 * are rolled here and dispatched immediately. For the source stage they are
 * not facts yet: the job may take a minute, and since #24 it may outlive the
 * session entirely, so running it dispatches nothing. The candidate appears
 * when `services/jobs` collects the finished job — from an event, or from the
 * store on the next launch.
 */

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  freezeRecipe,
  type EditorAction,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { useStageJobs, useSubmitGeneration } from '@/services/jobs'
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
 * Source submits jobs. Style and animate are still fixtures (#28, #29), so
 * they mint a candidate with no file — which is exactly the `asset: null` case
 * the manifest and the cleanup pass already understand, rather than a special
 * state.
 */
export function useRunStage(
  project: Project,
  stage: StageKind,
  batch: number
): { run: () => void; isRunning: boolean } {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const submit = useSubmitGeneration()
  const jobs = useStageJobs(project.id, stage)

  if (stage !== 'source') {
    return {
      run: () => dispatch(runStageAction(stage, batch)),
      isRunning: false,
    }
  }

  return {
    // In flight, not pending: a job submitted before the last quit is running
    // as much as one submitted a second ago, and the button has to say so.
    isRunning: submit.isPending || jobs.length > 0,
    run: () => {
      const recipe = freezeRecipe(project, stage)
      if (recipe === null) return

      // One job per click. `batch` is 1 for the source stage until #26 raises
      // it, and fanning out here before then would be a batch the concurrency
      // cap has never actually had to hold — see PRD §3.3.
      submit.mutate(
        {
          projectId: project.id,
          // Minted here because the file is named after it — the manifest
          // entry and the file on disk agree by construction.
          generationId: crypto.randomUUID(),
          stage,
          recipe,
          prompt: recipe.prompt,
          aspect: project.aspect,
          pinnedSeed: recipe.seed.mode === 'pinned' ? recipe.seed.value : null,
        },
        {
          // A submit that failed bought nothing and mints nothing: an empty
          // candidate would look like an orphan to the cleanup pass and like
          // a result to everyone else.
          onError: error => toast.error(generationErrorMessage(t, error)),
        }
      )
    },
  }
}
