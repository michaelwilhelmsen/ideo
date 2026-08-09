/**
 * The moment a run is chosen from (#26, PRD §4.2).
 *
 * Four candidates only beat serial re-rolling if they are on screen together
 * and one of them can be kept. The awkward part is *when* that is true: the
 * job store reports what is running, so every one of these drives the grid
 * from the run itself and checks it survives the queue emptying — the moment
 * the four-up is finally complete is the moment a job-driven grid would
 * vanish.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { render, screen, within } from '@/test/test-utils'
import {
  LEDGER,
  planBatch,
  type EditorAction,
  type Generation,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { rollSeed } from './run-request'
import { StageEditor } from './StageEditor'

const RUN = 'run-under-test'
const CANDIDATES = ['gen-a', 'gen-b', 'gen-c', 'gen-d']

/**
 * The two actions a run dispatches, in order, with the results already in hand.
 *
 * Test-only, and here rather than beside `useRunStage` because no stage takes
 * this path any more — all three are paid (#28, #29), and a production export
 * nothing in production calls is a path that rots. What it is good for is
 * putting a *finished* run in front of the grid without a job store: the same
 * `beginRun` then `runStage` pair a paid batch produces over a minute, in one
 * synchronous go.
 */
function fixtureRunActions(
  project: Project,
  stage: StageKind,
  count: number
): readonly EditorAction[] {
  const batch = planBatch(count)
  const at = Date.now()

  return [
    {
      type: 'beginRun',
      runId: batch.runId,
      projectId: project.id,
      stage,
      generationIds: batch.generationIds,
      at,
    },
    {
      type: 'runStage',
      stage,
      runs: batch.generationIds.map(id => ({
        id,
        seed: rollSeed(),
        asset: null,
        runId: batch.runId,
      })),
      at,
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  useEditorStore.getState().reset()
  vi.mocked(commands.activeJobs).mockResolvedValue({ status: 'ok', data: [] })
  vi.mocked(commands.finishedJobs).mockResolvedValue({ status: 'ok', data: [] })
})

/** A candidate of the run, as it looks once it is in the manifest. */
function arrived(
  id: string,
  ordinal: number,
  runId: string | null
): Generation {
  return {
    id,
    stage: 'source',
    recipe: LEDGER.drafts.source,
    seed: 1_000 + ordinal,
    verdict: 'unrated',
    createdAt: 1,
    ordinal,
    asset: null,
    runId,
  }
}

/** Opens the project with whatever the run has produced so far. */
function open(generations: readonly Generation[]): Project {
  const project: Project = {
    ...LEDGER,
    generations: [...LEDGER.generations, ...generations],
  }

  const { dispatch } = useEditorStore.getState()
  dispatch({ type: 'openProject', project, directory: `/tmp/${project.id}` })
  dispatch({ type: 'selectStage', stage: 'source' })

  return project
}

/** The click that starts the run, as `useRunStage` dispatches it. */
function begin(ids: readonly string[] = CANDIDATES, runId = RUN): void {
  useEditorStore.getState().dispatch({
    type: 'beginRun',
    runId,
    projectId: LEDGER.id,
    stage: 'source',
    generationIds: ids,
    at: 1,
  })
}

function grid(): HTMLElement | null {
  return screen.queryByRole('region', { name: /this run/i })
}

function skeletons(): HTMLElement[] {
  return screen.queryAllByRole('status', { name: /generating/i })
}

describe('the grid a run is chosen from', () => {
  it('holds a place for every candidate the run is waiting for', () => {
    open([])
    begin()

    render(<StageEditor />)

    expect(grid()).toBeInTheDocument()
    expect(skeletons()).toHaveLength(4)
  })

  it('fills them in as candidates land, without moving the rest', () => {
    open([arrived('gen-a', 2, RUN), arrived('gen-b', 3, RUN)])
    begin()

    render(<StageEditor />)

    expect(screen.getByRole('button', { name: /Source 2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Source 3/ })).toBeInTheDocument()
    expect(skeletons()).toHaveLength(2)
  })

  it('is still there once the last job has settled', () => {
    // The regression this exists for: `active_jobs` reports only what is
    // *running*, so a grid that lived off the job list would disappear at the
    // moment it finally had all four images on it.
    open(CANDIDATES.map((id, index) => arrived(id, index + 2, RUN)))
    begin()

    render(<StageEditor />)

    expect(grid()).toBeInTheDocument()
    expect(skeletons()).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /Source \d/ })).toHaveLength(4)
  })

  it('shows only what this run produced, not the whole stage', () => {
    open([arrived('gen-a', 2, RUN), arrived('other', 3, 'another-run')])
    begin()

    render(<StageEditor />)

    const region = grid()
    expect(region?.textContent).toContain('Source 2')
    expect(region?.textContent).not.toContain('Source 3')
    // Three still expected, and the stranger is not one of them.
    expect(skeletons()).toHaveLength(3)
  })

  it('shows the newest run when two are queued', () => {
    open([arrived('gen-a', 2, RUN), arrived('gen-e', 3, 'run-second')])
    begin()
    begin(['gen-e', 'gen-f'], 'run-second')

    render(<StageEditor />)

    expect(grid()?.textContent).toContain('Source 3')
    expect(grid()?.textContent).not.toContain('Source 2')
    expect(skeletons()).toHaveLength(1)
  })

  it('stops waiting for a candidate that will never arrive', () => {
    open([arrived('gen-a', 2, RUN)])
    begin()
    useEditorStore.getState().dispatch({
      type: 'abandonGenerations',
      generationIds: ['gen-b', 'gen-c', 'gen-d'],
    })

    render(<StageEditor />)

    expect(skeletons()).toHaveLength(0)
    expect(grid()?.textContent).toMatch(/1 of 1/)
  })

  it('is not shown at all when no run is waiting for an answer', () => {
    open([arrived('gen-a', 2, RUN)])
    render(<StageEditor />)

    expect(grid()).not.toBeInTheDocument()
  })
})

