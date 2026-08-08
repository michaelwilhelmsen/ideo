/**
 * The leaves the three layout variants share.
 *
 * Shared on purpose: a candidate tile and a recipe readout are *content*, and
 * the question #33 is asking is where content goes, not what a tile looks
 * like. Nothing here decides a layout — no variant imports a wrapper from this
 * file, so each is still free to throw the whole arrangement out.
 */

import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  diffRecipes,
  generationById,
  isFromAnotherInput,
  previewArt,
  recipeSummary,
  seedSibling,
  upstreamOf,
  visibleGenerations,
  rejectedCount,
  type Generation,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { useGenerationName } from './naming'

const ASPECT_CLASS: Record<string, string> = {
  '16:9': 'aspect-video',
  '21:9': 'aspect-[21/9]',
  '2:1': 'aspect-[2/1]',
  '3:2': 'aspect-[3/2]',
  '1:1': 'aspect-square',
}

/**
 * The stand-in for a rendered asset. Composition tracks the seed, colour
 * tracks the style fragment — see `previewArt`.
 */
export function Preview({
  generation,
  aspect,
  className,
}: {
  generation: Generation
  aspect: string
  className?: string
}) {
  const art = previewArt(generation)

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-md border border-border',
        ASPECT_CLASS[aspect] ?? 'aspect-video',
        className
      )}
      style={{ background: art.background }}
    />
  )
}

export function EmptyPreview({
  aspect,
  messageKey,
}: {
  aspect: string
  messageKey: string
}) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'flex w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground',
        ASPECT_CLASS[aspect] ?? 'aspect-video'
      )}
    >
      {t(messageKey)}
    </div>
  )
}

/** Approved / rejected / made-from-something-else / not reproducible. */
export function GenerationBadges({
  project,
  generation,
}: {
  project: Project
  generation: Generation
}) {
  const { t } = useTranslation()
  const fromElsewhere = isFromAnotherInput(project, generation)

  return (
    <div className="flex flex-wrap gap-1">
      {generation.verdict === 'approved' && (
        <Badge variant="default">{t('editor.verdict.approved')}</Badge>
      )}
      {generation.verdict === 'rejected' && (
        <Badge variant="destructive">{t('editor.verdict.rejected')}</Badge>
      )}
      {generation.recipe.seed.mode === 'pinned' && (
        <Badge variant="secondary">{t('editor.badge.pinnedSeed')}</Badge>
      )}
      {generation.seed === null && (
        <Badge variant="outline">{t('editor.badge.notReproducible')}</Badge>
      )}
      {fromElsewhere && (
        <Badge variant="outline">{t('editor.badge.fromAnotherInput')}</Badge>
      )}
    </div>
  )
}

/**
 * One candidate. Clicking selects it; the verdict buttons are separate,
 * because "this is what the next stage uses" and "this one is good" are
 * different statements and conflating them loses the second.
 */
