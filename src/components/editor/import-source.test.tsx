/**
 * The impure seam of an upload (#27) — the order the gates run in.
 *
 * The reducer and the aspect maths are checked in `src/lib/recipe`; what can
 * only be checked here is the *sequencing*, which is where the issue's two
 * "before" criteria live. A refusal that arrives after the upload was recorded
 * is not a refusal, it is a cleanup problem, so each of these asserts that the
 * reducer never heard about the file at all.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { LEDGER } from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { useImportSourceImage, baseName } from './import-source'
import { LEDGER_SOURCE_NODE, fixtureNode } from '../../lib/recipe/fixtures'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))

const dispatch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useEditorStore.setState({ dispatch })
})

/** LEDGER is a 16:9 project, so 1920×1080 is the shape it locked. */
function importing() {
  return renderHook(() =>
    useImportSourceImage(LEDGER, fixtureNode(LEDGER, LEDGER_SOURCE_NODE))
  ).result
}

describe('bringing in an image the user already has (#27)', () => {
  it('records an image of the project shape as a source candidate', async () => {
    vi.mocked(commands.importSourceImage).mockResolvedValue({
      status: 'ok',
      data: { assetName: 'gen-1.png', width: 1920, height: 1080 },
    })

    await importing().current.importPath('/Users/someone/Pictures/hero.png')

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'recordUpload',
          asset: 'gen-1.png',
          fileName: 'hero.png',
        })
      )
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('names the file after the generation, so the manifest and disk agree', async () => {
    vi.mocked(commands.importSourceImage).mockResolvedValue({
      status: 'ok',
      data: { assetName: 'gen-1.png', width: 1920, height: 1080 },
    })

    await importing().current.importPath('/tmp/hero.png')

    expect(commands.importSourceImage).toHaveBeenCalledWith(
      LEDGER.id,
      expect.any(String),
      '/tmp/hero.png'
    )

    const [, generationId] = vi.mocked(commands.importSourceImage).mock
      .lastCall ?? ['', '', '']
    // The id Rust names the file after is the id the reducer records.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recordUpload', generationId })
    )
  })

  it('refuses a shape the project did not lock, before recording anything', async () => {
    // A 3:2 photograph in a 16:9 project is the wrong picture for every stage
    // after it, and the video model at the end is the pickiest of the lot.
    vi.mocked(commands.importSourceImage).mockResolvedValue({
      status: 'ok',
      data: { assetName: 'gen-1.jpeg', width: 3000, height: 2000 },
    })

    await importing().current.importPath('/tmp/photo.jpg')

    expect(toast.error).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("says why Rust refused a file, and doesn't record it either", async () => {
    vi.mocked(commands.importSourceImage).mockResolvedValue({
      status: 'error',
      error: {
        reason: 'tooLarge',
        detail: '99999999',
        maxBytes: 30 * 1024 * 1024,
      },
    })

    await importing().current.importPath('/tmp/huge.png')

    expect(toast.error).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('the name shown for an uploaded file', () => {
  it('is the file, not the folders above it, on either platform', () => {
    expect(baseName('/Users/someone/Pictures/hero.png')).toBe('hero.png')
    expect(baseName('C:\\Users\\someone\\hero.png')).toBe('hero.png')
    expect(baseName('hero.png')).toBe('hero.png')
  })
})
