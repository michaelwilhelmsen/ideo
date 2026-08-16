import { render, screen, waitFor, within } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import App from './App'
import { ATLAS, summaryOf, writeManifest } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { useUIStore } from '@/store/ui-store'

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
    useUIStore.setState({ view: 'overview' })
  })

  it('lands on the overview rather than on the editor (#55)', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: /projects/i })).toBeVisible()
    // The sidebars belong to the editor, and the editor is not what is up.
    expect(
      screen.queryByRole('navigation', { name: /stages/i })
    ).not.toBeInTheDocument()
  })

  it('opens a project from its card, and offers a way back (#55)', async () => {
    libraryWithAtlas()
    render(<App />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Atlas — hero' })
    )

    // The canvas, not a tab bar (ADR 0005): the project's name in the editor
    // header is what says the editor is up.
    expect(
      await screen.findByRole('heading', { name: 'Atlas — hero' })
    ).toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: /back to the overview/i })
    )
    expect(screen.getByRole('heading', { name: /projects/i })).toBeVisible()
  })

  it('says so when there is nothing to open, rather than inventing a project', () => {
    useUIStore.setState({ view: 'editor' })
    render(<App />)
    expect(screen.getByRole('heading', { name: /nothing open/i })).toBeVisible()
  })

  it('opens what is on disk and shows its recipe (#23)', async () => {
    libraryWithAtlas()
    useUIStore.setState({ view: 'editor' })
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

  it('offers the steps as a canvas rather than as tabs', async () => {
    libraryWithAtlas()
    useUIStore.setState({ view: 'editor' })
    render(<App />)

    // Every step is on screen at once and every one of them has its own Run
    // button — there is no "next", and no tab hiding two of the three
    // (PRD §4.1, ADR 0005). Scoped to the canvas, because the right sidebar
    // carries the selected node's name too.
    const canvas = within(await screen.findByRole('region', { name: 'Steps' }))

    for (const name of ['Source', 'Style', 'Animate']) {
      expect(
        canvas.getByRole('heading', { name: new RegExp(`^${name}$`) })
      ).toBeVisible()
    }

    expect(canvas.getAllByRole('button', { name: /^Generate/ })).toHaveLength(3)

    // And the tab bar it replaced is gone rather than hidden.
    expect(
      screen.queryByRole('navigation', { name: /stages/i })
    ).not.toBeInTheDocument()
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
