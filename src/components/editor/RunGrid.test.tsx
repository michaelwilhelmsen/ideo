/**
 * The moment a run is chosen from (#26, PRD §4.2).
 *
 * Four candidates only beat serial re-rolling if they are on screen together
 * and one of them can be kept. What is checked here is that trio: the ones
 * still generating hold their place, the ones that have landed are pickable,
 * and picking one hands the stage back rather than waiting for the queue.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { LEDGER, type Generation, type Project } from '@/lib/recipe'
import { commands, type Job } from '@/lib/tauri-bindings'
import { rememberRun, forgetRuns } from '@/services/run-ids'
import { useEditorStore } from '@/store/editor-store'
import { StageEditor } from './StageEditor'

const mockCommands = vi.mocked(commands)

const RUN = 'run-under-test'

beforeEach(() => {
  vi.clearAllMocks()
  forgetRuns()
  mockCommands.activeJobs.mockResolvedValue({ status: 'ok', data: [] })
  mockCommands.finishedJobs.mockResolvedValue({ status: 'ok', data: [] })
})

/** A job the store is holding, submitted by this session as part of `RUN`. */
function pending(generationId: string): Job {
  rememberRun(generationId, RUN)

  return {
    requestId: `req-${generationId}`,
    projectId: LEDGER.id,
    generationId,
    stage: 'source',
    recipe: LEDGER.drafts.source as unknown as Job['recipe'],
    status: 'running',
    modelId: LEDGER.drafts.source.modelId,
    seed: null,
    asset: null,
    submittedAt: Date.now(),
  } as Job
}

/** A candidate of that same run, already recorded in the manifest. */
function arrived(id: string, ordinal: number): Generation {
  return {
    id,
    stage: 'source',
    recipe: LEDGER.drafts.source,
    seed: 1_000 + ordinal,
    verdict: 'unrated',
    createdAt: 1,
    ordinal,
    asset: null,
    runId: RUN,
  }
}

/** Opens a project in the editor, with whatever the run has produced so far. */
function open(generations: readonly Generation[]): Project {
  const project: Project = {
    ...LEDGER,
    generations: [...LEDGER.generations, ...generations],
  }

  useEditorStore.getState().dispatch({
    type: 'openProject',
    project,
    directory: `/tmp/${project.id}`,
  })
  useEditorStore.getState().dispatch({ type: 'selectStage', stage: 'source' })

  return project
}

describe('the grid a run is watched in', () => {
  it('holds a place for every candidate still generating', async () => {
    mockCommands.activeJobs.mockResolvedValue({
      status: 'ok',
      data: [pending('gen-a'), pending('gen-b'), pending('gen-c')],
    })
    open([])

    render(<StageEditor />)

    await waitFor(() =>
      expect(
        screen.getAllByRole('status', { name: /generating/i })
      ).toHaveLength(3)
    )
  })

  it('fills them in as jobs settle, without moving the rest', async () => {
    // Two landed, one still running: the run is one thing being watched, not
    // a hero plus a queue.
    mockCommands.activeJobs.mockResolvedValue({
      status: 'ok',
      data: [pending('gen-c')],
    })
    open([arrived('gen-a', 2), arrived('gen-b', 3)])

    render(<StageEditor />)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Source 2/ })
      ).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /Source 3/ })).toBeInTheDocument()
    expect(screen.getAllByRole('status', { name: /generating/i })).toHaveLength(
      1
    )
  })

  it('shows only what this run produced, not the whole stage', async () => {
    mockCommands.activeJobs.mockResolvedValue({
      status: 'ok',
      data: [pending('gen-c')],
    })
    // The fixture's own candidate belongs to no run and must not be offered as
    // one of this batch.
    open([arrived('gen-a', 2)])

    render(<StageEditor />)

    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: /generating/i })
      ).toBeInTheDocument()
    )

    const grid = screen.getByRole('region', { name: /this run/i })
    expect(grid.textContent).toContain('Source 2')
    expect(grid.textContent).not.toContain('Source 1')
  })

  it('keeps the candidate that is picked, and hands the stage back', async () => {
    mockCommands.activeJobs.mockResolvedValue({
      status: 'ok',
      data: [pending('gen-c')],
    })
    open([arrived('gen-a', 2), arrived('gen-b', 3)])

    render(<StageEditor />)

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Source 3/ })
      ).toBeInTheDocument()
    )
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /Source 3/ }))

    // The choice, recorded where the next stage will read it.
    expect(useEditorStore.getState().state.project?.selection.source).toBe(
      'gen-b'
    )
    // And the run is no longer what the stage is: hero and strip are back,
    // even though a job is still in flight.
    expect(
      screen.queryByRole('region', { name: /this run/i })
    ).not.toBeInTheDocument()
  })

  it('is not shown at all when nothing is in flight', () => {
    open([arrived('gen-a', 2)])
    render(<StageEditor />)

    expect(
      screen.queryByRole('region', { name: /this run/i })
    ).not.toBeInTheDocument()
  })
})
