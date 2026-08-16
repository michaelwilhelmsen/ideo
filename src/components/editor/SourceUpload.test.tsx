/**
 * The drop seam (#27) — the part of an upload that is not the import.
 *
 * Tauri hands the whole window every drag, so what is checked here is the two
 * judgements this component makes before `useImportSourceImage` is allowed to
 * see anything: *was it dropped on us*, and *is it one file*. Both used to be
 * answered "yes" unconditionally.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { toast } from 'sonner'
import { render } from '@/test/test-utils'
import { LEDGER } from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { isWithinDropZone } from './drop-zone'
import { SourceUpload } from './SourceUpload'
import {
  ATLAS,
  ATLAS_SOURCE_NODE,
  fixtureNode,
} from '../../lib/recipe/fixtures'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

type DragDropEvent = Parameters<
  Parameters<ReturnType<typeof getCurrentWebview>['onDragDropEvent']>[0]
>[0]

const dispatch = vi.fn()

/** The panel, placed at a known rectangle jsdom would otherwise report as 0×0. */
const PANEL = { left: 100, top: 100, right: 300, bottom: 200 }

beforeEach(() => {
  vi.clearAllMocks()
  useEditorStore.setState({ dispatch })

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...PANEL,
    width: PANEL.right - PANEL.left,
    height: PANEL.bottom - PANEL.top,
    x: PANEL.left,
    y: PANEL.top,
    toJSON: () => ({}),
  })

  vi.mocked(commands.importSourceImage).mockResolvedValue({
    status: 'ok',
    data: { assetName: 'gen-1.png', width: 1920, height: 1080 },
  })
})

/** Renders the panel and hands back the OS listener it registered. */
async function mountedPanel(): Promise<(event: DragDropEvent) => void> {
  let handler: ((event: DragDropEvent) => void) | undefined

  vi.mocked(getCurrentWebview).mockReturnValue({
    onDragDropEvent: (fn: (event: DragDropEvent) => void) => {
      handler = fn
      return Promise.resolve(() => undefined)
    },
  } as unknown as ReturnType<typeof getCurrentWebview>)

  render(
    <SourceUpload
      node={fixtureNode(ATLAS, ATLAS_SOURCE_NODE)}
      project={LEDGER}
    />
  )
  await vi.waitFor(() => expect(handler).toBeDefined())

  return handler as (event: DragDropEvent) => void
}

function drop(paths: string[], x: number, y: number): DragDropEvent {
  return {
    event: 'tauri://drag-drop',
    id: 1,
    payload: { type: 'drop', paths, position: { x, y } },
  } as unknown as DragDropEvent
}

describe('isWithinDropZone', () => {
  it('accepts a position inside the rectangle', () => {
    expect(isWithinDropZone(PANEL, { x: 200, y: 150 }, 1)).toBe(true)
  })

  it('rejects one outside it', () => {
    expect(isWithinDropZone(PANEL, { x: 40, y: 150 }, 1)).toBe(false)
    expect(isWithinDropZone(PANEL, { x: 200, y: 900 }, 1)).toBe(false)
  })

  it('converts physical pixels before comparing, so Retina is not all top-left', () => {
    // 400×300 physical on a 2× display is 200×150 in CSS pixels — inside.
    expect(isWithinDropZone(PANEL, { x: 400, y: 300 }, 2)).toBe(true)
    // ...and the same numbers taken literally would fall past the right edge.
    expect(isWithinDropZone(PANEL, { x: 400, y: 300 }, 1)).toBe(false)
  })

  it('treats a nonsense scale factor as 1 rather than dividing by zero', () => {
    expect(isWithinDropZone(PANEL, { x: 200, y: 150 }, 0)).toBe(true)
  })
})

describe('dropping a file on the source panel (#27)', () => {
  it('imports one image dropped on the panel', async () => {
    const handler = await mountedPanel()

    handler(drop(['/Users/someone/Pictures/hero.png'], 200, 150))

    await vi.waitFor(() => {
      expect(commands.importSourceImage).toHaveBeenCalledWith(
        LEDGER.id,
        expect.any(String),
        '/Users/someone/Pictures/hero.png'
      )
    })
  })

  it('ignores a drop that landed somewhere else in the window', async () => {
    const handler = await mountedPanel()

    handler(drop(['/Users/someone/Pictures/hero.png'], 900, 900))

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(commands.importSourceImage).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('refuses a multi-file drop out loud rather than silently taking the first', async () => {
    const handler = await mountedPanel()

    handler(drop(['/pics/one.png', '/pics/two.png'], 200, 150))

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('one image at a time')
      )
    })
    expect(commands.importSourceImage).not.toHaveBeenCalled()
  })
})
