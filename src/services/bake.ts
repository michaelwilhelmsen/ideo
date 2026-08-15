/**
 * The export panel's half of a bake (#36).
 *
 * A mutation rather than a query, because a bake is a thing you ask for once and
 * it writes files. What it does *not* delegate is the frame loop: the shader
 * that drew the preview has to draw the export, so the rendering happens here in
 * the webview and `lib/effects/bake.ts` holds the loop itself, pure.
 *
 * Progress and cancellation live in this hook's own state for the same reason:
 * this is the code doing the per-frame work, so a determinate bar and a cancel
 * that stops are what it already knows rather than a channel it has to open.
 */

import { useCallback, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import {
  bakeFrames,
  BakeCancelled,
  canvasPng,
  isDiffusionKernel,
  loadImage,
  type BakeProgress,
  type EffectsLook,
  type Ink,
  type KnobValue,
} from '@/lib/effects'
import { createEffectsRenderer } from '@/lib/effects/gl/renderer'
import { logger } from '@/lib/logger'
import {
  commands,
  type ExportError,
  type ExportRequest,
  type ExportOutcome,
} from '@/lib/tauri-bindings'
import { explain } from './export'

export interface BakeRequest {
  readonly request: ExportRequest
  readonly look: EffectsLook
  readonly values: Readonly<Record<string, KnobValue>>
  readonly inks: readonly Ink[]
}

export interface Baking {
  /** Runs a whole bake. Resolves with what was written, or `null` if cancelled. */
  run: (request: BakeRequest) => Promise<ExportOutcome | null>
  /**
   * Whether a bake is under way at all.
   *
   * Separate from `progress`, and the gap between the two is the whole reason
   * it exists: the first frame cannot be reported until ffmpeg has decoded
   * every frame of the clip, which is seconds. A button watching `progress`
   * spends those seconds looking untouched — so the click appears to have
   * missed, and the second one starts a second bake over the first.
   */
  running: boolean
  /** Frames done and frames total, or `null` before the first frame. */
  progress: BakeProgress | null
  cancel: () => void
}

export function useBake(): Baking {
  const [progress, setProgress] = useState<BakeProgress | null>(null)
  const [running, setRunning] = useState(false)
  const cancelled = useRef(false)

  const cancel = useCallback(() => {
    cancelled.current = true
  }, [])

  const bakeOnce = useCallback(
    async (bake: BakeRequest): Promise<ExportOutcome | null> => {
      cancelled.current = false
      // A session id minted here rather than in Rust, so the cancel path has
      // something to name even if `beginBake` never comes back.
      const sessionId = crypto.randomUUID()

      const opened = await commands.beginBake(
        sessionId,
        bake.request.projectId,
        bake.request.generationId,
        // The size the panel asked for. Rust owns what it means in pixels —
        // it is the side that knows how big the source is — and hands back the
        // dimensions and the pattern scale that follow from it.
        bake.request.size
      )
      if (opened.status === 'error') {
        failed(opened.error)
        return null
      }

      const session = opened.data
      // Off-document: this canvas is a render target, not something to look at.
      const canvas = document.createElement('canvas')
      const renderer = createEffectsRenderer(canvas)

      // Every diffusion frame is a round trip to Rust, and on a clip those two
      // kernels are disabled anyway — so the CPU path is only ever one still.
      const onCpu =
        typeof bake.values.kernel === 'string' &&
        isDiffusionKernel(bake.values.kernel)

      if (renderer === null && !onCpu) {
        logger.error('A bake failed', { error: new Error('no WebGL2') })
        toast.error(i18n.t('export.error.noRenderer'))
        await commands.cancelBake(sessionId)
        return null
      }

      try {
        await bakeFrames(
          session.frames,
          {
            width: session.width,
            height: session.height,
            scale: session.scale,
          },
          {
            treat: async job => {
              if (onCpu) {
                const treated = await commands.renderTreatedStill(
                  bake.request.projectId,
                  bake.request.generationId,
                  {
                    inks: bake.inks.map(ink => ink.hex),
                    kernel: bake.values.kernel as 'floydSteinberg' | 'atkinson',
                    paletteShaped: bake.values.levelPlacement !== 'even',
                  }
                )
                if (treated.status === 'error') {
                  throw new BakeFailure({
                    reason: 'encodeFailed',
                    deliverable: 'bake',
                    detail: treated.error.reason,
                  })
                }
                return new Uint8Array(treated.data)
              }

              // The frames are on disk in the bake's scratch folder, so they
              // arrive as textures through the asset protocol — the
              // alternative is ~11 MB per frame over IPC. That folder is in
              // `assetProtocol.scope` for this reason and no other; without it
              // every clip bake dies on the first frame.
              const image = await loadImage(convertFileSrc(job.source))
              renderer?.render({
                source: image,
                look: bake.look,
                values: bake.values,
                inks: bake.inks,
                width: job.width,
                height: job.height,
                scale: job.scale,
              })
              return canvasPng(canvas)
            },

            store: async (index, png) => {
              const written = await commands.writeBakedFrame(
                sessionId,
                index,
                Array.from(png)
              )
              if (written.status === 'error') {
                throw new BakeFailure(written.error)
              }
            },

            report: setProgress,
            cancelled: () => cancelled.current,
          }
        )

        const finished = await commands.finishBake(
          sessionId,
          session.fps,
          bake.request
        )
        if (finished.status === 'error') {
          failed(finished.error)
          return null
        }

        return finished.data
      } catch (error) {
        // Cancelling is not a failure and gets no message — the user asked.
        if (!(error instanceof BakeCancelled)) {
          failed(carried(error))
        }
        await commands.cancelBake(sessionId)
        return null
      } finally {
        renderer?.dispose()
        setProgress(null)
      }
    },
    []
  )

  /**
   * The same bake, with the flag raised for all of it.
   *
   * Raised here rather than inside, and before the first `await`, so it is set
   * in the click's own turn — the button changes on the press instead of once
   * the decode comes back. Lowered in a `finally`, because every way out of a
   * bake ends with nothing running: written, refused, thrown or cancelled.
   */
  const run = useCallback(
    async (bake: BakeRequest): Promise<ExportOutcome | null> => {
      setRunning(true)
      try {
        return await bakeOnce(bake)
      } finally {
        setRunning(false)
      }
    },
    [bakeOnce]
  )

  return { run, running, progress, cancel }
}

/**
 * An `ExportError` on its way out through a `throw`.
 *
 * The frame loop is driven by callbacks that can only fail by throwing, and an
 * `Error` built from `error.reason` arrives at the toast as the sentence for
 * "something went wrong" — which is how a full disk and a folder that vanished
 * mid-bake both came out as *The export did not finish*. The error rides along
 * whole instead, so the one place that turns errors into sentences still has
 * one to work with.
 */
class BakeFailure extends Error {
  constructor(readonly failure: ExportError) {
    super(failure.reason)
    this.name = 'BakeFailure'
  }
}

/** Whatever was thrown, as something `explain` can speak for. */
function carried(error: unknown): ExportError | Error {
  if (error instanceof BakeFailure) return error.failure
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Says what went wrong, once.
 *
 * Not `report`, which takes a key and translates it with no values: every
 * sentence a failed bake has to say is one the export panel already says, and
 * two of those carry a detail — handed the key alone they reach the toast with
 * `{{file}}` and `{{detail}}` still in them.
 */
function failed(error: ExportError | Error): void {
  logger.error('A bake failed', { error })
  toast.error(explain(error))
}
