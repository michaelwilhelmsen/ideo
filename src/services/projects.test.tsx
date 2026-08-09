/**
 * The seam between the editor and the disk (#23).
 *
 * What is worth asserting here is not that a mock was called, but the two
 * claims the slice makes: an edit reaches the manifest, and what reaches the
 * manifest is what comes back. The second is checked by reading the document
 * that was actually sent — if `writeManifest` and `readManifest` ever stop
 * agreeing, this fails rather than the round-trip unit test that uses both.
 */

import { render, screen, waitFor } from '@/test/test-utils'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { ATLAS, readManifest, summaryOf, writeManifest } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { newProject } from '@/services/projects'
import { useEditorStore } from '@/store/editor-store'

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

describe('the open project and the disk', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
  })

  it('opens a project by reading its manifest, not by trusting the index', async () => {
    await openAtlas()

    const project = useEditorStore.getState().state.project
    expect(project?.drafts.style.presetId).toBe('sun-bleached-film')
    expect(project?.generations).toHaveLength(ATLAS.generations.length)
  })

  it('writes an edited recipe back, so it survives a restart', async () => {
    await openAtlas()

    act(() => {
      useEditorStore.getState().dispatch({
        type: 'setPrompt',
        stage: 'style',
        prompt: 'a colder version of the same thing',
      })
    })

    await waitFor(
      () => {
        expect(lastSavedProject().drafts.style.prompt).toBe(
          'a colder version of the same thing'
        )
      },
      { timeout: 3000 }
    )
  })

  it('does not rewrite a project it has only just read', async () => {
    // Opening is not an edit. Saving on open would bump every project's
    // timestamp to the last time it was looked at, and the sidebar is sorted
    // by exactly that.
    await openAtlas()

    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(commands.saveProject).not.toHaveBeenCalled()
  })
})

/**
 * #26 widened the manifest without moving its version. Both halves of that are
 * disk claims, so they are checked against the document Rust was actually
 * handed rather than against the reducer's copy.
 */
describe('runs and batch sizes reach the disk (#26)', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    vi.mocked(commands.saveProject).mockClear()
  })

  it('gives a new project the defaults, copied rather than referenced', () => {
    const project = newProject('Something new', '16:9')

    expect(project.imageBatchSize).toBe(4)
    expect(project.videoBatchSize).toBe(1)
  })

  it('writes back a changed batch size', async () => {
    await openAtlas()

    act(() => {
      useEditorStore
        .getState()
        .dispatch({ type: 'setBatchSize', stage: 'source', size: 2 })
    })

    await waitFor(() => expect(lastSavedProject().imageBatchSize).toBe(2), {
      timeout: 3000,
    })
  })

  it('writes back which run produced a candidate', async () => {
    await openAtlas()

    act(() => {
      useEditorStore.getState().dispatch({
        type: 'runStage',
        // The source draft rolls its seed; the style draft pins one, and a pin
        // collapses the batch to a single candidate.
        stage: 'source',
        runs: [
          { id: 'fresh-a', seed: 1, asset: null, runId: 'run-fresh' },
          { id: 'fresh-b', seed: 2, asset: null, runId: 'run-fresh' },
        ],
        at: 2,
      })
    })

    await waitFor(
      () => {
        const saved = lastSavedProject().generations.filter(
          g => g.runId === 'run-fresh'
        )
        expect(saved).toHaveLength(2)
      },
      { timeout: 3000 }
    )
  })
})
