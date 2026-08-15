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

describe('a treated candidate (#36)', () => {
  // A sibling of the block above rather than nested inside it, so it clears its
  // own mocks — a bake counted from the previous test is exactly the sort of
  // leak that makes "and not the other path" assertions lie.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Atlas, with a look on the style still the panel would export. */
  function treated(): Project {
    const base = withAssets()
    return {
      ...base,
      generations: base.generations.map(generation =>
        generation.id === 'gen-sty-2'
          ? {
              ...generation,
              treatment: {
                lookId: 'fx-halftone',
                values: { cell: 8 },
                lookModified: true,
              },
            }
          : generation
      ),
    }
  }

  it('offers to bake the treatment in, on by default', async () => {
    // On by default because a treated candidate whose export is clean is a
    // file that does not look like the thing that was approved.
    render(<ExportPanel project={treated()} stage="style" />)

    expect(
      await screen.findByRole('switch', { name: /Bake in Halftone/ })
    ).toBeChecked()
  })

  it('says nothing about treatments on an untreated candidate', async () => {
    render(<ExportPanel project={withAssets()} stage="style" />)

    await screen.findByRole('button', { name: 'Export' })
    expect(
      screen.queryByRole('switch', { name: /Bake in/ })
    ).not.toBeInTheDocument()
  })

  it('bakes rather than encoding the plate', async () => {
    render(<ExportPanel project={treated()} stage="style" />)

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(commands.beginBake).toHaveBeenCalledWith(
        expect.any(String),
        'project-atlas',
        'gen-sty-2',
        'web'
      )
    })
    // The untreated path is not also taken — one export, one set of files.
    expect(exportGeneration).not.toHaveBeenCalled()
  })

  it('exports at the web width until somebody asks for more', async () => {
    // The default is the file every landing page wanted before the control
    // existed. A size that had to be chosen every time would be a decision the
    // app already knows the answer to.
    render(<ExportPanel project={withAssets()} stage="animate" />)

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ size: 'web' })
      )
    })
  })

  it('sends the size that was chosen, to the bake that has to render it', async () => {
    // The bake is where a size costs something — Rust decodes the frames at it
    // and the shader draws at it — so this is the wiring worth pinning: the
    // choice reaches `beginBake`, which is the side that turns it into pixels.
    const user = userEvent.setup()
    render(<ExportPanel project={treated()} stage="style" />)

    await user.click(await screen.findByRole('combobox', { name: 'Size' }))
    await user.click(await screen.findByRole('option', { name: /2×/ }))
    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(commands.beginBake).toHaveBeenCalledWith(
        expect.any(String),
        'project-atlas',
        'gen-sty-2',
        'double'
      )
    })
  })

  it('will not offer 2× for a plate with nothing drawn on it', async () => {
    // Upscaling a clean plate is the same detail in four times the bytes. The
    // option stays on screen and refuses, rather than vanishing — a list that
    // silently loses an entry reads as a tool that cannot do it at all.
    const user = userEvent.setup()
    render(<ExportPanel project={treated()} stage="style" />)

    await user.click(await screen.findByRole('switch', { name: /Bake in/ }))
    await user.click(await screen.findByRole('combobox', { name: 'Size' }))

    expect(await screen.findByRole('option', { name: /2×/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('shows the wait before the decode comes back, not after', async () => {
    // `beginBake` is ffmpeg decoding every frame of the clip — seconds of it,
    // and the frame count that drives the bar does not exist until it returns.
    // A button waiting for that spends those seconds looking untouched, so the
    // press reads as missed and the next one starts a second bake.
    // Assigned by the executor below, which runs before this line returns.
    let decoded!: () => void
    vi.mocked(commands.beginBake).mockReturnValue(
      new Promise(resolve => {
        decoded = () =>
          resolve({
            status: 'ok',
            data: {
              id: 'bake-1',
              frames: ['/tmp/f-000000.png'],
              width: 1920,
              height: 1080,
              scale: 1,
              fps: null,
            },
          })
      })
    )

    render(<ExportPanel project={treated()} stage="style" />)

    const button = await screen.findByRole('button', { name: 'Export' })
    await userEvent.setup().click(button)

    // Still mid-decode: nothing has resolved, and the panel already says so.
    expect(commands.beginBake).toHaveBeenCalledOnce()
    expect(
      await screen.findByRole('button', { name: 'Encoding…' })
    ).toBeDisabled()
    expect(screen.getByText(/Reading the clip/i)).toBeVisible()

    decoded()
  })

  it('names the poster after the file it will actually write', async () => {
    // A treated poster ships as PNG — JPEG subsamples chroma, which is what
    // dissolves a two-ink dither. A box still saying JPEG would describe a file
    // that is not the one landing in the folder.
    render(<ExportPanel project={treated()} stage="style" />)

    expect(await screen.findByLabelText('Poster (PNG)')).toBeInTheDocument()

    // Off the treatment, it is a JPEG again: an untreated poster is
    // photographic, where PNG is several times the weight for no visible gain.
    await userEvent
      .setup()
      .click(screen.getByRole('switch', { name: /Bake in Halftone/ }))

    expect(await screen.findByLabelText('Poster (JPEG)')).toBeInTheDocument()
  })

  it('gives back the clean plate when the toggle is off', async () => {
    // "Hand the untreated image to someone else" is a real need, and without
    // the toggle the only way to get one would be to destroy the treatment.
    render(<ExportPanel project={treated()} stage="style" />)
    const user = userEvent.setup()

    const toggle = await screen.findByRole('switch', {
      name: /Bake in Halftone/,
    })
    await user.click(toggle)
    expect(toggle).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      expect(exportGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ generationId: 'gen-sty-2' })
      )
    })
    expect(commands.beginBake).not.toHaveBeenCalled()
  })
})
