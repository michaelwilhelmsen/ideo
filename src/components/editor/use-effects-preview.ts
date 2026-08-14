/**
 * The live half of the effects tab: one WebGL2 context, kept fed.
 *
 * A hook rather than logic in the component because three things here outlive a
 * render and have to be torn down — the context, the media element and the
 * animation frame — and React's rules about that are clearer than a component
 * that quietly leaks a video decoder every time you switch candidates.
 *
 * **A clip plays with the effect on it**, which is the only way pattern crawl is
 * visible at all. The `<video>` is created here rather than rendered, because it
 * is a texture source and not something the user should see: what they see is
 * the canvas.
 *
 * **One animation frame drives everything, and nothing here is React state.**
 * The context, the media and the last-drawn signature are all refs, and the loop
 * compares that signature before drawing — so a still is drawn once and then the
 * loop idles, and a clip redraws every frame because its texture changed. That
 * is deliberate rather than incidental: the alternative is a `setState` per
 * asset load and per context creation, which is a cascading render for
 * something React is not displaying.
 *
 * The render size is the whole of what "fit versus 1:1" means. The pattern is
 * measured in output pixels, so drawing at the size actually on screen makes 1:1
 * *exact* rather than an upscaled approximation of a smaller render — which is
 * why the superseded CPU plan had to label its diffusion preview "approximate"
 * and this does not.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  createEffectsRenderer,
  supportsWebGL2,
  type EffectsRenderer,
  type EffectSource,
} from '@/lib/effects/gl/renderer'
import type { EffectsLook, Ink, KnobValue } from '@/lib/effects'

export interface EffectsPreview {
  readonly canvas: RefObject<HTMLCanvasElement | null>
  /** No WebGL2 in this webview — the tab says so rather than drawing black. */
  readonly unsupported: boolean
}

export function useEffectsPreview({
  frame,
  source,
  look,
  values,
  inks,
  actualSize,
  enabled,
  isClip,
}: {
  frame: RefObject<HTMLDivElement | null>
  source: string | null
  look: EffectsLook | null
  values: Readonly<Record<string, KnobValue>> | null
  inks: readonly Ink[]
  actualSize: boolean
  enabled: boolean
  isClip: boolean
}): EffectsPreview {
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<EffectsRenderer | null>(null)
  const media = useRef<EffectSource | null>(null)
  const drawn = useRef<string | null>(null)

  // Asked once, at mount, rather than in an effect: whether this webview has
  // WebGL2 cannot change while the app is open, and a lazy initialiser is not a
  // state update.
  const [unsupported] = useState(() => !supportsWebGL2())

  // ── The media element ─────────────────────────────────────────────────────
  useEffect(() => {
    media.current = null
    drawn.current = null
    if (source === null) return

    if (isClip) {
      const video = document.createElement('video')
      video.src = source
      video.muted = true
      video.loop = true
      video.playsInline = true
      // Not appended to the document: it is a texture source, and what the user
      // watches is the canvas the shader draws into.
      video.addEventListener('loadeddata', () => {
        media.current = video
      })
      void video.play().catch(() => {
        // A webview that refuses to autoplay still decodes the first frame, so
        // the preview is a still of a clip rather than nothing.
      })

      return () => {
        media.current = null
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }

    const image = new Image()
    image.src = source
    image.addEventListener('load', () => {
      media.current = image
    })

    return () => {
      media.current = null
      image.src = ''
    }
  }, [source, isClip])

  // ── The context, and the loop that feeds it ───────────────────────────────
  useEffect(() => {
    if (!enabled || unsupported || look === null || values === null) return

    let handle = 0
    let stopped = false

    const tick = (): void => {
      if (stopped) return

      const from = media.current
      const surface = canvas.current

      if (from !== null && surface !== null) {
        if (renderer.current === null) {
          renderer.current = createEffectsRenderer(surface)
        }

        const active = renderer.current
        if (active !== null) {
          const [width, height] = sizeOf(from, frame.current, actualSize)
          // A clip's texture changes every frame; a still's does not, so the
          // same picture is not redrawn sixty times a second on a laptop
          // battery. The signature is everything that changes the output.
          const signature = `${look.id}|${width}x${height}|${JSON.stringify(values)}|${inks.map(ink => ink.hex).join(',')}`

          if (isClip || drawn.current !== signature) {
            active.render({ source: from, look, values, inks, width, height })
            drawn.current = signature
          }
        }
      }

      handle = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      stopped = true
      if (handle !== 0) cancelAnimationFrame(handle)
    }
  }, [enabled, unsupported, look, values, inks, actualSize, isClip, frame])

  // The context itself outlives every one of those dependencies and is released
  // when the tab goes away — a WebGL context per look switch is how a webview
  // runs out of them.
  useEffect(
    () => () => {
      renderer.current?.dispose()
      renderer.current = null
    },
    []
  )

  return { canvas, unsupported }
}

/**
 * How big to draw, in output pixels.
 *
 * At 1:1 that is the media's own size, so a dither cell is one screen pixel
 * across and can be judged. At fit it is the width the frame actually offers,
 * because a pattern rendered at one size and scaled to another is a different
 * pattern — the same argument that makes the bake render at the export
 * resolution rather than before the width cap.
 */
function sizeOf(
  source: EffectSource,
  frame: HTMLDivElement | null,
  actualSize: boolean
): readonly [number, number] {
  const natural = naturalSizeOf(source)
  if (actualSize || frame === null) return natural

  const available = frame.clientWidth
  if (available <= 0 || natural[0] <= 0) return natural

  const scale = Math.min(1, available / natural[0])
  return [Math.round(natural[0] * scale), Math.round(natural[1] * scale)]
}

function naturalSizeOf(source: EffectSource): readonly [number, number] {
  if (source instanceof HTMLVideoElement) {
    return [source.videoWidth, source.videoHeight]
  }
  if (source instanceof HTMLImageElement) {
    return [source.naturalWidth, source.naturalHeight]
  }
  return [source.width, source.height]
}
