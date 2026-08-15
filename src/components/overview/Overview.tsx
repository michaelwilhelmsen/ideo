/**
 * The front door (#55) — a grid of project cards, updating as work lands.
 *
 * What used to be here was a text list in a sidebar beside the editor. The
 * trade this makes is real and was the riskiest thing about the design: a
 * full-swap front door costs an interaction on every launch before work can
 * start. What it buys is that results arriving anywhere are visible from
 * anywhere, rather than only inside the project you happen to be in.
 *
 * The overview **reads** projects; it does not create work (ADR 0001). It shows
 * what exists, and creating a project stays an explicit act — which is why the
 * *New project* action has a home here now that the sidebar that used to host
 * it is gone. Typing a prompt with no project chosen, and a project appearing
 * around it, is a different decision and was declined there.
 *
 * It is also the one view allowed to write to manifests of projects nobody is
 * looking at (ADR 0002), which is what makes a card an arrival rather than a
 * status readout.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { NewProjectDialog } from '@/components/editor/NewProjectDialog'
import type { ProjectSummary } from '@/lib/recipe'
import { useCostReconciliation } from '@/services/billing'
import { useOverviewCollection, useRunningEverywhere } from '@/services/jobs'
import {
  projectKeys,
  useDeleteProject,
  useOpenProject,
  useProjects,
} from '@/services/projects'
import { useEditorStore } from '@/store/editor-store'
import { useUIStore } from '@/store/ui-store'
import { useQueryClient } from '@tanstack/react-query'
import { ProjectCard } from './ProjectCard'
import { ProjectFootprint } from './ProjectFootprint'
import { useVideoPosters } from './use-video-posters'

export function Overview() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: summaries } = useProjects()
  const openProject = useOpenProject()
  const setView = useUIStore(state => state.setView)

  // In the store because onboarding's last step opens it (#32).
  const creating = useUIStore(state => state.newProjectOpen)
  const setCreating = useUIStore(state => state.setNewProjectOpen)

  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const [inspecting, setInspecting] = useState<ProjectSummary | null>(null)

  // Both live and die with this component: ADR 0002 widened what a view may
  // do, and the widening is scoped to the front door by being mounted here and
  // nowhere else.
  const running = useRunningEverywhere()
  useOverviewCollection()
  // The other manifest-writing pass this view is allowed to run (#56): what
  // fal actually charged, replacing the estimates on the cards below.
  useCostReconciliation()

  const refreshList = useCallback(() => {
    queryClient
      .invalidateQueries({ queryKey: projectKeys.list() })
      .catch(() => {
        // A stale grid is corrected by the next refetch.
      })
  }, [queryClient])
  useVideoPosters(summaries ?? [], refreshList)

  const open = (id: string) => {
    openProject(id)
    setView('editor')
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto">
      <header className="flex items-center justify-between gap-4 px-6 pt-6 pb-4">
        <h1 className="text-lg font-medium">{t('overview.title')}</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          {t('editor.newProject.title')}
        </Button>
      </header>

      {summaries !== undefined && summaries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-16 text-center">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('overview.empty.title')}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t('overview.empty.description')}
            </p>
          </div>
          {/* Reachable with no projects at all — the empty library is the one
              state where creating is the only thing there is to do. */}
          <Button onClick={() => setCreating(true)}>
            <Plus />
            {t('editor.newProject.title')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 px-6 pb-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {(summaries ?? []).map(summary => (
            <ProjectCard
              key={summary.id}
              summary={summary}
              running={running.get(summary.id) ?? 0}
              onOpen={() => open(summary.id)}
              onDelete={() => setDeleting(summary)}
              onInspect={() => setInspecting(summary)}
            />
          ))}
        </div>
      )}

      <NewProjectDialog
        open={creating}
        onOpenChange={next => {
          setCreating(next)
          // Creating a project opens it, and the point of creating one is to
          // work in it — so the front door gets out of the way.
          if (!next && useEditorStore.getState().state.project !== null) {
            setView('editor')
          }
        }}
      />
      <StorageDialog
        project={inspecting}
        onOpenChange={next => {
          if (!next) setInspecting(null)
        }}
      />
      <DeleteProjectDialog
        project={deleting}
        onOpenChange={next => {
          if (!next) setDeleting(null)
        }}
      />
    </div>
  )
}

/**
 * PRD §10.3's pressure valve, one project at a time.
 *
 * In a dialog rather than on every card because the figure is a directory walk:
 * a grid of twenty cards each reporting its own size would be twenty scans on
 * every render of the front door, for a number nobody reads until they are
 * looking for space.
 */
function StorageDialog({
  project,
  onOpenChange,
}: {
  project: ProjectSummary | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project?.name ?? ''}</DialogTitle>
          <DialogDescription>
            {t('overview.storage.description')}
          </DialogDescription>
        </DialogHeader>
        <ProjectFootprint projectId={project?.id ?? null} />
      </DialogContent>
    </Dialog>
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
