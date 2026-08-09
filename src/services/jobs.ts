/**
 * Jobs — the work that outlives the click that started it (#24).
 *
 * The user is charged when fal accepts a job, so submitting is not a promise
 * this session will keep: Rust writes the job down before it polls, and this
 * module's job is to notice results, whether they arrive thirty seconds later
 * or two launches from now.
 *
 * Which means nothing here awaits a generation. `useSubmitGeneration` resolves
 * as soon as the job is on the books; results are *collected* from the store,
 * either when a settled event says so or when a project is opened and the
 * store is asked what it has been holding. The event is an optimisation — the
 * sweep is what makes a quit survivable, so the collection path is the same
 * either way.
 *
 * Collection is not limited to the open project. A job that finishes for one
 * project while the user works in another goes into its own manifest off disk,
 * because it has been paid for whether or not anyone is looking at it.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { generationErrorMessage } from '@/components/editor/errors'
import { logger } from '@/lib/logger'
import {
  isStageKind,
  mintRunId,
  readRecipe,
  runIdForGeneration,
  STAGE_ORDER,
  stagesWithoutSelection,
  withCollectedGenerations,
  type CompletedRun,
  type StageKind,
  type StageRecipe,
} from '@/lib/recipe'
import {
  commands,
  type GenerationError,
  type GenerationProgress,
  type ImageInput,
  type Job,
  type JsonValue,
  type JobSettled,
  type SubmittedJob,
} from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { openProjectById, saveProject } from './projects'

/** Both match `src-tauri/src/jobs/runner.rs`. */
const PROGRESS_EVENT = 'generation-progress'
const SETTLED_EVENT = 'generation-settled'

/**
 * How often the job list is re-read while something is in flight.
 *
 * Not how progress is reported — that is an event. This is the backstop for
 * the case events cannot cover: a job that settled while the app was closed,
 * or an emit that arrived before the webview was listening.
 */
const SWEEP_INTERVAL_MS = 5_000

/**
 * When this run of the app started. A job older than this was submitted by a
 * previous one, which is the only way to tell "resumed" from "just clicked" —
 * Rust does not distinguish them, and that is the point.
 */
const SESSION_STARTED_AT = Date.now()

export const jobKeys = {
  all: ['jobs'] as const,
  active: (projectId: string) => [...jobKeys.all, projectId, 'active'] as const,
}

/** What Rust needs to put one generation on the queue. */
export interface GenerationRequest {
  readonly projectId: string
  readonly generationId: string
  readonly stage: StageKind
  /** The draft, frozen — stored with the job and handed back on arrival. */
  readonly recipe: StageRecipe
  readonly prompt: string
  /**
   * The endpoint, and the body the registry built for it (#25).
   *
   * Passed rather than derived in Rust because deriving it needs the capability
   * table — which field carries the ratio, which primitive a duration is in,
   * whether the model has a seed at all — and that table lives in one place.
   */
  readonly modelId: string
  readonly params: Readonly<Record<string, unknown>>
  /**
   * Which generation's image this run consumes, and the field it goes in (#28).
   *
   * An id rather than the pixels: Rust reads the file out of the project folder
   * and inlines it as base64, so a hero-size image never crosses the IPC
   * boundary twice for no reason. `null` on a stage that takes no input image —
   * and a *style* submit with `null` is refused by Rust before any paid call,
   * because a missing source degrades silently to text-to-image on the models
   * whose image field is optional.
   */
  readonly imageInput: ImageInput | null
}

/**
 * Submits a generation and resolves once it is recorded — not once it is done.
 *
 * Rejects with the {@link GenerationError} itself rather than an `Error`, so
 * the component can translate the reason instead of printing a sentence Rust
 * chose.
 */
export function useSubmitGeneration() {
  const queryClient = useQueryClient()

  return useMutation<SubmittedJob, GenerationError, GenerationRequest>({
    mutationFn: async (request: GenerationRequest): Promise<SubmittedJob> => {
      const result = await commands.generateImage({
        projectId: request.projectId,
        generationId: request.generationId,
        stage: request.stage,
        recipe: request.recipe as unknown as JsonValue,
        prompt: request.prompt,
        modelId: request.modelId,
        params: request.params as unknown as JsonValue,
        imageInput: request.imageInput,
      })

      if (result.status === 'error') {
        logger.error('Could not submit the generation', {
          reason: result.error.reason,
          detail: result.error.detail,
        })
        throw result.error
      }

      logger.info('Generation submitted', {
        requestId: result.data.requestId,
        generationId: result.data.generationId,
      })
      return result.data
    },
    onSettled: async (_data, _error, request) => {
      await queryClient.invalidateQueries({
        queryKey: jobKeys.active(request.projectId),
      })
    },
  })
}

