/**
 * Jobs that outlive the session that started them (#24).
 *
 * What is worth asserting here is the claim the slice makes, not that a mock
 * was called: a generation submitted before the last quit ends up in the
 * manifest on relaunch, and it is only taken off the books once it is safely
 * there. Both are checked against the document actually handed to Rust.
 */

import { render, screen, waitFor } from '@/test/test-utils'
import { act } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { readManifest, writeManifest } from '@/lib/recipe'
import { commands, type Job, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { useUIStore } from '@/store/ui-store'
import { collectFinished } from './jobs'
import {
  ATLAS,
  ATLAS_SOURCE_NODE,
  LEDGER,
  LEDGER_SOURCE_NODE,
  fixtureFrozen,
  summaryOf,
} from '../lib/recipe/fixtures'

/** A job the store was holding when the app started. */
function finishedJob(overrides: Partial<Job> = {}): Job {
  return {
    requestId: 'req-from-last-time',
    projectId: ATLAS.id,
    generationId: 'gen-from-last-time',
    stage: 'source',
    recipe: fixtureFrozen(ATLAS, ATLAS_SOURCE_NODE) as unknown as JsonValue,
    status: 'completed',
    modelId: 'fal-ai/flux-pro/v1.1',
    seed: 1234,
    asset: 'gen-from-last-time.jpeg',
    submittedAt: 1,
    ...overrides,
  }
}

/** The most recent manifest handed to Rust, as a project again. */
function lastSavedProject() {
  const call = vi.mocked(commands.saveProject).mock.calls.at(-1)
  if (call === undefined) throw new Error('nothing was saved')
  return readManifest(call[0])
}

async function openAtlas() {
  vi.mocked(commands.listProjects).mockResolvedValue({
    status: 'ok',
    data: [summaryOf(ATLAS)],
  })
  vi.mocked(commands.loadProject).mockResolvedValue({
    status: 'ok',
    data: {
      directory: '/tmp/projects/project-atlas',
      manifest: writeManifest(ATLAS, 1) as unknown as JsonValue,
    },
  })

  // The app lands on the overview now (#55); these tests are about the editor.
  useUIStore.setState({ view: 'editor' })
  render(<App />)
  await screen.findByRole('heading', { name: 'Atlas — hero' })
}

/**
 * Put the source node's panel on screen.
 *
 * A click on its card, since the tab bar is gone (ADR 0005). Scoped to the
 * canvas rather than the whole document, because "Source 2" is also the name of
 * a card in the input row every downstream node carries — a bare `/^Source/`
 * would match the step and the ingredient alike.
 */
async function showSourceParameters() {
  await userEvent.click(
    await screen.findByRole('heading', { name: /^Source$/ })
  )
}

describe('collecting work that survived a quit', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
    vi.mocked(commands.claimJob).mockClear()
    vi.mocked(commands.cancelJob).mockClear()
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [],
    })
    vi.mocked(commands.activeJobs).mockResolvedValue({ status: 'ok', data: [] })
  })

  it('writes a generation submitted last session into the manifest', async () => {
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await openAtlas()

    await waitFor(() => {
      const saved = lastSavedProject().generations.find(
        generation => generation.id === 'gen-from-last-time'
      )
      expect(saved?.asset).toBe('gen-from-last-time.jpeg')
      expect(saved?.seed).toBe(1234)
    })
  })

  it('records what the generation cost, and what fal called it', async () => {
    // ADR 0003 — the estimate is stamped at collection, because prices drift
    // and the overview has to sum a project without opening its manifest. The
    // request id is kept at the same moment because claiming the job is about
    // to delete the only other copy, and fal's billing window is 90 days.
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await openAtlas()

    await waitFor(() => {
      const saved = lastSavedProject().generations.find(
        generation => generation.id === 'gen-from-last-time'
      )
      expect(saved?.requestId).toBe('req-from-last-time')
      expect(saved?.costUsd).toBeGreaterThan(0)
    })
  })

  it('only takes the job off the books once the manifest has it', async () => {
    // The row is the sole record that a paid result exists, so claiming first
    // would turn a badly timed crash into a generation nobody has.
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await openAtlas()

    await waitFor(() => {
      expect(commands.claimJob).toHaveBeenCalledWith('req-from-last-time')
    })
    const saved = vi.mocked(commands.saveProject).mock.invocationCallOrder.at(0)
    const claimed = vi.mocked(commands.claimJob).mock.invocationCallOrder.at(0)
    expect(saved).toBeDefined()
    expect(claimed).toBeDefined()
    expect(saved ?? 0).toBeLessThan(claimed ?? 0)
  })

  it('drops a finished job whose recipe this build cannot read', async () => {
    // One unreadable job is not a reason to withhold the rest of a batch, and
    // leaving it on the books would mean collecting it forever.
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [
        finishedJob({ recipe: { nonsense: true } as unknown as JsonValue }),
      ],
    })

    await openAtlas()

    await waitFor(() => {
      expect(commands.claimJob).toHaveBeenCalledWith('req-from-last-time')
    })
    expect(commands.saveProject).not.toHaveBeenCalled()
  })

  it('files a result for a project that is not open into its own manifest', async () => {
    // A batch left running in one project while the user works in another is
    // paid for just the same. Collecting it into whatever happens to be open
    // would file the generation under the wrong project; waiting for the user
    // to open it leaves a paid result sitting in a database.
    vi.mocked(commands.finishedJobs).mockImplementation(async projectId => ({
      status: 'ok',
      data:
        projectId === LEDGER.id
          ? [
              finishedJob({
                projectId: LEDGER.id,
                recipe: fixtureFrozen(
                  LEDGER,
                  LEDGER_SOURCE_NODE
                ) as unknown as JsonValue,
              }),
            ]
          : [],
    }))

    await openAtlas()
    vi.mocked(commands.loadProject).mockResolvedValue({
      status: 'ok',
      data: {
        directory: '/tmp/projects/project-ledger',
        manifest: writeManifest(LEDGER, 1) as unknown as JsonValue,
      },
    })

    await collectFinished(LEDGER.id)

    const saved = lastSavedProject()
    expect(saved.id).toBe(LEDGER.id)
    expect(
      saved.generations.some(
        generation => generation.id === 'gen-from-last-time'
      )
    ).toBe(true)
    // And the project the user is actually looking at is untouched.
    expect(useEditorStore.getState().state.project?.id).toBe(ATLAS.id)
    expect(
      useEditorStore
        .getState()
        .state.project?.generations.some(g => g.id === 'gen-from-last-time')
    ).toBe(false)
  })

  it('shows a job left running by a previous session, and can cancel it', async () => {
    vi.mocked(commands.activeJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob({ status: 'running', asset: null, seed: null })],
    })

    await openAtlas()
    await showSourceParameters()

    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await userEvent.click(cancel)

    expect(commands.cancelJob).toHaveBeenCalledWith('req-from-last-time')
  })

  it('never promises the cancelled job was free', async () => {
    // PRD §3.3 — cancelling may or may not prevent the charge, and the copy
    // beside the button is the only place that can say so.
    vi.mocked(commands.activeJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob({ status: 'running', asset: null, seed: null })],
    })

    await openAtlas()
    await showSourceParameters()

    const note = await screen.findByText(/may still charge/i)
    expect(note).toBeVisible()
  })
})

