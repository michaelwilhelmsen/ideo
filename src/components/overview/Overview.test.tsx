/**
 * The front door (#55).
 *
 * What is worth asserting here is what the card claims and where it points: a
 * thumbnail rather than an original (ADR 0004), work happening elsewhere marked
 * as such (ADR 0002), and a click that lands in the editor.
 */

import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { ATLAS, LEDGER, summaryOf, writeManifest } from '@/lib/recipe'
import {
  commands,
  type Job,
  type JsonValue,
  type ProjectSummary,
} from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { useUIStore } from '@/store/ui-store'

function card(overrides: Partial<ProjectSummary>): ProjectSummary {
  return { ...summaryOf(ATLAS), ...overrides }
}

function runningJob(projectId: string, requestId: string): Job {
  return {
    requestId,
    projectId,
    generationId: `gen-${requestId}`,
    stage: 'source',
    recipe: ATLAS.drafts.source as unknown as JsonValue,
    status: 'running',
    modelId: 'fal-ai/flux-pro/v1.1',
    seed: null,
    asset: null,
    submittedAt: Date.now(),
  }
}

describe('the overview', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    useUIStore.setState({ view: 'overview', newProjectOpen: false })
    vi.mocked(commands.loadProject).mockResolvedValue({
      status: 'ok',
      data: {
        directory: '/tmp/projects/project-atlas',
        manifest: writeManifest(ATLAS, 1) as unknown as JsonValue,
      },
    })
  })

  it('draws the generated thumbnail, never the original', async () => {
    // ADR 0004's whole reason: the original is a 5 MB hero, the card is a card.
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [
        card({
          directory: '/tmp/projects/project-atlas',
          thumbnail: 'gen-1.thumb.jpg',
          thumbnailAsset: 'gen-1.png',
        }),
      ],
    })

    render(<App />)

    // Decorative — the card's own label names the project, so the picture is
    // `alt=""` and has no role of its own to find it by.
    await waitFor(() => {
      expect(document.querySelector('img')).toHaveAttribute(
        'src',
        'asset:///tmp/projects/project-atlas/assets/gen-1.thumb.jpg'
      )
    })
    // Nothing on the grid autoplays, whatever the generation was.
    expect(document.querySelector('video')).toBeNull()
  })

  it('says what a card costs, and says it is approximate', async () => {
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [card({ generationCount: 4, costUsd: 0.24, uncostedCount: 0 })],
    })

    render(<App />)

    expect(await screen.findByText(/~\$0\.24/)).toBeVisible()
  })

  it('will not pass off an unknown cost as a free one', async () => {
    // ADR 0003 — a token-priced model has no per-image figure, and `$0.00`
    // would be a claim about money rather than an admission of not knowing.
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [card({ generationCount: 2, costUsd: 0, uncostedCount: 2 })],
    })

    render(<App />)

    expect(await screen.findByText(/cost unknown/i)).toBeVisible()
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })

  it('marks a project whose work is running somewhere else', async () => {
    // ADR 0002 — the point of a front door is watching results arrive, and
    // "running" is a fact about the library rather than about the open project.
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [card({}), card({ id: LEDGER.id, name: LEDGER.name })],
    })
    vi.mocked(commands.activeJobsEverywhere).mockResolvedValue({
      status: 'ok',
      data: [runningJob(LEDGER.id, 'req-1'), runningJob(LEDGER.id, 'req-2')],
    })

    render(<App />)

    expect(await screen.findByText('2 running')).toBeVisible()
  })

  it('collects a result for a project nobody has open', async () => {
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [card({})],
    })
    vi.mocked(commands.finishedJobsEverywhere).mockResolvedValue({
      status: 'ok',
      data: [
        {
          ...runningJob(ATLAS.id, 'req-done'),
          status: 'completed',
          asset: 'gen-req-done.jpeg',
        },
      ],
    })
    vi.mocked(commands.finishedJobs).mockResolvedValue({
      status: 'ok',
      data: [
        {
          ...runningJob(ATLAS.id, 'req-done'),
          status: 'completed',
          asset: 'gen-req-done.jpeg',
        },
      ],
    })

    render(<App />)

    await waitFor(() => {
      expect(commands.saveProject).toHaveBeenCalled()
    })
  })

  it('offers a way to create a project when there are none', async () => {
    vi.mocked(commands.listProjects).mockResolvedValue({
      status: 'ok',
      data: [],
    })

    render(<App />)

    const create = await screen.findAllByRole('button', {
      name: /new project/i,
    })
    await userEvent.click(create[0] as HTMLElement)
    expect(useUIStore.getState().newProjectOpen).toBe(true)
  })
})
