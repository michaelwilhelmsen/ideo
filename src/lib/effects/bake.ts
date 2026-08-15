/**
 * Rendering a treatment into every frame of an export (#36).
 *
 * The loop lives here rather than in Rust because the shader does — one
 * program draws the preview and the export, so the file cannot disagree with
 * what was on screen. What Rust owns is the decode, the scratch folder and the
 * encode; what this owns is the picture.
 *
 * **Progress is determinate and cancel actually cancels**, and both fall out of
 * that arrangement rather than needing a channel: the frame count is known
 * before the first frame, and the thing doing the per-frame work is the thing
 * the user clicked cancel in. A model call can never be honest about a
 * percentage; this can.
 *
 * Pure of React on purpose. It takes a renderer, a reporter and a signal, and
 * anything that can drive those can drive a bake — which is what makes the
 * frame loop testable without a canvas.
 */

import type { EffectsLook, Ink, KnobValue } from '.'

/** How far along, in frames. */
export interface BakeProgress {
  readonly done: number
  readonly total: number
}

/** What one frame needs to become a treated PNG. */
export interface FrameJob {
  /** The webview URL of the frame to treat. */
  readonly source: string
  readonly index: number
  readonly width: number
  readonly height: number
  /**
   * Output pixels per look pixel (#58) — 1 for a web-sized export, 2 for a 2x
   * one. Carried per frame rather than closed over, so the thing that renders
   * a frame is handed everything that decides what the frame looks like.
   */
  readonly scale: number
}

export interface BakeDriver {
  /** Renders one frame and returns the PNG bytes. */
  treat(job: FrameJob): Promise<Uint8Array>
  /** Hands one treated frame to Rust. */
  store(index: number, png: Uint8Array): Promise<void>
  /** Called after every frame, so the bar moves while it works. */
  report(progress: BakeProgress): void
  /** True once the user has asked for this to stop. */
  cancelled(): boolean
}

/** The bake was cancelled — thrown so the caller unwinds rather than encodes. */
export class BakeCancelled extends Error {
  constructor() {
    super('The bake was cancelled')
    this.name = 'BakeCancelled'
  }
}

/**
 * Every frame, in order, treated and stored.
 *
 * Serial rather than concurrent, and that is a decision rather than an
 * omission: there is one WebGL context and one canvas, so two frames in flight
 * would be two writes to the same drawing buffer. The cost is bounded by the
 * shader, which is microseconds a frame; the encode either side of this is what
 * takes the time.
 *
 * Cancellation is checked **before** each frame rather than after, so a cancel
 * arriving during frame 40 of 120 costs that frame and not the rest.
 */
export async function bakeFrames(
  frames: readonly string[],
  size: {
    readonly width: number
    readonly height: number
    readonly scale: number
  },
  driver: BakeDriver
): Promise<void> {
  driver.report({ done: 0, total: frames.length })

  for (const [index, source] of frames.entries()) {
    if (driver.cancelled()) throw new BakeCancelled()

    const png = await driver.treat({
      source,
      index,
      width: size.width,
      height: size.height,
      scale: size.scale,
    })
    await driver.store(index, png)

    driver.report({ done: index + 1, total: frames.length })
  }
}

/**
 * What a canvas holds, as PNG bytes.
 *
 * `toBlob` rather than `toDataURL`: the data URL is base64 and would be a third
 * larger for no reason, on every frame of every clip.
 */
export async function canvasPng(
  canvas: HTMLCanvasElement
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => {
    canvas.toBlob(resolve, 'image/png')
  })
  if (blob === null) throw new Error('The canvas produced no image')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * An image element, once it has actually decoded.
 *
 * `crossOrigin` before `src`, and it is not optional: the frame comes from the
 * asset protocol, which is a different origin from the page, and an image
 * fetched without asking for CORS is tainted whatever headers come back.
 * WebGL refuses a tainted texture outright — `texImage2D` throws
 * `SecurityError` rather than drawing something wrong — so every frame of
 * every bake fails on upload. Setting it after `src` is the same bug, silently:
 * the load has already started under the old mode.
 */
export async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = source
  await image.decode()
  return image
}

/** Everything the shader needs that does not change between frames. */
export interface BakeLook {
  readonly look: EffectsLook
  readonly values: Readonly<Record<string, KnobValue>>
  readonly inks: readonly Ink[]
}
