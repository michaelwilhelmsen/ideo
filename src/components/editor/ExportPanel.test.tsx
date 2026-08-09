/**
 * The export panel (#31, PRD §8).
 *
 * What is worth asserting here rather than in `lib/export` is the wiring: that
 * the panel exports the candidate the *active stage* has selected, that it
 * sends the folder it remembered rather than asking again, and that a machine
 * with no ffmpeg gets an install prompt instead of a failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { ATLAS, type Project } from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { ExportPanel } from './ExportPanel'

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue('/Users/someone/site/public'),
}))

/** Atlas, with files on disk for the two candidates the tests export. */
function withAssets(): Project {
  return {
    ...ATLAS,
    generations: ATLAS.generations.map(generation => {
      if (generation.id === 'gen-ani-1') {
        return { ...generation, asset: 'gen-ani-1.mp4' }
      }
      if (generation.id === 'gen-sty-2') {
        return { ...generation, asset: 'gen-sty-2.png' }
      }
      return generation
    }),
  }
}

const exportGeneration = vi.mocked(commands.exportGeneration)
const ffmpegStatus = vi.mocked(commands.ffmpegStatus)

describe('ExportPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ffmpegStatus.mockResolvedValue({
      status: 'ok',
      data: {
        available: true,
        path: '/opt/homebrew/bin/ffmpeg',
        version: '8.0.1',
      },
    })
    exportGeneration.mockResolvedValue({
      status: 'ok',
      data: { files: ['atlas-hero-animate-1.mp4'] },
    })
  })

  it('exports the selected clip as all three files, to the remembered folder', async () => {
    render(<ExportPanel project={withAssets()} stage="animate" />)

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-atlas',
          generationId: 'gen-ani-1',
          // Remembered between runs (PRD §11) — nobody was asked to pick it.
          destination: '/tmp/exports',
          baseName: 'Atlas-hero-animate-1',
          mp4: true,
          webm: true,
          poster: true,
        })
      )
    })
  })

  /**
   * "Export works from the still stage as well as from video" (#31). The
   * boxes stay on screen so the panel does not look like a tool that cannot
   * make an MP4 (PRD §10.1) — they are simply not available here.
   */
  it('exports a still as a poster, with the video formats disabled', async () => {
    render(<ExportPanel project={withAssets()} stage="style" />)

    expect(await screen.findByLabelText(/MP4/)).toBeDisabled()
    expect(screen.getByLabelText(/WebM/)).toBeDisabled()
    expect(screen.getByLabelText(/Poster/)).toBeEnabled()

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          generationId: 'gen-sty-2',
          mp4: false,
          webm: false,
          poster: true,
        })
      )
    })
  })

  /**
   * "Export destination is remembered between runs" (#31), and PRD §11 puts it
   * app-wide because a folder is a place on this machine. Written back on
   * *success*, so a folder that could not be written to does not become the one
   * offered next time.
   */
  it('remembers a newly picked folder, after the export lands', async () => {
    const user = userEvent.setup()
    render(<ExportPanel project={withAssets()} stage="animate" />)

    await user.click(
      await screen.findByRole('button', { name: /choose folder/i })
    )
    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ destination: '/Users/someone/site/public' })
      )
    })
    await waitFor(() => {
      expect(vi.mocked(commands.savePreferences)).toHaveBeenCalledWith(
        expect.objectContaining({
          export_directory: '/Users/someone/site/public',
        })
      )
    })
  })

  it('does not remember a folder the export failed on', async () => {
    exportGeneration.mockResolvedValue({
      status: 'error',
      error: {
        reason: 'destinationUnusable',
        message: 'Read-only file system',
      },
    })

    const user = userEvent.setup()
    render(<ExportPanel project={withAssets()} stage="animate" />)

    await user.click(
      await screen.findByRole('button', { name: /choose folder/i })
    )
    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalled()
    })
    expect(vi.mocked(commands.savePreferences)).not.toHaveBeenCalled()
  })

  it('takes the rewind switch from what the recipe recorded', async () => {
    // Atlas's animate candidate was generated with `rewind: false` and
    // `loop: true` — a natively seamless clip.
    render(<ExportPanel project={withAssets()} stage="animate" />)

    const rewind = await screen.findByRole('switch', {
      name: /forward, then reverse/i,
    })
    expect(rewind).not.toBeChecked()

    // And it stays live: ping-pong is a post-process, so changing one's mind
    // costs an encode rather than a generation.
    await userEvent.setup().click(rewind)
    expect(rewind).toBeChecked()
    // The two mechanisms combine rather than conflict, and the redundancy is
    // said out loud rather than refused (#45).
    expect(
      screen.getByText(/already returns to its first frame/i)
    ).toBeVisible()
  })

  /**
   * The panel is not remounted when the stage tab or the project changes, so an
   * override has to expire with the candidate it was made about — otherwise
   * "rewind this one" quietly follows the user onto the next clip, whose recipe
   * says otherwise.
   */
  it('does not carry a rewind override onto another candidate', async () => {
    const project = withAssets()
    const { rerender } = render(
      <ExportPanel project={project} stage="animate" />
    )

    await userEvent
      .setup()
      .click(
        await screen.findByRole('switch', { name: /forward, then reverse/i })
      )
    expect(
      screen.getByRole('switch', { name: /forward, then reverse/i })
    ).toBeChecked()

    // A second clip, selected while the panel stays mounted.
    const first = project.generations.find(g => g.id === 'gen-ani-1')
    if (first === undefined) throw new Error('no animate fixture')

    const other = {
      ...project,
      generations: [
        ...project.generations,
        { ...first, id: 'gen-ani-2', ordinal: 2, asset: 'gen-ani-2.mp4' },
      ],
      selection: { ...project.selection, animate: 'gen-ani-2' },
    }
    rerender(<ExportPanel project={other} stage="animate" />)

    expect(
      screen.getByRole('switch', { name: /forward, then reverse/i })
    ).not.toBeChecked()
  })

  it('sends the rewind choice with the export', async () => {
    const user = userEvent.setup()
    render(<ExportPanel project={withAssets()} stage="animate" />)

    await user.click(
      await screen.findByRole('switch', { name: /forward, then reverse/i })
    )
    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ rewind: true })
      )
    })
  })

  it('offers the install prompt rather than a failure when ffmpeg is missing', async () => {
    ffmpegStatus.mockResolvedValue({
      status: 'ok',
      data: { available: false, path: null, version: null },
    })

    render(<ExportPanel project={withAssets()} stage="animate" />)

    expect(await screen.findByText(/brew install ffmpeg/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.getByText(/Install ffmpeg to export/i)).toBeVisible()
    // The one thing that fixes it has a button, so a `brew install` in another
    // window costs a click rather than a relaunch.
    expect(screen.getByRole('button', { name: /check again/i })).toBeEnabled()
    expect(exportGeneration).not.toHaveBeenCalled()
  })

  it('says there is nothing to export when the stage has no selection', async () => {
    const empty = {
      ...withAssets(),
      selection: { ...ATLAS.selection, animate: null },
    }

    render(<ExportPanel project={empty} stage="animate" />)

    expect(await screen.findByText(/nothing selected to export/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })

  it('refuses to run with every format switched off', async () => {
    const user = userEvent.setup()
    render(<ExportPanel project={withAssets()} stage="animate" />)

    for (const name of [/MP4/, /WebM/, /Poster/]) {
      await user.click(await screen.findByLabelText(name))
    }

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.getByText(/at least one file/i)).toBeVisible()
  })
})
