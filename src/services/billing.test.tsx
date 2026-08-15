/**
 * Reconciling estimates against what fal actually charged (#56, ADR 0003).
 *
 * The claims worth asserting are the ones that cost money if they stop being
 * true: a pass that fails must leave the watermark where it was, because a
 * watermark advanced over an unread span silently forfeits those charges — and
 * after 90 days they cannot be asked for again. Everything else here is the
 * other half of that promise: the overview keeps working when fal does not.
 */

import { render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { ATLAS, readManifest, summaryOf, writeManifest } from '@/lib/recipe'
import type { Generation, Project } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { useUIStore } from '@/store/ui-store'

/** Atlas with one paid candidate fal can be asked about. */
const PAID: Project = {
  ...ATLAS,
  generations: [
    {
      ...(ATLAS.generations[0] as Generation),
      id: 'gen-paid',
      costUsd: 0.04,
      requestId: 'req-abc',
      actualCostUsd: null,
    },
  ],
  selection: { ...ATLAS.selection, source: 'gen-paid' },
}

/** The library as the index reports it: one project, nothing reconciled. */
function library() {
  vi.mocked(commands.listProjects).mockResolvedValue({
    status: 'ok',
    data: [
      {
        ...summaryOf(PAID),
        generationCount: 1,
        costUsd: 0.04,
        uncostedCount: 0,
        reconciledCount: 0,
      },
    ],
  })
  vi.mocked(commands.loadProject).mockResolvedValue({
    status: 'ok',
    data: {
      directory: '/tmp/projects/project-atlas',
      manifest: writeManifest(PAID, 1) as unknown as JsonValue,
    },
  })
}

/** The most recent manifest handed to Rust, as a project again. */
function lastSavedProject() {
  const call = vi.mocked(commands.saveProject).mock.calls.at(-1)
  if (call === undefined) throw new Error('nothing was saved')
  return readManifest(call[0])
}

/** Whether the watermark moved — the one thing a failed pass must not do. */
function watermarkWrites() {
  return vi
    .mocked(commands.savePreferences)
    .mock.calls.filter(([prefs]) => prefs.reconciled_through != null)
}

async function openOverview() {
  useEditorStore.getState().reset()
  useUIStore.setState({ view: 'overview', newProjectOpen: false })
  render(<App />)
  // Nothing is asserted until the grid is actually on screen; the pass runs off
  // the same list the cards do.
  await screen.findByRole('button', { name: PAID.name })
}

describe('reconciling costs against fal', () => {
  beforeEach(() => {
    // Every assertion here is about *whether* a call happened, so the counts
    // have to start at zero. Cleared rather than reset: the shared stubs in
    // `test/setup.ts` are what the rest of the app runs on.
    vi.clearAllMocks()
    library()
    // A key is stored — the case where reconciliation is even attempted.
    vi.mocked(commands.hasFalApiKey).mockResolvedValue({
      status: 'ok',
      data: true,
    })
  })

  it("records fal's charge and how far it has read", async () => {
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'ok',
      data: [{ requestId: 'req-abc', costUsd: 0.037 }],
    })

    await openOverview()

    await waitFor(() => {
      expect(lastSavedProject().generations[0]?.actualCostUsd).toBe(0.037)
    })
    // The estimate is kept beside it rather than overwritten.
    expect(lastSavedProject().generations[0]?.costUsd).toBe(0.04)
    await waitFor(() => expect(watermarkWrites()).toHaveLength(1))
  })

  it('asks for one span across the whole library, not one call per project', async () => {
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'ok',
      data: [],
    })

    await openOverview()

    await waitFor(() => {
      expect(commands.falBillingEvents).toHaveBeenCalledTimes(1)
    })
  })

  it('leaves the watermark where it was when fal refuses', async () => {
    // The whole safety property. Advancing here would put every charge in the
    // unread span permanently out of reach.
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'error',
      error: 'fal refused the billing events request: 403 Forbidden',
    })

    await openOverview()

    await waitFor(() => {
      expect(commands.falBillingEvents).toHaveBeenCalled()
    })
    expect(watermarkWrites()).toHaveLength(0)
    // And the estimate is still on the card, which is still on screen.
    expect(await screen.findByText('~$0.04')).toBeInTheDocument()
  })

  it('does not ask at all when there is no key', async () => {
    vi.mocked(commands.hasFalApiKey).mockResolvedValue({
      status: 'ok',
      data: false,
    })

    await openOverview()

    await waitFor(() => expect(commands.hasFalApiKey).toHaveBeenCalled())
    expect(commands.falBillingEvents).not.toHaveBeenCalled()
    expect(watermarkWrites()).toHaveLength(0)
  })

  it('is not lost to one manifest this build cannot read', async () => {
    // A project written by a newer build is still indexed — Rust summarises a
    // manifest without validating it — so it turns up in the list and throws
    // on the way in. Without a guard it would take every other project's
    // charges with it, on this pass and on every pass after it.
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [
        { ...summaryOf(PAID), id: 'future', name: 'From a newer build' },
        {
          ...summaryOf(PAID),
          generationCount: 1,
          costUsd: 0.04,
          uncostedCount: 0,
          reconciledCount: 0,
        },
      ],
    })
    vi.mocked(commands.loadProject).mockImplementation(projectId =>
      Promise.resolve(
        projectId === 'future'
          ? {
              status: 'ok',
              data: {
                directory: '/tmp/projects/future',
                manifest: {
                  ...writeManifest(PAID, 1),
                  version: 99,
                } as unknown as JsonValue,
              },
            }
          : {
              status: 'ok',
              data: {
                directory: '/tmp/projects/project-atlas',
                manifest: writeManifest(PAID, 1) as unknown as JsonValue,
              },
            }
      )
    )
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'ok',
      data: [{ requestId: 'req-abc', costUsd: 0.037 }],
    })

    await openOverview()

    // Atlas is reconciled anyway...
    await waitFor(() => {
      expect(lastSavedProject().generations[0]?.actualCostUsd).toBe(0.037)
    })
    // ...and the watermark still moves, because nothing failed to *write*. A
    // manifest we can never read is not a span left unread.
    await waitFor(() => expect(watermarkWrites()).toHaveLength(1))
  })

  it('holds the watermark when a manifest will not write', async () => {
    // The other half: this one we could read, and its charges are real. Until
    // they are on disk the span has not been recorded, whatever else succeeded.
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'ok',
      data: [{ requestId: 'req-abc', costUsd: 0.037 }],
    })
    vi.mocked(commands.saveProject).mockResolvedValue({
      status: 'error',
      error: 'No space left on device',
    })

    await openOverview()

    await waitFor(() => expect(commands.saveProject).toHaveBeenCalled())
    expect(watermarkWrites()).toHaveLength(0)
  })

  it('does not open a manifest for a library that is already reconciled', async () => {
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [
        {
          ...summaryOf(PAID),
          generationCount: 1,
          costUsd: 0.037,
          uncostedCount: 0,
          reconciledCount: 1,
        },
      ],
    })
    vi.mocked(commands.falBillingEvents).mockResolvedValue({
      status: 'ok',
      data: [],
    })

    await openOverview()

    await waitFor(() => expect(commands.hasFalApiKey).toHaveBeenCalled())
    expect(commands.falBillingEvents).not.toHaveBeenCalled()
  })
})
