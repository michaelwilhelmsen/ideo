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
  type ExportRequest,
  type ExportOutcome,
} from '@/lib/tauri-bindings'
import { report } from './report'

export interface BakeRequest {
  readonly request: ExportRequest
  readonly look: EffectsLook
  readonly values: Readonly<Record<string, KnobValue>>
  readonly inks: readonly Ink[]
}

export interface Baking {
  /** Runs a whole bake. Resolves with what was written, or `null` if cancelled. */
  run: (request: BakeRequest) => Promise<ExportOutcome | null>
  /** Frames done and frames total, or `null` when nothing is baking. */
  progress: BakeProgress | null
  cancel: () => void
}

export function useBake(): Baking {
  const [progress, setProgress] = useState<BakeProgress | null>(null)
  const cancelled = useRef(false)

  const cancel = useCallback(() => {
    cancelled.current = true
  }, [])

  const run = useCallback(
    async (bake: BakeRequest): Promise<ExportOutcome | null> => {
      cancelled.current = false
      // A session id minted here rather than in Rust, so the cancel path has
      // something to name even if `beginBake` never comes back.
      const sessionId = crypto.randomUUID()

      const opened = await commands.beginBake(
        sessionId,
        bake.request.projectId,
        bake.request.generationId
      )
      if (opened.status === 'error') {
        report('export.error.encodeFailed', new Error(opened.error.reason))
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
        report('export.error.encodeFailed', new Error('no WebGL2'))
        await commands.cancelBake(sessionId)
        return null
      }

      try {
        await bakeFrames(
          session.frames,
          { width: session.width, height: session.height },
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
                  throw new Error(treated.error.reason)
                }
                return new Uint8Array(treated.data)
              }

              // The frames are on disk inside the project scope, so they arrive
              // as textures through the asset protocol — the alternative is
              // ~11 MB per frame over IPC.
              const image = await loadImage(convertFileSrc(job.source))
              renderer?.render({
                source: image,
                look: bake.look,
                values: bake.values,
                inks: bake.inks,
                width: job.width,
                height: job.height,
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
                throw new Error(written.error.reason)
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
          report('export.error.encodeFailed', new Error(finished.error.reason))
          return null
        }

        return finished.data
      } catch (error) {
        // Cancelling is not a failure and gets no message — the user asked.
        if (!(error instanceof BakeCancelled)) {
          logger.error('A bake failed', { error })
          report('export.error.encodeFailed', error)
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

  return { run, progress, cancel }
}