/** What this project has in flight, including anything a previous run left. */
export function useActiveJobs(projectId: string | null) {
  return useQuery({
    queryKey: jobKeys.active(projectId ?? ''),
    enabled: projectId !== null,
    queryFn: async (): Promise<readonly Job[]> => {
      const result = await commands.activeJobs(projectId ?? '')
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    // Only while something is running: an idle project asks nothing.
    refetchInterval: query =>
      (query.state.data?.length ?? 0) > 0 ? SWEEP_INTERVAL_MS : false,
  })
}

/**
 * The jobs one stage has in flight.
 *
 * A stage's panel and its Run button both need exactly this, and deriving it
 * twice is how the two end up disagreeing about whether anything is running.
 */
export function useStageJobs(
  projectId: string,
  stage: StageKind
): readonly Job[] {
  const { data: jobs } = useActiveJobs(projectId)
  return (jobs ?? []).filter(job => job.stage === stage)
}

/**
 * Asks fal to stop a job.
 *
 * Says nothing about money on purpose. Cancelling may or may not prevent the
 * charge depending on how far the job got (PRD §3.3), and the one thing worse
 * than being charged is being told you would not be.
 */
export function useCancelJob() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (job: { requestId: string; projectId: string }) => {
      const result = await commands.cancelJob(job.requestId)
      if (result.status === 'error') throw new Error(result.error)
      return job
    },
    onSuccess: async job => {
      toast.info(i18n.t('generate.job.cancelled'))
      await queryClient.invalidateQueries({
        queryKey: jobKeys.active(job.projectId),
      })
    },
    onError: (error: unknown) => {
      logger.error('Could not cancel the job', { error })
      toast.error(i18n.t('generate.job.couldNotCancel'))
    },
  })
}

/**
 * The latest progress tick per job, keyed by request id.
 *
 * A map rather than one value because up to three jobs run at once (PRD §3.3),
 * and a shared "latest" would flicker between them.
 */
export function useJobProgress(): Readonly<Record<string, GenerationProgress>> {
  const [progress, setProgress] = useState<Record<string, GenerationProgress>>(
    {}
  )

  useEffect(() => {
    const unlisten = listen<GenerationProgress>(PROGRESS_EVENT, event => {
      setProgress(current => ({
        ...current,
        [event.payload.requestId]: event.payload,
      }))
    })

    return () => {
      unlisten
        .then(stop => stop())
        .catch(() => {
          // The listener was never attached; nothing to detach.
        })
    }
  }, [])

  return progress
}

/**
 * Keeps the open project and the job store in agreement.
 *
 * Mount it once, next to `useProjectLibrary`. It collects whatever finished
 * while nobody was looking — including during a previous run of the app — and
 * then keeps collecting as jobs settle.
 */
export function useJobResults(): void {
  const projectId = useEditorStore(store => store.state.project?.id ?? null)
  const { data: jobs } = useActiveJobs(projectId)

  useResumedAnnouncement(jobs)
  useAdoptedRuns(projectId, jobs)
  useSweepOnOpen(projectId)
  useSettledJobs()
}

/**
 * Takes work a previous launch left behind into a run of its own (#26).
 *
 * Without this a resumed batch has no run: the store does not carry one, so
 * the candidates would arrive ungrouped and the stage would have nothing to
 * show while they did. Adopting them mints one id for the lot, which is
 * exactly what the click would have done — the user is waiting on a batch
 * either way, and which launch submitted it is not their problem.
 *
 * Two guards keep it from adopting the same work twice. A job already inside a
 * run is left alone, which is what makes this safe to call on every poll; and
 * so is one whose candidate is already in the manifest, because a run that has
 * been collected and answered may since have been forgotten (see
 * `forgetOldRuns`) and re-adopting it would put its grid back on screen.
 */
