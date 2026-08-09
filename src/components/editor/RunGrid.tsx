/**
 * A run, while it is being decided (#26, PRD §4.2).
 *
 * Four candidates from one click is only worth paying for if the choice
 * between them is a moment the user actually has. A hero plus a strip does not
 * give them one: the first arrival fills the preview, the rest land in a row
 * underneath, and the four-up quietly becomes "whatever appeared first, plus
 * three thumbnails". So from the click until the choice, the stage shows the
 * run instead — every candidate at the same size, the ones still coming as
 * placeholders in the places they will fill.
 *
 * It stays until the user answers it, not until the queue empties. The job
 * store reports what is *running*, so a grid that lived off the job list would
 * disappear at the moment it finally had all four images on it — the one
 * moment it existed for.
 *
 * Clicking one is the answer, and arrivals after that click never move the
 * selection (see `withArrivals`). Dismissing is the other answer: the run goes
 * back to being ordinary history in the strip, which is where it was always
 * going to end up.
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { runProgress, type Project, type RunRecord } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { useGenerationName } from './naming'
import { GenerationBadges, PendingPreview, Preview } from './shared'

export function RunGrid({
  project,
  run,
}: {
  project: Project
  run: RunRecord
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()

  const progress = runProgress(project, run)

  return (
    <section className="space-y-3" aria-label={t('editor.run.title')}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t('editor.run.title')}</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted-foreground">
            {t('editor.run.progress', {
              done: progress.arrived.length,
              total: progress.total,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dispatch({ type: 'dismissRun', runId: run.id })}
          >
            {t('editor.run.dismiss')}
          </Button>
        </div>
      </div>

      <div
        className={cn('grid gap-3', progress.total > 1 && 'grid-cols-2')}
        data-testid="run-grid"
      >
        {progress.arrived.map(generation => (
          <button
            key={generation.id}
            type="button"
            onClick={() =>
              dispatch({
                type: 'selectGeneration',
                generationId: generation.id,
              })
            }
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

        {Array.from({ length: progress.waiting }, (_, index) => (
          <PendingPreview
            key={`waiting-${String(index)}`}
            aspect={project.aspect}
          />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t('editor.run.pick')}</p>
    </section>
  )
}
