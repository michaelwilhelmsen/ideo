/**
 * One project, as the front door shows it (#55).
 *
 * A picture, a name, a date and a cost. The picture is a generated thumbnail,
 * never the original (ADR 0004): the style stage emits 4.7–5.0 MB PNGs, and a
 * grid of twenty cards pointed at originals decodes on the order of a hundred
 * megabytes to draw pictures a few hundred pixels wide. A clip is a still frame
 * with a play affordance rather than a video element — twenty autoplaying
 * videos is twenty decoders.
 *
 * A clip *does* play, on hover, and that is the same argument rather than an
 * exception to it. What ADR 0004 refused was twenty at once; the pointer is
 * only ever on one card, so the decoder budget is one — and the clip is the
 * thing the project is, which a single frame of it can only hint at.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOff, MoreHorizontal, Play, Trash2, HardDrive } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { assetSource } from '@/components/editor/assets'
import type { ProjectSummary } from '@/lib/recipe'
import { cn } from '@/lib/utils'

/** Below this a real charge rounds to `$0.00`, which reads as free. */
const SMALLEST_SHOWN = 0.005

/**
 * How long the pointer has to stay on a card before its clip loads.
 *
 * Hover intent, not politeness. Without it, sweeping the mouse across the grid
 * to reach the *New project* button opens and abandons a decoder per card it
 * passes over — the original clip, not the thumbnail. A sixth of a second is
 * under what reads as lag and above what a moving pointer spends anywhere.
 */
const HOVER_INTENT_MS = 160

