/**
 * The preview's context lifecycle.
 *
 * #36 is explicit that shader *output* has no automated seam — there is no GPU
 * on a CI runner, and a mocked shader only proves the mock works. This is not
 * that. What is asserted here is which canvas the context is attached to, which
 * is React lifecycle rather than pixels, and it is mocked at the GPU boundary
 * for the same reason `services` tests mock Tauri: the thing under test is the
 * hook's bookkeeping, not the driver's.
 *
 * It exists because of a bug that reached the maintainer: choose a look, switch
 * to None, choose a look again, and the preview stayed blank until the tab was
 * closed and reopened. The canvas is unmounted whenever the picture stops
 * coming from the shader, so "there is already a renderer" was the wrong
 * question — the right one is "is it attached to *this* canvas".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { lookById, type EffectsLook } from '@/lib/effects'
import { useEffectsPreview } from './use-effects-preview'

const dispose = vi.fn()
const renderFrame = vi.fn()
const createEffectsRenderer = vi.hoisted(() => vi.fn())

vi.mock('@/lib/effects/gl/renderer', () => ({
  supportsWebGL2: () => true,
  createEffectsRenderer,
}))

const HALFTONE = lookById('fx-halftone') as EffectsLook

/**
 * The tab's own shape, minimally: a canvas while there is a look, something
 * else when there is not. That swap is the whole bug.
 */
function Preview({ look }: { look: EffectsLook | null }) {
  const frame = useRef<HTMLDivElement>(null)
  const { canvas } = useEffectsPreview({
    frame,
    source: 'asset://frame.png',
    look,
    values: look === null ? null : { cell: 6 },
    inks: [],
    actualSize: false,
    enabled: true,
    isClip: false,
  })

  return (
    <div ref={frame}>
      {look === null ? (
        <img alt="the untreated plate" />
      ) : (
        <canvas ref={canvas} data-testid="preview" />
      )}
    </div>
  )
}

function Harness() {
  const [look, setLook] = useState<EffectsLook | null>(HALFTONE)

  return (
    <>
      <button onClick={() => setLook(null)}>None</button>
      <button onClick={() => setLook(HALFTONE)}>Halftone</button>
      <Preview look={look} />
    </>
  )
}

/**
 * Let the loop turn a few times.
 *
 * The frame loop only draws once the image has decoded, and the decode is a
 * macrotask away — so a single turn would assert against a loop that has run
 * before there was anything to draw.
 */
async function settle(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('the preview’s WebGL context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEffectsRenderer.mockImplementation((canvas: HTMLCanvasElement) => ({
      canvas,
      render: renderFrame,
      dispose,
    }))
    // jsdom has no rAF of its own, so the loop is driven by the macrotask
    // queue instead. It has to keep turning rather than run once: the first
    // turn happens before the image has decoded, and drawing is what the
    // second turn is for.
    vi.stubGlobal(
      'requestAnimationFrame',
      (draw: FrameRequestCallback) =>
        setTimeout(() => draw(0), 0) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle)
    )

    // jsdom never loads an image, and the loop draws nothing until one has
    // decoded. A real `<img>` is handed back so `instanceof` still holds where
    // the hook measures the frame's natural size.
    vi.stubGlobal('Image', function FakeImage() {
      const image = document.createElement('img')
      Object.defineProperty(image, 'naturalWidth', {
        value: 800,
        configurable: true,
      })
      Object.defineProperty(image, 'naturalHeight', {
        value: 450,
        configurable: true,
      })
      setTimeout(() => image.dispatchEvent(new Event('load')), 0)
      return image
    })
  })

  it('builds its context against the canvas that is actually mounted', async () => {
    render(<Harness />)
    await settle()

    expect(createEffectsRenderer).toHaveBeenCalledWith(
      screen.getByTestId('preview')
    )
  })

  it('rebinds after the canvas is unmounted and mounted again', async () => {
    // The reported bug: look → None → look left the renderer attached to a
    // detached canvas, so the new one stayed blank until the tab was reopened.
    const user = userEvent.setup()
    render(<Harness />)
    await settle()

    const first = screen.getByTestId('preview')

    await user.click(screen.getByRole('button', { name: 'None' }))
    await user.click(screen.getByRole('button', { name: 'Halftone' }))
    await settle()

    const second = screen.getByTestId('preview')
    expect(second).not.toBe(first)
    expect(createEffectsRenderer).toHaveBeenLastCalledWith(second)
    // And the old context is handed back rather than leaked — a WebGL context
    // per look switch is how a webview runs out of them.
    expect(dispose).toHaveBeenCalled()
  })

  it('draws into the new canvas even when nothing about the look changed', async () => {
    // The second half of the same bug. The loop skips a draw whose signature
    // matches the last one, and a fresh context has drawn nothing however
    // familiar the values look.
    const user = userEvent.setup()
    render(<Harness />)
    await settle()
    renderFrame.mockClear()

    await user.click(screen.getByRole('button', { name: 'None' }))
    await user.click(screen.getByRole('button', { name: 'Halftone' }))
    await settle()

    expect(renderFrame).toHaveBeenCalled()
  })

  it('does not rebuild the context while the canvas stays put', async () => {
    // The other direction: a context per render would exhaust the webview's
    // supply within a few seconds of dragging a slider.
    render(<Harness />)
    await settle()
    await settle()

    expect(createEffectsRenderer).toHaveBeenCalledTimes(1)
  })
})
