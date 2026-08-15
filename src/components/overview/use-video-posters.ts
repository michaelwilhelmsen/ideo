/**
 * Posters for the clips on the overview (ADR 0004).
 *
 * The one thumbnail Rust cannot make. Capturing a frame needs a video decoder,
 * and the webview already has one — the alternative is an ffmpeg-class
 * dependency for a single frame. So a card whose picture is a clip with no
 * poster yet gets one drawn here: an offscreen `<video>`, a seek, a canvas, and
 * a round trip to be filed beside the asset.
 *
 * This is the fragile part of ADR 0004 and it is written to fail quietly. A
 * seek that never resolves, a codec the webview will not decode, a canvas the
 * platform taints — each of those leaves the card without a picture, which is a
 * card the user can still click. Nothing here may keep the overview from
 * drawing. If it proves unreliable in practice, the documented fallback is the
 * original with `preload="metadata"`.
 *
 * Nothing is retried within a session: one failed capture per launch, so a clip
 * this build cannot decode does not spin the decoder every time the list
 * refreshes.
 */

import { useEffect, useRef } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { logger } from '@/lib/logger'
import type { ProjectSummary } from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'

/** Where in the clip the frame comes from, as a fraction of its length. */
const SEEK_FRACTION = 0.1

/** How long a capture may take before it is abandoned. */
const TIMEOUT_MS = 8_000

/** The longest edge a captured frame is drawn at, before Rust shrinks it. */
const CAPTURE_EDGE = 960

/**
 * Draws and files a poster for every clip-fronted card that has none.
 *
 * `onCaptured` fires once per successful capture so the caller can re-read the
 * index — the thumbnail's path lives there, and nothing else moves it.
 */
export function useVideoPosters(
  summaries: readonly ProjectSummary[],
  onCaptured: () => void
): void {
  const attempted = useRef<Set<string>>(new Set())

  useEffect(() => {
    const wanted = summaries.filter(
      summary =>
        summary.thumbnail === null &&
        summary.thumbnailIsVideo &&
        summary.thumbnailAsset !== null &&
        !attempted.current.has(`${summary.id}:${summary.thumbnailAsset}`)
    )
    if (wanted.length === 0) return

    let cancelled = false

    const run = async () => {
      for (const summary of wanted) {
        const asset = summary.thumbnailAsset
        if (cancelled || asset === null) return
        attempted.current.add(`${summary.id}:${asset}`)

        try {
          const frame = await captureFrame(
            convertFileSrc(`${summary.directory}/assets/${asset}`)
          )
          const saved = await commands.saveVideoPoster(summary.id, asset, [
            ...frame,
          ])
          if (saved.status === 'error') throw new Error(saved.error)
          if (!cancelled) onCaptured()
        } catch (error: unknown) {
          // A card without a picture is still a card. See the file comment.
          logger.warn('Could not capture a poster for a clip', {
            projectId: summary.id,
            asset,
            error,
          })
        }
      }
    }

    run().catch(() => {
      // Every failure is already handled per clip; this is the loop itself.
    })

    return () => {
      cancelled = true
    }
  }, [summaries, onCaptured])
}

/** One frame of a clip, as JPEG bytes. */
async function captureFrame(source: string): Promise<Uint8Array> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = source

  try {
    await seek(video)

    const scale = Math.min(
      1,
      CAPTURE_EDGE / Math.max(video.videoWidth, video.videoHeight)
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))

    const context = canvas.getContext('2d')
    if (context === null) throw new Error('No 2D context for the poster')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.82)
    })
    if (blob === null) throw new Error('The canvas produced no image')

    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    // Otherwise the element keeps the file open and the decoder alive for as
    // long as the webview feels like holding it.
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * Loads the clip far enough to have a frame, a little way in.
 *
 * A little way in rather than at zero: the first frame of a generated clip is
 * routinely black, and a grid of black rectangles is worse than no pictures at
 * all.
 */
function seek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for a frame'))
    }, TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }

    const onLoaded = () => {
      const at = Number.isFinite(video.duration)
        ? video.duration * SEEK_FRACTION
        : 0

      // A clip too short to seek into is already showing the frame we want.
      if (at <= 0) {
        cleanup()
        resolve()
        return
      }

      video.currentTime = at
    }

    const onSeeked = () => {
      cleanup()
      resolve()
    }

    const onError = () => {
      cleanup()
      reject(new Error('The clip would not decode'))
    }

    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.load()
  })
}