export function ProjectCard({
  summary,
  running,
  onOpen,
  onDelete,
  onInspect,
}: {
  summary: ProjectSummary
  /** How many of this project's jobs are in flight, from anywhere (ADR 0002). */
  running: number
  onOpen: () => void
  onDelete: () => void
  onInspect: () => void
}) {
  const { t, i18n } = useTranslation()
  const thumbnail = assetSource(summary.directory, summary.thumbnail)

  // The clip itself, which is the original rather than a thumbnail — there is
  // no shrunk copy of a video to point at, and this is why only the hovered
  // card ever holds one.
  const clip = summary.thumbnailIsVideo
    ? assetSource(summary.directory, summary.thumbnailAsset)
    : null
  const playing = useHoverIntent(clip !== null)

  return (
    <div
      className="group relative flex flex-col gap-2"
      onMouseEnter={playing.enter}
      onMouseLeave={playing.leave}
    >
      <button
        type="button"
        onClick={onOpen}
        // Focus plays it too, so the clip is not something only a mouse can
        // see. Same event pair the hover uses, so there is one way in and out.
        onFocus={playing.enter}
        onBlur={playing.leave}
        aria-label={summary.name}
        className="relative aspect-video w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {thumbnail === null ? (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-6 w-6" aria-hidden />
          </span>
        ) : (
          // `contain`, not `cover`. The card box is 16:9 and stays that way —
          // the overview is a grid, and a 9:16 card 1.8x the height of its
          // neighbours makes ragged rows of the whole page. But cropping a
          // portrait hero to a wide strip through this box throws away most of
          // the picture and shows a band of sky, which is the one thing a
          // thumbnail exists not to do. Letterboxing shows the shape instead,
          // and for a 16:9 project it is the same fit `cover` was.
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-contain"
          />
        )}

        {/* Over the poster rather than instead of it, so a clip that is slow to
            decode — or will not decode at all — shows its still frame the whole
            time rather than a hole where the card was. */}
        {playing.on && clip !== null && (
          <video
            src={clip}
            autoPlay
            muted
            loop
            playsInline
            // Decorative: the button beside it already names the project, and a
            // clip with no controls is not something to land on.
            aria-hidden
            tabIndex={-1}
            // Same fit as the poster underneath it, or the clip would jump to a
            // different framing the moment it started playing.
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}

        {/* A clip reads as a clip without being one — see the file comment.
            While it is actually playing the affordance has nothing left to
            promise, so it gets out of the way of the thing it advertised. */}
        {summary.thumbnailIsVideo && !playing.on && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-background/70 p-2 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-current" aria-hidden />
            </span>
          </span>
        )}

        {running > 0 && (
          <Badge
            variant="secondary"
            className="absolute start-2 top-2 gap-1.5 shadow-sm"
          >
            <Spinner className="h-3 w-3" />
            {t('overview.running', { count: running })}
          </Badge>
        )}
      </button>

      <div className="flex items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{summary.name}</span>
            {/* Locked at creation and never editable (PRD §4.4) — so it reads
                as a property of the project, not a control. */}
            <Badge variant="outline" className="shrink-0">
              {summary.aspect}
            </Badge>
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatDate(i18n.language, summary.latestActivityAt)}</span>
            <span aria-hidden>·</span>
            <span>{formatCost(t, i18n.language, summary)}</span>
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                'shrink-0 opacity-0 transition-opacity',
                'group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'
              )}
              title={t('overview.action.more', { name: summary.name })}
              aria-label={t('overview.action.more', { name: summary.name })}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onInspect}>
              <HardDrive />
              {t('overview.action.storage')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              {t('editor.action.deleteProject')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * Whether this card has been pointed at long enough to be meant.
 *
 * A hook rather than two `useState` calls in the card, because the timer has to
 * be cleared on the way out *and* on unmount: the grid re-renders whenever the
 * index does, and a pending timer that fires into an unmounted card would leave
 * a decoder running for a project no longer on screen.
 *
 * `enabled` is false for a card with no clip, which makes the whole thing inert
 * rather than making every caller ask first.
 */
function useHoverIntent(enabled: boolean) {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => clear, [])

  return {
    // Read through `enabled` rather than reset by an effect when it changes: a
    // card whose newest candidate stops being a clip must not go on playing
    // one, and answering that at the point of use costs no extra render.
    on: on && enabled,
    enter: () => {
      if (!enabled || timer.current !== null) return
      timer.current = setTimeout(() => {
        timer.current = null
        setOn(true)
      }, HOVER_INTENT_MS)
    },
    leave: () => {
      clear()
      setOn(false)
    },
  }
}

/** The day, in the user's own language (PRD §10.4). */
function formatDate(language: string, at: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(
    new Date(at)
  )
}

/**
 * What the project has cost so far, and how much of that is a claim rather than
 * a guess.
 *
 * Three readings, and the tilde is not decoration in any of them (ADR 0003):
 *
 * - **Exact.** Every generation carries fal's own `cost_total`. This is the
 *   only case with no tilde, and it is deliberately strict — one candidate
 *   still on its estimate is enough to make the total a forecast again.
 * - **Approximate.** Anything still on the price table's estimate: a call fal
 *   has not billed yet, or one older than the 90-day window and therefore
 *   permanently unreconcilable.
 * - **Unknown.** A generation with no figure at all — a token-priced model
 *   outside the window, or work recorded before costs were stamped. Counted and
 *   named rather than summed as zero, because "unknown" and "free" must not
 *   look the same, and a project of nothing else says so rather than `$0.00`.
 */
function formatCost(
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string,
  summary: ProjectSummary
): string {
  const costed = summary.generationCount - summary.uncostedCount
  if (costed === 0) return t('overview.cost.unknown')

  // The currency is fixed and the formatting is not: fal.ai bills in US dollars
  // wherever you are, but where the symbol goes is a fact about the language.
  const money = new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
  })

  const amount =
    summary.costUsd > 0 && summary.costUsd < SMALLEST_SHOWN
      ? t('editor.price.lessThan', { amount: money.format(0.01) })
      : money.format(summary.costUsd)

  if (summary.uncostedCount > 0) {
    return t('overview.cost.partial', { amount, count: summary.uncostedCount })
  }

  // Every generation, not merely every costed one — a fixture or an import has
  // a known cost and no request behind it, so it can never be confirmed, and a
  // project holding one keeps its tilde forever. That is the honest reading:
  // the figure is right, but nothing at fal will ever vouch for all of it.
  return summary.reconciledCount === summary.generationCount
    ? t('overview.cost.exact', { amount })
    : t('overview.cost.approximate', { amount })
}