/**
 * The run a collected candidate belongs to (#26).
 *
 * The job store knows nothing about runs, so this is the one place the
 * grouping can be lost: the session records which click submitted what, and
 * the sweep adopts anything a previous launch left running so a resumed batch
 * is watched exactly like a fresh one.
 */
describe('a collected candidate remembers its run', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
    vi.mocked(commands.activeJobs).mockResolvedValue({ status: 'ok', data: [] })
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [],
    })
  })

  /** The candidate the fixture job produces, as it was written to disk. */
  function savedCandidate() {
    return lastSavedProject().generations.find(
      generation => generation.id === 'gen-from-last-time'
    )
  }

  it('carries the run it was submitted with into the manifest', async () => {
    await openAtlas()

    // As `useRunStage` records it before the submits go out.
    act(() => {
      useEditorStore.getState().dispatch({
        type: 'beginRun',
        runId: 'run-this-session',
        projectId: ATLAS.id,
        nodeId: ATLAS_SOURCE_NODE,
        generationIds: ['gen-from-last-time'],
        at: 1,
      })
    })

    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await act(async () => {
      await collectFinished(ATLAS.id)
    })

    expect(savedCandidate()?.runId).toBe('run-this-session')
  })

  it('adopts a batch a previous launch left running, so it is grouped too', async () => {
    // Nothing in this session submitted these, and the user is still waiting
    // on them: they are a run whichever launch clicked Generate.
    vi.mocked(commands.activeJobs).mockResolvedValue({
      status: 'ok',
      data: [
        finishedJob({ requestId: 'req-1', generationId: 'gen-1' }),
        finishedJob({ requestId: 'req-2', generationId: 'gen-2' }),
      ],
    })

    await openAtlas()

    await waitFor(() => {
      const runs = useEditorStore.getState().state.runs
      expect(runs).toHaveLength(1)
      expect(runs[0]?.generationIds).toEqual(['gen-1', 'gen-2'])
      expect(runs[0]?.nodeId).toBe(ATLAS_SOURCE_NODE)
    })

    // Adopted once, however many times the list is polled.
    await waitFor(() => {
      expect(useEditorStore.getState().state.runs).toHaveLength(1)
    })
  })

  it('adopts a batch that finished while the app was closed', async () => {
    // The common resumed case: you quit, fal.ai finished anyway, and the
    // candidates are waiting in the store on relaunch. They are a run the user
    // never got to choose from, so they are put in front of them as one.
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [
        finishedJob({ requestId: 'req-a', generationId: 'gen-a' }),
        finishedJob({ requestId: 'req-b', generationId: 'gen-b' }),
      ],
    })

    await openAtlas()

    await waitFor(() => {
      const runs = useEditorStore.getState().state.runs
      expect(runs).toHaveLength(1)
      expect(runs[0]?.generationIds).toEqual(['gen-a', 'gen-b'])
    })

    const runId = useEditorStore.getState().state.runs[0]?.id
    const saved = lastSavedProject().generations.filter(
      generation => generation.runId === runId
    )
    expect(saved).toHaveLength(2)
  })

  it('does not adopt a candidate that is already in the manifest', async () => {
    // A run can be forgotten once it has been answered, and its jobs would
    // then look unowned again — re-adopting them would put a grid back up for
    // a question the user has already answered.
    vi.mocked(commands.activeJobs).mockResolvedValue({
      status: 'ok',
      data: [
        finishedJob({
          requestId: 'req-known',
          generationId: ATLAS.generations[0]?.id ?? '',
        }),
      ],
    })

    await openAtlas()

    await waitFor(() => {
      expect(commands.activeJobs).toHaveBeenCalled()
    })
    expect(useEditorStore.getState().state.runs).toHaveLength(0)
  })
})

