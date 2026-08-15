/**
 * What a project costs on disk, and the one action that reclaims any of it
 * (PRD §10.3).
 *
 * Same behaviour it had in the sidebar's footer, new home (#55). The overview
 * is where projects are managed now — created, sized, cleaned up, deleted —
 * leaving the editor purely where they are made.
 *
 * Nothing here deletes a candidate. Auto-deleting discards would be wrong —
 * "actually the second one was better" happens constantly and re-rolling costs
 * money — but unbounded growth on a laptop needs somewhere visible to push
 * back, and this is it. What it reports now includes the card thumbnails
 * beside the originals (ADR 0004): a footprint that ignored them would not
 * match the folder, and a cleanup that did not know about them would offer to
 * reclaim every picture the overview draws.
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useCleanupAssets, useProjectUsage } from '@/services/projects'

export function ProjectFootprint({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation()
  const { data: usage } = useProjectUsage(projectId)
  const cleanup = useCleanupAssets()

  if (projectId === null || usage === undefined) return null

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-xs text-muted-foreground">
        {t('editor.usage.total', { size: formatBytes(usage.totalBytes) })}
      </p>

      {usage.unusedCount > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {t('editor.usage.unused', {
              count: usage.unusedCount,
              size: formatBytes(usage.unusedBytes),
            })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={cleanup.isPending}
            onClick={() => cleanup.mutate(projectId)}
          >
            {t('editor.action.cleanUp')}
          </Button>
        </>
      )}
    </div>
  )
}

/** Bytes as something a person reads. Binary units, since disks report them. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
