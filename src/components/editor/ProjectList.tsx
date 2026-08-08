/**
 * The left sidebar (PRD §10) — the project list, off disk.
 *
 * A persistent list rather than a gallery you navigate out of, so "swap the
 * style on that old hero" never means leaving what you are looking at. What
 * it lists comes from the SQLite index, which is why the sidebar does not
 * need every manifest parsed to draw itself.
 *
 * The footer is PRD §10.3's pressure valve: what the open project costs, and
 * a deliberate way to reclaim the part of it nothing points at.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProjectSummary } from '@/lib/recipe'
import {
  useCleanupAssets,
  useDeleteProject,
  useOpenProject,
  useProjectUsage,
} from '@/services/projects'
import { useEditorStore } from '@/store/editor-store'
import { NewProjectDialog } from './NewProjectDialog'

export function ProjectList() {
  const { t } = useTranslation()
  const summaries = useEditorStore(store => store.state.summaries)
  const openProjectId = useEditorStore(store => store.state.project?.id ?? null)
  const openProject = useOpenProject()

  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('editor.projects')}
        </h2>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setCreating(true)}
          title={t('editor.newProject.title')}
          aria-label={t('editor.newProject.title')}
        >
          <Plus />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2 pt-0">
        {summaries.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {t('editor.noProjects')}
          </p>
        ) : (
          summaries.map(summary => (
            <div
              key={summary.id}
              className={cn(
                'group flex items-start gap-1 rounded-md transition-colors hover:bg-accent',
                summary.id === openProjectId && 'bg-accent'
              )}
            >
              <button
                type="button"
                onClick={() => openProject(summary.id)}
                aria-current={summary.id === openProjectId}
                className="flex flex-1 cursor-pointer flex-col gap-1 px-2 py-2 text-start"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {summary.name}
                  </span>
                  {/* Locked at creation and never editable (PRD §4.4) — so it
                      reads as a property of the project, not a control. */}
                  <Badge variant="outline">{summary.aspect}</Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('editor.generationCount', {
                    count: summary.generationCount,
                  })}
                </span>
              </button>

              <Button
                size="icon"
                variant="ghost"
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => setDeleting(summary)}
                title={t('editor.action.deleteProject')}
                aria-label={t('editor.action.deleteProject', {
                  name: summary.name,
                })}
              >
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </div>

      <ProjectFootprint projectId={openProjectId} />

      <NewProjectDialog open={creating} onOpenChange={setCreating} />
      <DeleteProjectDialog
        project={deleting}
        onOpenChange={open => {
          if (!open) setDeleting(null)
        }}
      />
    </div>
  )
}

/**
 * What the open project costs, and the one action that reclaims any of it
 * (PRD §10.3).
 *
 * Nothing here deletes a candidate. Auto-deleting discards would be wrong —
 * "actually the second one was better" happens constantly and re-rolling costs
 * money — but unbounded growth on a laptop needs somewhere visible to push
 * back, and this is it.
 */
function ProjectFootprint({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation()
  const { data: usage } = useProjectUsage(projectId)
  const cleanup = useCleanupAssets()

  if (projectId === null || usage === undefined) return null

  return (
    <div className="space-y-1 border-t border-border px-4 py-3">
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

/**
 * Deleting a project is the one thing here that destroys a recipe, so it is
 * the one thing that asks twice.
 */
function DeleteProjectDialog({
  project,
  onOpenChange,
}: {
  project: ProjectSummary | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const remove = useDeleteProject()

  return (
    <AlertDialog open={project !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('editor.deleteProject.title', { name: project?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('editor.deleteProject.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('editor.action.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (project !== null) remove.mutate(project.id)
            }}
          >
            {t('editor.action.deleteProject')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
