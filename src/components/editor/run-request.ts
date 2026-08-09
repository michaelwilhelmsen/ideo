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

import { useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { ensureFalApiKey } from '@/services/fal-api-key'
import { useUIStore } from '@/store/ui-store'
import {
  buildRequest,
  freezeRecipe,
  modelById,
  MODEL_REGISTRY,
  type EditorAction,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { useSubmitGeneration } from '@/services/jobs'
import type { GenerationError } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { generationErrorMessage } from './errors'

/**
 * The ids one click needs: one for the run, one per candidate (#26).
 *
 * Minted in one place because both paths need exactly this and they must not
 * drift — a fixture stage that grouped its candidates differently from a paid
 * one would make the strip's grouping mean two things.
 */
export interface PlannedBatch {
  readonly runId: string
  readonly generationIds: readonly string[]
}

/** A candidate fal.ai never took, and why. */
interface RefusedSubmit {
  readonly generationId: string
  readonly error: GenerationError
}

/**
 * One run's id. The only place one is ever made — including for a batch a
 * previous launch left running, which the sweep adopts into a run of its own.
 */
export function mintRunId(): string {
  return crypto.randomUUID()
}

export function planBatch(count: number): PlannedBatch {
  return {
    runId: mintRunId(),
    // Minted before the submit because the file is named after it — the
    // manifest entry and the file on disk agree by construction.
    generationIds: Array.from({ length: count }, () => crypto.randomUUID()),
  }
}

export function runStageAction(stage: StageKind, count: number): EditorAction {
  const batch = planBatch(count)

  return {
    type: 'runStage',
    stage,
    runs: batch.generationIds.map(id => ({
      id,
      seed: rollSeed(),
      asset: null,
      runId: batch.runId,
    })),
    at: Date.now(),
  }
}

/** A seed to pin when there is no generation to take one from. */
export function rollSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}

/**
 * The gate the PRD puts on the *first generate* rather than on the app (§7).
 *
 * Browsing is free and requires nothing; spending money is what requires a
 * key. Blocking here means the refusal arrives before the submit rather than
 * as a failure partway through a job, and it arrives with the way out
 * attached — the toast opens the key pane, so nobody has to go hunting through
 * Settings for a field they have never seen.
 */
export async function requireFalApiKey(
  queryClient: QueryClient
): Promise<boolean> {
  if (await ensureFalApiKey(queryClient)) return true

  toast.error(i18n.t('generate.error.noApiKey'), {
    action: {
      label: i18n.t('generate.addKey'),
      onClick: () => useUIStore.getState().openPreferencesPane('apiKey'),
    },
  })

  return false
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
  const queryClient = useQueryClient()

  // Tracked here rather than read off the mutation, because a batch is several
  // mutations on one observer and the observer only remembers the last.
  const [submitting, setSubmitting] = useState(false)

  if (stage !== 'source') {
    return {
      run: () => dispatch(runStageAction(stage, batch)),
      isRunning: false,
    }
  }

  return {
    // Only while the submits themselves are on the wire. Jobs already in
    // flight do *not* disable the button: three run at once and the rest queue
    // (PRD §3.3), so refusing a second click would be this app enforcing a
    // limit fal.ai and the semaphore already handle — and would stop someone
    // from queueing the next idea while the current one renders.
    isRunning: submitting,
    run: () => void submitWhenKeyed(),
  }

  async function submitWhenKeyed() {
    // Frozen once for the whole batch: every candidate of one run has to
    // describe itself identically, or the four-up would be four recipes.
    const recipe = freezeRecipe(project, stage)
    if (recipe === null) return

    // Before anything else: a job submitted without a key fails at fal.ai
    // after the request is on the wire, which reads as a broken app rather
    // than as a missing setting.
    if (!(await requireFalApiKey(queryClient))) return

    // The registry decides what goes on the wire (#25): the endpoint, the
    // aspect idiom, our defaults rather than fal's, and a seed only where
    // there is a field for one. `modelById` throws on an id with no entry, so
    // an unknown model fails here rather than as a 422 after the charge
    // (PRD §5 — no arbitrary model ids).
    const built = buildRequest(
      modelById(MODEL_REGISTRY, recipe.modelId),
      project.aspect,
      recipe
    )

    // One job per candidate (#26, PRD §4.2). Rust still takes one call at a
    // time and the semaphore paces them, so this is a queue of `batch` jobs
    // rather than a batch request — three run, the rest wait (PRD §3.3).
    const planned = planBatch(batch)

    // Written down before the submits, because a job can settle before the
    // last `mutateAsync` has even resolved.
    dispatch({
      type: 'beginRun',
      runId: planned.runId,
      projectId: project.id,
      stage,
      generationIds: planned.generationIds,
      at: Date.now(),
    })

    setSubmitting(true)

    // `mutateAsync` per candidate rather than `mutate` with callbacks: one
    // mutation observer keeps only the most recent call's handlers, so three
    // refusals behind one success would have gone out silently.
    const settled = await Promise.allSettled(
      planned.generationIds.map(async generationId => {
        try {
          return await submit.mutateAsync({
            projectId: project.id,
            generationId,
            stage,
            recipe,
            prompt: recipe.prompt,
            modelId: built.modelId,
            params: built.params,
          })
        } catch (error: unknown) {
          // `useSubmitGeneration` rejects with the reason Rust named, so the
          // refusal can be said in the user's own language (PRD §10.4).
          const refusal: RefusedSubmit = {
            generationId,
            error: error as GenerationError,
          }
          throw refusal
        }
      })
    )

    setSubmitting(false)

    const refused = settled.flatMap(result =>
      result.status === 'rejected' ? [result.reason as RefusedSubmit] : []
    )

    const first = refused.at(0)
    if (first === undefined) return

    // A submit that failed bought nothing and mints nothing, so the run stops
    // waiting for it: a candidate that will never arrive would otherwise hold
    // a place in the grid for the rest of the session.
    dispatch({
      type: 'abandonGenerations',
      generationIds: refused.map(failure => failure.generationId),
    })

    // One click, one refusal — but it has to say how much of the batch went
    // down, because "three of four could not be submitted" and "none of them
    // could" are different things to have just been charged for.
    const reason = generationErrorMessage(t, first.error)
    toast.error(
      refused.length === planned.generationIds.length
        ? reason
        : t('generate.error.someCandidates', {
            failed: refused.length,
            total: planned.generationIds.length,
            reason,
          })
    )
  }
}