function adoptRuns(projectId: string, jobs: readonly Job[]): void {
  if (jobs.length === 0) return

  const { state, dispatch } = useEditorStore.getState()
  const project = state.project?.id === projectId ? state.project : null

  const orphaned = jobs.filter(
    job =>
      runIdForGeneration(state, job.generationId) === null &&
      !(project?.generations ?? []).some(
        generation => generation.id === job.generationId
      )
  )
  if (orphaned.length === 0) return

  // Grouped per stage, because a run belongs to a stage.
  for (const stage of STAGE_ORDER) {
    const forStage = orphaned.filter(job => job.stage === stage)
    if (forStage.length === 0) continue

    dispatch({
      type: 'beginRun',
      runId: mintRunId(),
      generationIds: forStage.map(job => job.generationId),
      projectId,
      stage,
      // The click happened in another session; the earliest submit is the
      // closest thing to when this run started.
      at: Math.min(...forStage.map(job => job.submittedAt)),
    })
  }
}

function useAdoptedRuns(
  projectId: string | null,
  jobs: readonly Job[] | undefined
): void {
  useEffect(() => {
    if (projectId === null || jobs === undefined) return
    adoptRuns(projectId, jobs)
  }, [projectId, jobs])
}

/**
 * Says out loud that work survived the quit.
 *
 * Without it, resuming looks like the app spontaneously producing an image
 * several minutes after launch.
 */
function useResumedAnnouncement(jobs: readonly Job[] | undefined): void {
  const announced = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (jobs === undefined) return

    const resumed = jobs.filter(
      job =>
        job.submittedAt < SESSION_STARTED_AT &&
        !announced.current.has(job.requestId)
    )
    if (resumed.length === 0) return

    for (const job of resumed) announced.current.add(job.requestId)
    toast.info(i18n.t('generate.job.resumed', { count: resumed.length }))
  }, [jobs])
}

/**
 * The sweep — what makes a quit survivable rather than merely reported.
 *
 * Opening a project is the moment a result submitted before the last quit
 * becomes collectable, and it is the one trigger that does not depend on an
 * event this session was around to hear.
 */
function useSweepOnOpen(projectId: string | null): void {
  useEffect(() => {
    if (projectId === null) return

    collectFinished(projectId).catch((error: unknown) => {
      logger.warn('Could not collect finished jobs', { projectId, error })
    })
  }, [projectId])
}

/** Reacts to jobs settling while the app is running. */
function useSettledJobs(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const unlisten = listen<JobSettled>(SETTLED_EVENT, event => {
      const settled = event.payload
      logger.info('Job settled', {
        requestId: settled.requestId,
        outcome: settled.outcome,
      })

      queryClient
        .invalidateQueries({ queryKey: jobKeys.active(settled.projectId) })
        .catch(() => {
          // A stale list is corrected by the next sweep.
        })

      // A job that failed or was cancelled produces nothing, ever. Saying so
      // is what stops the run it belonged to from holding a place open for a
      // candidate that is not coming (#26).
      if (settled.outcome === 'failed' || settled.outcome === 'cancelled') {
        useEditorStore.getState().dispatch({
          type: 'abandonGenerations',
          generationIds: [settled.generationId],
        })
      }

      if (settled.outcome === 'failed' && settled.error !== null) {
        toast.error(generationErrorMessage(i18n.t, settled.error))
        return
      }

      // Abandoned is not failed: the job is still on the books and the next
      // launch resumes it, so the run keeps waiting for it.
      if (settled.outcome === 'abandoned') {
        toast.warning(i18n.t('generate.job.abandoned'))
        return
      }

      if (settled.outcome === 'completed') {
        collectFinished(settled.projectId).catch((error: unknown) => {
          logger.warn('Could not collect a finished job', { error })
        })
      }
    })

    return () => {
      unlisten
        .then(stop => stop())
        .catch(() => {
          // The listener was never attached; nothing to detach.
        })
    }
  }, [queryClient])
}

/** Projects currently being collected, so two triggers do not race. */
const collecting = new Set<string>()

/**
 * Moves finished jobs into the manifest, then off the books.
 *
 * The order is the point. A job is only claimed once its candidate is safely
 * on disk, so a crash in between costs a duplicate collection attempt — which
 * the reducer ignores — rather than a paid generation nobody has a record of.
 */
