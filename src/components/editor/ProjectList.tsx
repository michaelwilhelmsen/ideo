/**
 * The left sidebar (PRD §10) — a persistent project list, so "swap the style
 * on that old hero" never means navigating out of what you are looking at.
 *
 * Identical in all three variants: none of them disagreed about it, which is
 * itself worth knowing.
 */

import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { generationsForStage, STAGE_ORDER } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'

export function ProjectList() {
  const { t } = useTranslation()
  const state = useEditorStore(store => store.state)
  const dispatch = useEditorStore(store => store.dispatch)

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      <h2 className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t('editor.projects')}
      </h2>

      {state.projects.map(project => (
        <button
          key={project.id}
          type="button"
          onClick={() =>
            dispatch({ type: 'selectProject', projectId: project.id })
          }
          className={cn(
            'flex cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-start transition-colors hover:bg-accent',
            project.id === state.activeProjectId && 'bg-accent'
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{project.name}</span>
            {/* Locked at creation and never editable (PRD §4.4) — so it reads
                as a property of the project, not a control. */}
            <Badge variant="outline">{project.aspect}</Badge>
          </span>

          <span className="text-xs text-muted-foreground">
            {STAGE_ORDER.map(
              stage =>
                `${t(`editor.stage.${stage}`)} ${generationsForStage(project, stage).length}`
            ).join(' · ')}
          </span>
        </button>
      ))}
    </div>
  )
}
