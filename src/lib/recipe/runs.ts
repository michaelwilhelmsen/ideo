/**
 * The ids a run is made of (#26, PRD §4.2).
 *
 * Here rather than beside either caller because both sides need them and
 * neither may own them: the editor mints a batch when the user clicks, and the
 * job service mints one when it finds work a previous launch left running. A
 * helper living in one of those two would make the other import across the
 * services/components line for a `randomUUID`.
 *
 * Impure, and kept out of `reducer.ts` for exactly that reason — the reducer
 * takes ids on the action so that "same seed, one changed fragment" is
 * reproducible rather than approximately reproducible.
 */

/**
 * One run's id. The only place one is ever made, so the paid path, the fixture
 * path and the sweep that adopts resumed work cannot group candidates
 * differently from one another.
 */
export function mintRunId(): string {
  return crypto.randomUUID()
}

/** One candidate a click is about to ask for: an id, and the model it goes to. */
export interface PlannedCandidate {
  readonly generationId: string
  readonly modelId: string
}

/**
 * The ids one click needs: one for the run, one per candidate.
 *
 * One `runId` across the **whole** fan-out, which is the claim ADR 0005 makes
 * about what a click is. Three models at two candidates each is six jobs and
 * one question — "which of these six", not "which of these two, three times" —
 * and the grid, the strip and the run history all key on that id.
 */
export interface PlannedBatch {
  readonly runId: string
  readonly candidates: readonly PlannedCandidate[]
}

/**
 * `perModel` candidates for each of `modelIds`, grouped by model.
 *
 * Grouped rather than interleaved so the grid reads as one column per model
 * with its batch under it, which is the comparison a fan-out is for. Submission
 * order follows the same shape, so the first candidate of every model is
 * queued before the second of any of them — with three jobs running at a time
 * (PRD §3.3), that is what makes the four-up fill across rather than down.
 */
export function planRun(
  modelIds: readonly string[],
  perModel: number
): PlannedBatch {
  return {
    runId: mintRunId(),
    // Minted before the submit because the file is named after it — the
    // manifest entry and the file on disk agree by construction.
    candidates: Array.from({ length: perModel }, () => 0).flatMap(() =>
      modelIds.map(modelId => ({
        generationId: crypto.randomUUID(),
        modelId,
      }))
    ),
  }
}
