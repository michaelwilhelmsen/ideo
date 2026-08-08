import { render, screen, waitFor, within } from '@/test/test-utils'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import App from './App'
import { ATLAS, summaryOf, writeManifest } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'

// Tauri bindings are mocked globally in src/test/setup.ts

/** A library with one project in it, as the commands would report it. */
function libraryWithAtlas() {
  vi.mocked(commands.listProjects).mockResolvedValue({
    status: 'ok',
    data: [summaryOf(ATLAS)],
  })
  vi.mocked(commands.loadProject).mockResolvedValue({
    status: 'ok',
    data: {
      directory: '/tmp/projects/project-atlas',
      // The command's payload is untyped JSON; the manifest reader is what
      // gives it a shape again.
      manifest: writeManifest(ATLAS, 1) as unknown as JsonValue,
    },
  })
}

describe('App', () => {
  beforeEach(() => {
    // The store outlives a render, and an open project would leak into the
    // next test's empty library.
    useEditorStore.getState().reset()
  })

  it('says so when there is nothing to open, rather than inventing a project', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /nothing open/i })).toBeVisible()
  })

  it('opens what is on disk and shows its recipe (#23)', async () => {
    libraryWithAtlas()
    render(<App />)

    // The project, its locked ratio, and the prompt that produced it — the
    // recipe surviving a restart is the whole point of the slice.
    expect(
      await screen.findByRole('heading', { name: 'Atlas — hero' })
    ).toBeVisible()
    await waitFor(() => {
      expect(screen.getAllByText('21:9').length).toBeGreaterThan(0)
    })
  })

  it('offers the three stages as tabs rather than steps', async () => {
    libraryWithAtlas()
    render(<App />)

    const stages = within(
      await screen.findByRole('navigation', { name: /stages/i })
    )
    // Every stage is reachable directly — there is no "next" (PRD §4.1).
    expect(stages.getByRole('button', { name: /source/i })).toBeEnabled()
    expect(stages.getByRole('button', { name: /style/i })).toBeEnabled()
    expect(stages.getByRole('button', { name: /animate/i })).toBeEnabled()
  })

  it('renders title bar with traffic light buttons', () => {
    render(<App />)
    // Find specifically the window control buttons in the title bar
    const titleBarButtons = screen
      .getAllByRole('button')
      .filter(
        button =>
          button.getAttribute('aria-label')?.includes('window') ||
          button.className.includes('window-control')
      )
    // Should have at least the window control buttons
    expect(titleBarButtons.length).toBeGreaterThan(0)
  })
})