export function GenerationTile({
  project,
  generation,
  selected,
  compact = false,
}: {
  project: Project
  generation: Generation
  selected: boolean
  compact?: boolean
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-2 rounded-lg border p-2 transition-colors',
        compact ? 'w-40' : 'w-56',
        selected ? 'border-primary bg-accent/40' : 'border-border',
        generation.verdict === 'rejected' && 'opacity-60'
      )}
    >
      <button
        type="button"
        onClick={() =>
          dispatch({ type: 'selectGeneration', generationId: generation.id })
        }
        aria-pressed={selected}
        className="block w-full cursor-pointer rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Preview generation={generation} aspect={project.aspect} />
      </button>

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{nameOf(generation)}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {generation.seed === null ? '—' : generation.seed}
        </span>
      </div>

      <GenerationBadges project={project} generation={generation} />

      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant={generation.verdict === 'approved' ? 'default' : 'outline'}
          onClick={() =>
            dispatch({
              type: 'setVerdict',
              generationId: generation.id,
              verdict:
                generation.verdict === 'approved' ? 'unrated' : 'approved',
            })
          }
        >
          {t('editor.action.approve')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            dispatch({
              type: 'setVerdict',
              generationId: generation.id,
              verdict:
                generation.verdict === 'rejected' ? 'unrated' : 'rejected',
            })
          }
        >
          {t('editor.action.reject')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            dispatch({ type: 'restoreRecipe', generationId: generation.id })
          }
          title={t('editor.action.restoreRecipeHint')}
        >
          {t('editor.action.restoreRecipe')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Every candidate the stage has ever produced, minus the rejects — which are
 * one toggle away and never gone (PRD §10.3).
 */
export function CandidateStrip({
  project,
  stage,
  compact = false,
  orientation = 'horizontal',
}: {
  project: Project
  stage: StageKind
  compact?: boolean
  orientation?: 'horizontal' | 'vertical'
}) {
  const { t } = useTranslation()
  const showRejected = useEditorStore(store => store.state.showRejected)
  const dispatch = useEditorStore(store => store.dispatch)

  const candidates = visibleGenerations(project, stage, showRejected)
  const hidden = showRejected ? 0 : rejectedCount(project, stage)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('editor.candidates', { count: candidates.length })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => dispatch({ type: 'toggleShowRejected' })}
        >
          {showRejected
            ? t('editor.action.hideRejected')
            : t('editor.action.showRejected', { count: hidden })}
        </Button>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('editor.noCandidates')}
        </p>
      ) : (
        <div
          className={cn(
            'flex gap-3',
            orientation === 'horizontal'
              ? 'overflow-x-auto pb-2'
              : 'flex-col overflow-y-auto'
          )}
        >
          {candidates.map(generation => (
            <GenerationTile
              key={generation.id}
              project={project}
              generation={generation}
              selected={project.selection[stage] === generation.id}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The recipe behind whatever is selected — the artefact, spelled out. */
export function RecipeReadout({ generation }: { generation: Generation }) {
  const { t } = useTranslation()

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {recipeSummary(generation.recipe).map(field => (
        <div key={field.key} className="contents">
          <dt className="text-muted-foreground">{field.key}</dt>
          <dd className="truncate font-mono">{field.value}</dd>
        </div>
      ))}
      <div className="contents">
        <dt className="text-muted-foreground">{t('editor.field.seed')}</dt>
        <dd className="font-mono">
          {generation.seed === null
            ? t('editor.badge.notReproducible')
            : generation.seed}
        </dd>
      </div>
    </dl>
  )
}

/**
 * The pinned-seed claim, checked on screen: the selected candidate next to the
 * last one that shared its seed, with the fields that differ listed out.
 */
export function SeedComparison({
  project,
  generation,
}: {
  project: Project
  generation: Generation
}) {
  const { t } = useTranslation()
  const nameOf = useGenerationName()
  const sibling = seedSibling(project, generation)

  if (sibling === null) return null

  const changed = diffRecipes(sibling.recipe, generation.recipe)

  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className="text-sm font-medium">
        {t('editor.comparison.title', {
          left: nameOf(sibling),
          right: nameOf(generation),
        })}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('editor.comparison.sameSeed', { seed: generation.seed ?? 0 })}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Preview generation={sibling} aspect={project.aspect} />
        <Preview generation={generation} aspect={project.aspect} />
      </div>

      <ul className="mt-3 space-y-1 text-xs">
        {changed.length === 0 ? (
          <li className="text-muted-foreground">
            {t('editor.comparison.identical')}
          </li>
        ) : (
          changed.map(field => (
            <li key={field.key}>
              <span className="text-muted-foreground">{field.key}: </span>
              <span className="font-mono line-through opacity-60">
                {field.before}
              </span>
              <span className="mx-1">→</span>
              <span className="font-mono">{field.after}</span>
            </li>
          ))
        )}
      </ul>
    </section>
  )
}

/** What this stage is working from — the pointer that makes re-runs sane. */
export function InputSummary({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  const { t } = useTranslation()
  const nameOf = useGenerationName()
  const upstream = upstreamOf(stage)

  if (upstream === null) return null

  const input = generationById(project, project.selection[upstream])

  return (
    <p className="text-xs text-muted-foreground">
      {input === null
        ? t(`editor.reason.needs.${upstream}`)
        : t('editor.inputFrom', { name: nameOf(input) })}
    </p>
  )
}
