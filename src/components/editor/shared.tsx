/**
 * The leaves the three layout variants share.
 *
 * Shared on purpose: a candidate tile and a recipe readout are *content*, and
 * the question #33 is asking is where content goes, not what a tile looks
 * like. Nothing here decides a layout — no variant imports a wrapper from this
 * file, so each is still free to throw the whole arrangement out.
 */

import { useTranslation } from 'react-i18next'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  controlAvailability,
  diffRecipes,
  generationById,
  isFromAnotherInput,
  isUploadRecipe,
  modelById,
  MODEL_REGISTRY,
  previewArt,
  recipeSummary,
  runGroups,
  seedSibling,
  upstreamOf,
  visibleGenerations,
  rejectedCount,
  type AspectId,
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
 * What a generation produced — a still, or, since #29, a clip.
 *
 * One component rather than two, and used everywhere a candidate appears: the
 * strip, the run grid, the seed comparison. An animate candidate is a candidate
 * like any other, so a tile that could not play one would make the last stage
 * the only one whose results you cannot see where you chose them.
 *
 * Muted, looping and autoplaying because that is what a hero loop *is* — the
 * artefact this app makes is a background that runs on a page, and the closest
 * honest preview of it is one that runs here too. `controls` for the case where
 * it is the thing being examined rather than glanced at; `playsInline` because
 * without it a webview may take the clip fullscreen on its own.
 *
 * The deterministic stand-in remains for a candidate with no file — a paid
 * result that has not landed, or one whose job never did.
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
  const { t } = useTranslation()
  const directory = useEditorStore(store => store.state.directory)
  const source = assetSource(directory, generation.asset)
  const art = previewArt(generation)

  const shape = cn(
    'w-full overflow-hidden rounded-md border border-border',
    ASPECT_CLASS[aspect] ?? 'aspect-video',
    className
  )

  if (source === null) {
    return <div className={shape} style={{ background: art.background }} />
  }

  if (isVideoAsset(generation.asset)) {
    return (
      <video
        src={source}
        aria-label={t('editor.preview.clip')}
        autoPlay
        loop
        muted
        playsInline
        controls
        // Same `object-cover` argument as the still below: the box holds the
        // project's locked ratio and the clip covers it rather than stretching.
        className={cn(shape, 'object-cover')}
      />
    )
  }

  return (
    <img
      src={source}
      alt=""
      // The file is whatever fal produced, and fal snaps dimensions to a
      // multiple of 16 (PRD §12) — so the box holds the project's ratio and
      // the image covers it rather than stretching to fit.
      className={cn(shape, 'object-cover')}
    />
  )
}

/**
 * Whether this asset is a clip, from its extension.
 *
 * The extension rather than the stage, deliberately. The manifest records a file
 * name and the stage is a separate field, so asking the file what it is means an
 * animate candidate saved before this shipped, or a project whose stages someone
 * has been editing by hand, still renders as whatever it actually holds.
 *
 * The list is the two containers `extension_for` can produce on the Rust side.
 */
const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'webm']

function isVideoAsset(asset: string | null): boolean {
  if (asset === null) return false
  const extension = asset.split('.').at(-1)?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(extension)
}

/**
 * The webview URL for a generation's file, or `null` when there is no file.
 *
 * The manifest stores a bare name and the folder comes from wherever the
 * manifest was found, so a project folder that has moved still resolves.
 */
function assetSource(directory: string | null, asset: string | null) {
  if (directory === null || directory === '' || asset === null) return null
  return convertFileSrc(`${directory}/assets/${asset}`)
}

/**
 * A candidate that has been paid for but has not arrived yet (#26).
 *
 * Holds the project's ratio rather than collapsing, so the grid a run is
 * watched in does not reflow as each job settles — the tiles are already where
 * the images will be.
 */
export function PendingPreview({ aspect }: { aspect: AspectId }) {
  const { t } = useTranslation()

  return (
    <div
      role="status"
      aria-label={t('editor.run.pending')}
      className={cn(
        'w-full animate-pulse rounded-md border border-border bg-muted',
        ASPECT_CLASS[aspect] ?? 'aspect-video'
      )}
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
      {/* Where the pixels came from, said plainly (#27). Downstream treats an
          upload as any other candidate; only the label knows the difference. */}
      {isUploadRecipe(generation.recipe) && (
        <Badge variant="secondary">{t('editor.upload.badge')}</Badge>
      )}
      {generation.recipe.seed.mode === 'pinned' && (
        <Badge variant="secondary">{t('editor.badge.pinnedSeed')}</Badge>
      )}
      {generation.seed === null && !isUploadRecipe(generation.recipe) && (
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
        <PinSeedButton project={project} generation={generation} />

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
 * Pin *this* candidate's seed into the draft (PRD §4.3).
 *
 * On the tile rather than only in the sidebar because the choice is about a
 * picture: "keep that composition, change the fragment" is said while looking
 * at the one you mean, and the sidebar switch can only ever pin whatever
 * happens to be selected.
 *
 * Absent when there is nothing to pin — a candidate with no seed (an upload, a
 * seedless model) or a draft whose current model has no seed field, where the
 * button would promise a reproducibility the next run cannot deliver.
 *
 * Exported because the grid shows the same candidates the strip does, and
 * "keep that composition" is said most often about one that has just arrived.
 */
export function PinSeedButton({
  project,
  generation,
}: {
  project: Project
  generation: Generation
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  const seed = generation.seed
  if (seed === null) return null

  const draft = project.drafts[generation.stage]
  const model = modelById(MODEL_REGISTRY, draft.modelId)
  if (controlAvailability(model, 'seed').state !== 'available') return null

  const pinned = draft.seed.mode === 'pinned' && draft.seed.value === seed

  return (
    <Button
      size="sm"
      variant={pinned ? 'default' : 'outline'}
      aria-pressed={pinned}
      title={t('editor.seed.pinThisHint')}
      onClick={() =>
        dispatch(
          pinned
            ? { type: 'unpinSeed', stage: generation.stage }
            : { type: 'pinSeed', stage: generation.stage, value: seed }
        )
      }
    >
      {t('editor.action.pinSeed')}
    </Button>
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
  const groups = runGroups(project, stage, showRejected)
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
          {/* One click produced several candidates (#26), so the strip says
              which — otherwise a four-up reads as four unrelated attempts and
              "the second one of that run" stops being sayable. Candidates from
              before runs were recorded carry no label and no divider. */}
          {groups.map((group, index) => (
            <div
              key={group.runId ?? `ungrouped-${String(index)}`}
              className={cn(
                // The label sits above its run either way; only the divider
                // between runs follows the strip's direction.
                'flex shrink-0 flex-col gap-1',
                index > 0 &&
                  group.number !== null &&
                  (orientation === 'horizontal'
                    ? 'border-s border-border ps-3'
                    : 'border-t border-border pt-3')
              )}
            >
              {group.number !== null && (
                <span className="text-xs text-muted-foreground">
                  {t('editor.run.number', { number: group.number })}
                </span>
              )}
              <div
                className={cn(
                  'flex gap-3',
                  orientation === 'vertical' && 'flex-col'
                )}
              >
                {group.generations.map(generation => (
                  <GenerationTile
                    key={generation.id}
                    project={project}
                    generation={generation}
                    selected={project.selection[stage] === generation.id}
                    compact={compact}
                  />
                ))}
              </div>
            </div>
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
