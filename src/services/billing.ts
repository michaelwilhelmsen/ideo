/**
 * Turning estimates into what fal actually charged (#56, ADR 0003).
 *
 * A project's cost starts life as a forecast: the price table as it read on the
 * day, stamped onto each generation at collection. This is the other half —
 * fal's own per-request figure, fetched once for the whole library and folded
 * into every manifest it names.
 *
 * Three things about it are load-bearing.
 *
 * **One pass, not one per project.** fal's billing events are keyed by request
 * id and know nothing about our folders, so asking per project would be the
 * same pages fetched N times. The pass reads a *span* — from the watermark to
 * now — which is what lets somebody who has been away for a week catch up in
 * one call.
 *
 * **The watermark only moves on success.** It is the one piece of state that
 * can lose money quietly: advanced over a span that was never read, those
 * charges are never asked for again, and after 90 days they cannot be. So it
 * advances at the end of a completed pass and nowhere else.
 *
 * **Best-effort by construction.** No key, no network, a refused request, an
 * unwritable manifest — every one of those leaves the estimates in place, the
 * watermark where it was, and the overview entirely usable. Nothing here is
 * ever awaited by something the user is looking at.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import {
  awaitingReconciliation,
  withReconciledCosts,
  type Project,
  type ProjectSummary,
} from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { rememberReconciledThrough } from './preferences'
import {
  openProjectById,
  projectKeys,
  saveProject,
  useProjects,
} from './projects'

/** fal will not answer for anything older, so neither will we (ADR 0003). */
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000

/**
 * How far back of an already-reconciled span each pass re-reads.
 *
 * fal's billing lags its queue by minutes — the spike measured it — so a pass
 * that ran the instant a job finished sees a window with no record in it yet.
 * Advancing the watermark to *now* would put that charge permanently behind the
 * line. Re-reading the last day costs one page of events nobody needs and is
 * the difference between "not yet" and "never".
 */
const LAG_MARGIN_MS = 24 * 60 * 60 * 1000

/** One pass at a time, however many things ask for one. */
let running = false

/**
 * Runs a reconciliation pass when the overview opens.
 *
 * Mounted by the front door and nowhere else, for the reason collection is:
 * ADR 0002 lets that one view write to manifests of projects nobody is looking
 * at, and the widening is scoped by where it is mounted.
 */
export function useCostReconciliation(): void {
  const queryClient = useQueryClient()
  const { data: summaries } = useProjects()
  const attempted = useRef(false)

  useEffect(() => {
    if (summaries === undefined) return
    // Once per visit to the front door. The billing figures move on fal's
    // schedule rather than ours, and a re-render is not news from fal.
    if (attempted.current) return
    attempted.current = true

    reconcile(summaries, queryClient).catch((error: unknown) => {
      logger.warn('Could not reconcile costs against fal', { error })
    })
  }, [summaries, queryClient])
}

/**
 * Reads fal's charges for everything since the watermark and files them.
 *
 * Returns quietly at every point where there is nothing honest to do — no key
 * stored, nothing left to reconcile, a refused request. A pass that returns
 * without reaching the end leaves the watermark alone.
 */
async function reconcile(
  summaries: readonly ProjectSummary[],
  queryClient: ReturnType<typeof useQueryClient>
): Promise<void> {
  if (running) return
  running = true

  try {
    // Checked before the window is worked out, so the overwhelming common case
    // of "no key yet" costs one local call rather than a failed request and a
    // warning on every launch.
    const key = await commands.hasFalApiKey()
    if (key.status === 'error' || !key.data) return

    // Only projects the answer could still change. A library of finished,
    // fully-reconciled work opens without a single manifest being read.
    const unsettled = summaries.filter(
      summary => summary.reconciledCount < summary.generationCount
    )
    if (unsettled.length === 0) return

    const loaded = await commands.loadPreferences()
    const end = Date.now()
    const floor = end - WINDOW_MS
    // Clamped on both sides: a watermark from a machine with a wrong clock
    // must not ask fal for the future, and one older than the window is asking
    // for records that no longer exist.
    const start = Math.min(
      Math.max(
        loaded.status === 'ok'
          ? (loaded.data.reconciled_through ?? floor)
          : floor,
        floor
      ),
      end
    )

    const events = await commands.falBillingEvents(start, end)
    if (events.status === 'error') {
      // Not an error the user is shown. The estimates are still on screen and
      // still true, and the next visit tries the same span again.
      logger.info('fal did not answer for its billing events', {
        error: events.error,
      })
      return
    }

    const charges = new Map(
      events.data.map(charge => [charge.requestId, charge.costUsd])
    )

    // One project at a time, and one project's failure at a time. A pass over
    // the whole library must not be lost to a single manifest that would not
    // write — the same rule the index keeps when it rebuilds (`index.rs`: one
    // unreadable manifest does not hide the rest of the library).
    let recorded = true
    for (const summary of unsettled) {
      try {
        await applyCharges(summary.id, charges)
      } catch (error) {
        // This project's charges are still fal's to report, so the span stays
        // unread and every other project keeps what it just learned.
        recorded = false
        logger.warn('Could not record what fal charged a project', {
          projectId: summary.id,
          error,
        })
      }
    }

    // The card's figure comes off the index, and a manifest that just changed
    // is not in it yet. Before the watermark, because this is true whether or
    // not every project got there.
    await queryClient.invalidateQueries({ queryKey: projectKeys.list() })

    // Last, and only on a pass that wrote everything it read. A watermark moved
    // over a project that failed to write would forfeit that project's real
    // charges — and after 90 days they cannot be asked for again.
    if (!recorded) return
    await rememberReconciledThrough(queryClient, end - LAG_MARGIN_MS)

    logger.info('Reconciled costs against fal', {
      charges: charges.size,
      projects: unsettled.length,
    })
  } finally {
    running = false
  }
}

/**
 * Folds the charges into one project's manifest, wherever it is.
 *
 * The same two paths collection takes, and for the same reason: the open
 * project is a live document held in the store, and writing round it would be
 * overwritten by its next edit.
 */
async function applyCharges(
  projectId: string,
  charges: ReadonlyMap<string, number>
): Promise<void> {
  const open = useEditorStore.getState().state.project

  if (open !== null && open.id === projectId) {
    useEditorStore.getState().dispatch({ type: 'reconcileCosts', charges })

    const project = useEditorStore.getState().state.project
    // Closed or swapped underneath us. Nothing is lost — the charges are still
    // fal's to report, and the next pass reads the same span.
    if (project === null || project.id !== projectId) return
    if (project !== open) await saveProject(project)
    return
  }

  let project: Project
  try {
    ;({ project } = await openProjectById(projectId))
  } catch (error) {
    // A manifest this build cannot read — written by a newer build, or
    // hand-edited — is skipped rather than treated as a pass that failed. It
    // could never be reconciled whatever the watermark said, so holding the
    // line for it would only mean re-reading the same span forever while every
    // other project waits behind it.
    logger.warn('Could not read a project to reconcile it', {
      projectId,
      error,
    })
    return
  }

  // Nothing here has an id to join on: an imported source, a fixture-driven
  // candidate, or work already reconciled. Read and dropped rather than
  // rewritten — a pass must not touch the mtime of a project it has nothing
  // to say about.
  if (!awaitingReconciliation(project)) return

  const updated = withReconciledCosts(project, charges)
  if (updated === project) return

  // The editor opened it while we were reading. Its copy does not know about
  // this, so hand it to the path that goes through the store.
  if (useEditorStore.getState().state.project?.id === projectId) {
    return await applyCharges(projectId, charges)
  }

  await saveProject(updated)
}
