/**
 * One project, as the front door shows it (#55).
 *
 * A picture, a name, a date and a cost. The picture is a generated thumbnail,
 * never the original (ADR 0004): the style stage emits 4.7–5.0 MB PNGs, and a
 * grid of twenty cards pointed at originals decodes on the order of a hundred
 * megabytes to draw pictures a few hundred pixels wide. A clip is a still frame
 * with a play affordance rather than a video element — twenty autoplaying
 * videos is twenty decoders.
 */

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

  return (
    <div className="group relative flex flex-col gap-2">
      <button
        type="button"
        onClick={onOpen}
        aria-label={summary.name}
        className="relative aspect-video w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {thumbnail === null ? (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-6 w-6" aria-hidden />
          </span>
        ) : (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        )}

        {/* A clip reads as a clip without being one — see the file comment. */}
        {summary.thumbnailIsVideo && (
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

/** The day, in the user's own language (PRD §10.4). */
function formatDate(language: string, at: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(
    new Date(at)
  )
}

/**
 * What the project has cost so far — approximate, and saying so.
 *
 * The tilde is not decoration. Every figure here is the price table's estimate
 * stamped at collection (ADR 0003), never a charge fal confirmed, and it stays
 * that way until reconciliation lands. A project whose generations carry no
 * price at all says nothing rather than `$0.00`: "unknown" and "free" must not
 * look the same.
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

  return summary.uncostedCount > 0
    ? t('overview.cost.partial', { amount, count: summary.uncostedCount })
    : t('overview.cost.approximate', { amount })
}