/**
 * ADR 0002's new hazard, as an assertion.
 *
 * Collection used to happen on open, which meant one trigger. The overview
 * collects for projects nobody has open, so the same result can now be reached
 * twice at nearly the same moment — and a paid generation recorded twice is a
 * duplicate the user has to reason about, in the one file that is the source of
 * truth.
 */
describe('two triggers collecting the same result', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
    vi.mocked(commands.claimJob).mockClear()
    vi.mocked(commands.loadProject).mockResolvedValue({
      status: 'ok',
      data: {
        directory: '/tmp/projects/project-atlas',
        manifest: writeManifest(ATLAS, 1) as unknown as JsonValue,
      },
    })
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })
  })

  it('produces exactly one manifest entry', async () => {
    // The overview and an opening project, at the same moment.
    await Promise.all([collectFinished(ATLAS.id), collectFinished(ATLAS.id)])

    const saved = vi
      .mocked(commands.saveProject)
      .mock.calls.map(call => readManifest(call[0]))

    expect(saved.length).toBeGreaterThan(0)
    for (const project of saved) {
      expect(
        project.generations.filter(
          generation => generation.id === 'gen-from-last-time'
        )
      ).toHaveLength(1)
    }
  })

  it('claims the job once, and only after it is on disk', async () => {
    await Promise.all([collectFinished(ATLAS.id), collectFinished(ATLAS.id)])

    expect(vi.mocked(commands.claimJob).mock.calls).toEqual([
      ['req-from-last-time'],
    ])
    expect(vi.mocked(commands.saveProject)).toHaveBeenCalled()
  })
})
