/**
 * Which run a submitted generation belongs to (#26).
 *
 * A run is four clicks' worth of one click: one id shared by every candidate
 * of a batch, so the grid can show them together and the strip can group them
 * afterwards. Rust does not carry it — a job knows its generation and its
 * project, and widening the job store to hold a purely presentational grouping
 * would mean a schema migration that discards everything in flight.
 *
 * So it lives here, for as long as the session does. That is deliberately
 * weaker than the manifest: a job that outlives a quit comes back with no run,
 * which reads as an ungrouped candidate rather than a lost one (see
 * `Generation.runId`). The grouping is a convenience; the candidate is the
 * thing that was paid for.
 */

/**
 * How many submitted generations are remembered at once.
 *
 * Bounded because nothing here is ever certain to be read: a job that is
 * cancelled, or fails, or settles after a quit, leaves its entry behind. Three
 * jobs run at once (PRD §3.3), so this is far more history than the grid can
 * use and still a fixed ceiling on the memory.
 */
const LIMIT = 64

const runs = new Map<string, string>()

/** Records that this generation was submitted as part of that run. */
export function rememberRun(generationId: string, runId: string): void {
  runs.set(generationId, runId)

  // Oldest first, because a Map iterates in insertion order.
  while (runs.size > LIMIT) {
    const oldest = runs.keys().next()
    if (oldest.done === true) break
    runs.delete(oldest.value)
  }
}

/** The run it was submitted with, or `null` if this session never knew. */
export function runIdOf(generationId: string): string | null {
  return runs.get(generationId) ?? null
}

/** Test seam. Nothing in the app forgets a run on purpose. */
export function forgetRuns(): void {
  runs.clear()
}
