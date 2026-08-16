/**
 * One candidate, as a thumbnail inside its card (ADR 0005).
 *
 * Ordinary markup, with a React Flow `Handle` of its own carrying the
 * generation's id. That handle is the whole trick: what a downstream step
 * consumes is a **picture**, not a step, so a line has to be able to start at
 * this thumbnail — and a handle anchors an edge wherever the browser happened to
 * put it. The tile therefore needs no position, no size and no place in the
 * node array, which is what lets a card be as tall as its contents.
 *
 * It was a child node until the card's height had to be declared as data to
 * place the grid under it. That declaration is what overflowed.
 *
 * Three gestures, because a thumbnail has three things to say about it: click
 * picks it, the magnifier opens it at full size (a tile is too small to judge
 * on), and double-click takes it to the effects panel.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position } from '@xyflow/react'
import { ArrowRightToLine, Check, Maximize2, Sparkles, X } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  isFromAnotherInput,
  type DraftNode,
  type Generation,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { CandidateViewer } from './CandidateViewer'
import { useGenerationName } from './naming'
import { Preview } from './shared'

export function CandidateTile({
  project,
  node,
  generation,
  siblings,
  feeds,
}: {
  project: Project
  node: DraftNode
  generation: Generation
  /** The row this tile is in, so the full-size view can step along it. */
  siblings: readonly Generation[]
  /**
   * Whether the step the sidebar is editing works from this picture.
   *
   * A **pin**, not a pick, and the two are different facts about different
   * nodes: the border says what this card settled on, the dashed halo says what
   * the selected step will consume. Changing "Working from" in the sidebar
   * moves the halo and leaves the border alone, which is what the state does.
   */
  feeds: boolean
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()
  const [viewing, setViewing] = useState(false)

  const picked = node.pick === generation.id
  const stale = isFromAnotherInput(project, generation)

  return (
    // The magnifier and the handle are siblings of the picking button rather
    // than children of it: a button inside a button is not markup a browser
    // agrees to render.
    <div className="group relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={picked}
            aria-label={nameOf(generation)}
            // A click is a pick, which is also what answers an open run's grid —
            // `selectGeneration` does both, so there is no second gesture for
            // "yes, this one" depending on whether a run is still open.
            onClick={() => {
              dispatch({
                type: 'selectGeneration',
                generationId: generation.id,
              })
            }}
            onDoubleClick={() => {
              dispatch({ type: 'pinTreatment', generationId: generation.id })
            }}
            className={cn(
              'nodrag block w-full cursor-pointer overflow-hidden rounded-md border-2 transition-colors',
              // The app's own focus ring, and `outline-none` to stop the
              // browser drawing a second one. A blue UA ring on the last tile
              // clicked reads as a third kind of highlight next to the two this
              // card actually has, in the one hue the theme never uses.
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              picked
                ? 'border-primary'
                : 'border-transparent hover:border-foreground/30',
              // Three marks that must never be mistaken for one another, so
              // they differ in *kind* and not only in colour: the pick is a
              // solid border tight to the picture, this is a dashed halo
              // outside it, and focus is a soft ring. Both can be true at once —
              // a card's pick is usually what the next step consumes — and the
              // dashes say the same thing the canvas already says with them.
              feeds &&
                'outline-2 outline-offset-2 outline-dashed outline-sky-500',
              // A reject stays visible and stays clickable (PRD §10.3). Dimmed
              // rather than removed, because it is still a thing you can point a
              // downstream step at if you change your mind.
              generation.verdict === 'rejected' && 'opacity-40'
            )}
          >
            <Preview
              generation={generation}
              aspect={project.aspect}
              className="rounded-none border-0"
            />

            {/* Four marks, and each is a different sentence. The verdict is
                what somebody decided about the picture; the treatment dot is
                what has been applied on top; the arrow is the step being edited
                taking it as its input; the staleness flag is what the project
                has done since. Any of them can be true at once. */}
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-background/70 px-1 py-0.5">
              {generation.verdict === 'approved' && (
                <Check className="size-3 text-primary" aria-hidden />
              )}
              {generation.verdict === 'rejected' && (
                <X className="size-3 text-destructive" aria-hidden />
              )}
              {generation.treatment !== null && (
                <Sparkles
                  className="size-3 text-muted-foreground"
                  aria-hidden
                />
              )}
              {/* Named rather than hidden, unlike its neighbours: the halo is
                  the only thing on the card that answers "which picture does
                  the step I am editing take", and an outline is not an answer
                  to a screen reader. */}
              {feeds && (
                <span role="img" aria-label={t('editor.badge.feedsSelected')}>
                  <ArrowRightToLine
                    className="size-3 text-sky-600"
                    aria-hidden
                  />
                </span>
              )}
              {stale && (
                <span
                  className="ms-auto size-1.5 rounded-full bg-amber-500"
                  aria-hidden
                />
              )}
            </span>
          </button>
        </TooltipTrigger>

        <TooltipContent side="bottom" className="max-w-64">
          <p className="font-medium">{nameOf(generation)}</p>
          <p className="text-xs opacity-80">{generation.recipe.modelId}</p>
          {feeds && (
            <p className="text-xs opacity-80">
              {t('editor.badge.feedsSelected')}
            </p>
          )}
          {stale && (
            <p className="text-xs opacity-80">{t('editor.badge.staleInput')}</p>
          )}
        </TooltipContent>
      </Tooltip>

      {/* On hover, and on focus so it is reachable by keyboard at all. A tile
          is a few dozen pixels of a picture that cost real money — the full-size
          look is the point of the thumbnail, not a power feature. */}
      <button
        type="button"
        aria-label={t('editor.action.enlarge')}
        onClick={() => setViewing(true)}
        className="nodrag absolute end-1 top-1 rounded-md bg-background/80 p-1 text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Maximize2 className="size-3" aria-hidden />
      </button>

      {/* Where a downstream step is wired from when this picture is the one it
          consumes. The handle id *is* the generation id, which is how
          `actionsForConnection` tells "feed it this picture" apart from "feed it
          from that step". Small and always present rather than revealed on
          hover: a handle you cannot see is one you cannot aim at. */}
      <Handle
        type="source"
        id={generation.id}
        position={Position.Right}
        className="!size-2 !border-background !bg-muted-foreground"
      />

      {/* Opened on this picture, but stepping through the whole row — the
          neighbours are what it is being judged against. */}
      {viewing && (
        <CandidateViewer
          project={project}
          candidates={siblings}
          startId={generation.id}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  )
}
