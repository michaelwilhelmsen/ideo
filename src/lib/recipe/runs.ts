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

/** The ids one click needs: one for the run, one per candidate. */
export interface PlannedBatch {
  readonly runId: string
  readonly generationIds: readonly string[]
}

export function planBatch(count: number): PlannedBatch {
  return {
    runId: mintRunId(),
    // Minted before the submit because the file is named after it — the
    // manifest entry and the file on disk agree by construction.
    generationIds: Array.from({ length: count }, () => crypto.randomUUID()),
  }
}