describe('answering the run', () => {
  it('keeps the candidate that is picked, and hands the stage back', async () => {
    open([arrived('gen-a', 2, RUN), arrived('gen-b', 3, RUN)])
    begin()

    render(<StageEditor />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /Source 3/ }))

    // The choice, recorded where the next stage will read it.
    expect(useEditorStore.getState().state.project?.selection.source).toBe(
      'gen-b'
    )
    // And the run is no longer what the stage is, even though two candidates
    // of it are still generating.
    expect(grid()).not.toBeInTheDocument()
  })

  it('lets the run be put away without choosing from it', async () => {
    // A run whose jobs all failed would otherwise hold the stage for the rest
    // of the session.
    open([arrived('gen-a', 2, RUN)])
    begin()

    render(<StageEditor />)
    const before = useEditorStore.getState().state.project?.selection.source

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /not now/i }))

    expect(grid()).not.toBeInTheDocument()
    expect(useEditorStore.getState().state.project?.selection.source).toBe(
      before
    )
  })

  it('does not come back for the same run', async () => {
    open([arrived('gen-a', 2, RUN)])
    begin()

    const { rerender } = render(<StageEditor />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /not now/i }))
    rerender(<StageEditor />)

    expect(grid()).not.toBeInTheDocument()
  })
})

describe('a run whose candidates all arrive at once', () => {
  it('is chosen from the same way as one that trickles in', async () => {
    // Every stage is paid now (#28, #29), so this is no longer any stage's
    // normal path — but the grid must not depend on the delay to work. Four
    // candidates landing in the same instant are still four answers to one
    // question, and the grid is how a run is answered.
    const project: Project = { ...LEDGER, generations: [...LEDGER.generations] }
    const { dispatch } = useEditorStore.getState()
    dispatch({ type: 'openProject', project, directory: `/tmp/${project.id}` })
    dispatch({ type: 'selectStage', stage: 'style' })

    render(<StageEditor />)

    for (const action of fixtureRunActions(project, 'style', 4)) {
      act(() => {
        useEditorStore.getState().dispatch(action)
      })
    }

    // Complete the moment it began, and still waiting for a click.
    expect(grid()).toBeInTheDocument()
    expect(skeletons()).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /Style \d/ })).toHaveLength(4)

    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: /Style \d/ })[1] as Element)

    expect(grid()).not.toBeInTheDocument()
  })
})

describe('the seed of a candidate in the grid', () => {
  it('can be pinned from the tile it belongs to (PRD §4.3)', async () => {
    open([arrived('gen-a', 2, RUN)])
    begin(['gen-a'])

    render(<StageEditor />)

    // Scoped to the grid: the strip below has its own pin on every tile.
    const region = grid()
    if (region === null) throw new Error('the run is not on screen')

    await userEvent
      .setup()
      .click(within(region).getByRole('button', { name: /pin this seed/i }))

    expect(useEditorStore.getState().state.project?.drafts.source.seed).toEqual(
      {
        mode: 'pinned',
        value: 1_002,
      }
    )
  })

  it('offers no pin on a candidate with no seed to pin', () => {
    open([{ ...arrived('gen-a', 2, RUN), seed: null }])
    begin(['gen-a'])

    render(<StageEditor />)

    const region = grid()
    if (region === null) throw new Error('the run is not on screen')

    expect(
      within(region).queryByRole('button', { name: /pin this seed/i })
    ).not.toBeInTheDocument()
  })
})