export async function collectFinished(projectId: string): Promise<void> {
  if (collecting.has(projectId)) return
  collecting.add(projectId)

  try {
    const result = await commands.finishedJobs(projectId)
    if (result.status === 'error') throw new Error(result.error)

    const finished = result.data
    if (finished.length === 0) return

    // Before the candidates are read: a batch that finished while the app was
    // closed is a run the user never got to choose from, and adopting it here
    // is what puts it in front of them grouped rather than as loose arrivals.
    if (useEditorStore.getState().state.project?.id === projectId) {
      adoptRuns(projectId, finished)
    }

    const entries = finished
      .map(asCompletedRun)
      .filter((entry): entry is CompletedRun => entry !== null)

    // Nothing readable in the batch: claiming is how those rows stop being
    // retried on every sweep for the rest of time.
    const recorded =
      entries.length === 0 ? true : await record(projectId, entries)

    // Nothing written means nothing to claim yet — the manifest is where a
    // result becomes safe, and until it lands the row is the only copy.
    if (!recorded) return

    for (const job of finished) {
      const claimed = await commands.claimJob(job.requestId)
      if (claimed.status === 'error') {
        logger.warn('Collected a job but could not clear it', {
          requestId: job.requestId,
          error: claimed.error,
        })
      }
    }

    logger.info('Collected finished jobs', {
      projectId,
      count: finished.length,
    })
  } finally {
    collecting.delete(projectId)
  }
}

/**
 * Puts collected candidates in the project's manifest, wherever it is.
 *
 * `true` once the manifest holds them — which is the only thing that makes the
 * job safe to claim.
 */
async function record(
  projectId: string,
  entries: readonly CompletedRun[]
): Promise<boolean> {
  const open = useEditorStore.getState().state.project

  if (open !== null && open.id === projectId) {
    useEditorStore
      .getState()
      .dispatch({ type: 'recordGenerations', entries, at: Date.now() })

    const project = useEditorStore.getState().state.project

    // Closed or swapped underneath us. The rows stay, and opening it again
    // collects them.
    if (project === null || project.id !== projectId) return false

    // Unchanged means the manifest already had every entry — a second
    // collection of the same jobs, and nothing to write.
    if (project !== open) await saveProject(project)
    return true
  }

  // A job can finish for a project that is not open — a batch left running in
  // one project while the user works in another, or a relaunch that opened
  // something else. The result is paid for either way, so it goes into its own
  // manifest off disk rather than waiting for the user to happen to look.
  const { project } = await openProjectById(projectId)
  const updated = withCollectedGenerations(
    project,
    entries,
    Date.now(),
    // Nobody is looking at this project, so there is no grid to choose from:
    // an arrival fills a stage that has no input yet and otherwise leaves the
    // last choice alone.
    stagesWithoutSelection(project)
  )

  // If the editor opened it while we were reading, the copy in memory does not
  // know about these — writing ours would be overwritten by their next edit.
  // Hand it to the path that goes through the editor instead.
  if (useEditorStore.getState().state.project?.id === projectId) {
    return await record(projectId, entries)
  }

  if (updated !== project) await saveProject(updated)
  return true
}

/**
 * A finished job as a candidate, or `null` if this build cannot read it.
 *
 * Dropped rather than thrown on, for the reason `readManifest` drops an
 * unreadable candidate: one job written by a newer build is not a reason to
 * withhold the rest of a batch the user paid for.
 */
function asCompletedRun(job: Job): CompletedRun | null {
  const recipe = readRecipe(job.recipe)

  if (recipe === null || !isStageKind(job.stage)) {
    logger.warn('Dropping a finished job this build cannot read', {
      requestId: job.requestId,
      stage: job.stage,
    })
    return null
  }

  return {
    id: job.generationId,
    stage: job.stage,
    recipe,
    seed: job.seed,
    asset: job.asset,
    // The run this session has it under (#26) — including one adopted from a
    // previous launch. `null` only when it settled before we ever saw it,
    // which reads as an ungrouped candidate rather than a lost one.
    runId: runIdForGeneration(
      useEditorStore.getState().state,
      job.generationId
    ),
  }
}
