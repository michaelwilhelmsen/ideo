/**
 * What a stage has in flight, gathered into the run that started it (#26).
 *
 * Split out of the grid that renders it for the reason `naming.ts` is split
 * out of `shared.tsx`: this is a question about state, and the component file
 * is components only.
 *
 * The jobs come from the store rather than from this session, so a run that
 * outlived a quit still shows as work in progress — it just has no run id to
 * gather arrivals under, because the store does not carry one.
 */

import type { Generation, Project, StageKind } from '@/lib/recipe'
import type { Job } from '@/lib/tauri-bindings'
import { useStageJobs } from '@/services/jobs'
import { runIdOf } from '@/services/run-ids'

export interface ActiveRun {
  /** `null` when jobs are running that this session did not submit. */
  readonly runId: string | null
  readonly pending: readonly Job[]
  /** This run's candidates that have landed so far, oldest first. */
  readonly arrived: readonly Generation[]
}

export function useActiveRun(project: Project, stage: StageKind): ActiveRun {
  const pending = useStageJobs(project.id, stage)

  const runId =
    pending.map(job => runIdOf(job.generationId)).find(id => id !== null) ??
    null

  return {
    runId,
    pending,
    arrived:
      runId === null
        ? []
        : project.generations.filter(
            generation =>
              generation.stage === stage && generation.runId === runId
          ),
  }
}
