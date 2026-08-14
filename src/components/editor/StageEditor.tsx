/**
 * The three-stage editor — PRD §10's main pane.
 *
 * One stage at a time, as tabs. Chosen over the two alternatives the #33 spike
 * put on screen (all three stages as lanes; a full-bleed canvas with no right
 * sidebar) — see the prototype/33-three-stage-editor branch for those.
 *
 * The stages are tabs rather than steps: every one of them can be re-run on
 * its own, and the tab bar deliberately offers no "next" (PRD §4.1). What
 * keeps that from reading as a wizard is the input line under the tabs, which
 * names the upstream candidate this stage is working from.
 *
 * The project it edits comes off disk (#23). With nothing open — an empty
 * library, or one still loading — it says so rather than inventing a project,
 * which is why `activeProject` is nullable.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  activeProject,
  activeRunFor,
  generationsForStage,
  selectedGeneration,
  STAGE_ORDER,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import {
  CandidateStrip,
  EmptyPreview,
  GenerationBadges,
  InputSummary,
  Preview,
  RecipeReadout,
  SeedComparison,
} from './shared'
import { EffectsTab } from './EffectsTab'
import { useGenerationName } from './naming'
import { PaletteDialog } from './PaletteDialog'
import { RunGrid } from './RunGrid'
import { SourceUpload } from './SourceUpload'

export function StageEditor() {
  const { t } = useTranslation()
  const state = useEditorStore(store => store.state)
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()
  const [editingPalette, setEditingPalette] = useState(false)

  const project = activeProject(state)

  if (project === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="text-base font-semibold">{t('editor.empty.title')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t('editor.empty.description')}
        </p>
      </div>
    )
  }

  const stage = state.activeStage
  const effectsOpen = state.effectsOpen
  const selected = selectedGeneration(project, stage)

  // The run this stage is still offering a choice from, if any — see
  // `activeRunFor`, which deliberately does not ask the job queue.
  const run = activeRunFor(state, project.id, stage)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-baseline gap-3 border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold">{project.name}</h1>
        <span className="text-xs text-muted-foreground">{project.aspect}</span>
        {/* Here rather than in the right sidebar because the palette is the
            project's and the sidebar is a stage's (#46). It sits next to the
            other two project-wide facts for the same reason. */}
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          onClick={() => setEditingPalette(true)}
        >
          {t('editor.palette.title')}
        </Button>
      </header>

      {editingPalette && (
        <PaletteDialog
          project={project}
          onClose={() => setEditingPalette(false)}
        />
      )}

      <nav
        className="flex gap-1 border-b border-border px-6"
        aria-label={t('editor.stages')}
      >
        {STAGE_ORDER.map(candidate => (
          <button
            key={candidate}
            type="button"
            onClick={() => dispatch({ type: 'selectStage', stage: candidate })}
            aria-current={!effectsOpen && candidate === stage}
            className={cn(
              'cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors',
              !effectsOpen && candidate === stage
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`editor.stage.${candidate}`)}
            <span className="ms-2 text-xs opacity-70">
              {generationsForStage(project, candidate).length}
            </span>
          </button>
        ))}
        {/* The fourth tab (#36), and the one place this strip stops being a
            pure map over `STAGE_ORDER`. It carries no count, because an effect
            is not a thing you accumulate candidates of — there is one treatment
            per generation and no batch of four to choose between. */}
        <button
          type="button"
          onClick={() => dispatch({ type: 'openEffects' })}
          aria-current={effectsOpen}
          className={cn(
            'cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors',
            effectsOpen
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t('effects.tab')}
        </button>
      </nav>

      {effectsOpen ? (
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          <EffectsTab project={project} stage={stage} />
          {/* The strip stays: the tab follows the selection, so the way to
              treat something else is to select it here. */}
          <CandidateStrip project={project} stage={stage} />
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          <InputSummary project={project} stage={stage} />

          {/* Only the source stage takes pixels from outside the project (#27). */}
          {stage === 'source' && <SourceUpload project={project} />}

          {/* While a run is in flight the stage is the run: every candidate at
            the same size, rather than a hero showing whichever landed first
            (#26). The strip stays below — history does not go away because
            something is generating. */}
          {run !== null ? (
            <RunGrid project={project} run={run} />
          ) : selected === null ? (
            <EmptyPreview
              aspect={project.aspect}
              messageKey="editor.nothingSelected"
            />
          ) : (
            <div className="space-y-3">
              <Preview generation={selected} aspect={project.aspect} />
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">{nameOf(selected)}</h2>
                <GenerationBadges project={project} generation={selected} />
              </div>
              <RecipeReadout generation={selected} />
              <SeedComparison project={project} generation={selected} />
            </div>
          )}

          <CandidateStrip project={project} stage={stage} />
        </div>
      )}
    </div>
  )
}
