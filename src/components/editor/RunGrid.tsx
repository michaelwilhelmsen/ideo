/**
 * A run, while it is happening (#26, PRD §4.2).
 *
 * Four candidates from one click is only worth paying for if the choice
 * between them is a moment the user actually has. A hero plus a strip does not
 * give them one: the first arrival fills the preview, the rest land in a row
 * underneath, and the four-up quietly becomes "whatever appeared first, plus
 * three thumbnails". So while a run is in flight the stage shows the run
 * instead — every candidate at the same size, the ones still coming as
 * placeholders in the places they will fill.
 *
 * Clicking one is the choice, and it ends the grid: the stage goes back to
 * hero and strip with that candidate selected. Arrivals after that click never
 * move the selection (see `withCollectedGenerations`) — a run that kept
 * re-deciding for you would be worse than no grid at all.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { Project, StageKind } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import type { ActiveRun } from './active-run'
import { useGenerationName } from './naming'
import { GenerationBadges, PendingPreview, Preview } from './shared'

export function RunGrid({
  project,
  stage,
  run,
  onPick,
}: {
  project: Project
  stage: StageKind
  run: ActiveRun
  onPick: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()

  const total = run.arrived.length + run.pending.length

  return (
    <section className="space-y-3" aria-label={t('editor.run.title')}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t('editor.run.title')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('editor.run.progress', { done: run.arrived.length, total })}
        </span>
      </div>

      <div
        className={cn(
          'grid gap-3',
          total > 1 ? 'grid-cols-2' : 'grid-cols-1',
          'sm:gap-4'
        )}
      >
        {run.arrived.map(generation => (
          <button
            key={generation.id}
            type="button"
            onClick={() => {
              dispatch({
                type: 'selectGeneration',
                generationId: generation.id,
              })
              onPick()
            }}
            className="cursor-pointer space-y-2 rounded-md text-start focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Preview generation={generation} aspect={project.aspect} />
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{nameOf(generation)}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {generation.seed === null ? '—' : generation.seed}
              </span>
            </div>
            <GenerationBadges project={project} generation={generation} />
          </button>
        ))}

        {run.pending.map(job => (
          <PendingPreview key={job.requestId} aspect={project.aspect} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {t(`editor.run.pick.${stage === 'animate' ? 'video' : 'image'}`)}
      </p>
    </section>
  )
}
