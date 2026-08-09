/**
 * Jobs that outlive the session that started them (#24).
 *
 * What is worth asserting here is the claim the slice makes, not that a mock
 * was called: a generation submitted before the last quit ends up in the
 * manifest on relaunch, and it is only taken off the books once it is safely
 * there. Both are checked against the document actually handed to Rust.
 */

import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import {
  ATLAS,
  LEDGER,
  readManifest,
  summaryOf,
  writeManifest,
} from '@/lib/recipe'
import { commands, type Job, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { collectFinished } from './jobs'
import { forgetRuns, rememberRun } from './run-ids'

/** A job the store was holding when the app started. */
function finishedJob(overrides: Partial<Job> = {}): Job {
  return {
    requestId: 'req-from-last-time',
    projectId: ATLAS.id,
    generationId: 'gen-from-last-time',
    stage: 'source',
    recipe: ATLAS.drafts.source as unknown as JsonValue,
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

  render(<App />)
  await screen.findByRole('heading', { name: 'Atlas — hero' })
}

/**
 * Opening a project lands on the stage it has got furthest with, and the
 * source jobs below live in that stage's own panel.
 */
async function showSourceParameters() {
  await userEvent.click(await screen.findByRole('button', { name: /^Source/ }))
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
                recipe: LEDGER.drafts.source as unknown as JsonValue,
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
 * grouping can be lost: it is remembered in this session and attached as the
 * result is folded in. A job that outlived the session has to arrive anyway.
 */
describe('a collected candidate remembers its run', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
    forgetRuns()
    vi.mocked(commands.activeJobs).mockResolvedValue({ status: 'ok', data: [] })
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [],
    })
  })

  it('carries the run it was submitted with into the manifest', async () => {
    rememberRun('gen-from-last-time', 'run-this-session')
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await openAtlas()

    await waitFor(() => {
      const saved = lastSavedProject().generations.find(
        generation => generation.id === 'gen-from-last-time'
      )
      expect(saved?.runId).toBe('run-this-session')
    })
  })

  it('arrives ungrouped rather than not at all when the run is forgotten', async () => {
    // A job submitted before the last quit: nothing in this session ever knew
    // which click it came from, and the candidate was still paid for.
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [finishedJob()],
    })

    await openAtlas()

    await waitFor(() => {
      const saved = lastSavedProject().generations.find(
        generation => generation.id === 'gen-from-last-time'
      )
      expect(saved).toBeDefined()
      expect(saved?.runId).toBeNull()
    })
  })
})
