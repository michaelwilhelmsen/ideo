/**
 * One candidate at the size it was paid for — and its neighbours, one key away.
 *
 * The canvas draws pictures at thumbnail size, which is what makes a run of
 * twelve readable at a glance, but a thumbnail is not enough to judge one on.
 * Faces, hands, text in the background, the difference between two models given
 * the same prompt: none of that survives a 118px tile, and judging is the entire
 * point of generating four.
 *
 * **The set it steps through is the node's**, not the project's. Comparing a
 * source still against an animate frame is not a comparison anybody makes; the
 * step is the comparison, which is why a run puts its candidates side by side in
 * the first place. Arrow keys move within it, so a twelve-way fan-out can be
 * flicked through at full size rather than opened and closed twelve times.
 *
 * A dialog rather than a mode: it opens over whatever you were doing, closes on
 * Escape, and leaves the selection alone. It carries the verdict buttons because
 * this is where the verdict is actually decidable — approving from a thumbnail
 * is approving something you have not seen.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  modelById,
  MODEL_REGISTRY,
  type Generation,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { useGenerationName } from './naming'
import { GenerationBadges, Preview } from './shared'

export function CandidateViewer({
  project,
  candidates,
  startId,
  onClose,
}: {
  project: Project
  /** What the arrows step through — the node's visible candidates, in order. */
  candidates: readonly Generation[]
  startId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const nameOf = useGenerationName()

  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      candidates.findIndex(candidate => candidate.id === startId)
    )
  )

  // Clamped rather than remembered: a reject can leave the list while the dialog
  // is open, and an index past the end would blank the picture instead of
  // showing the one that took its place.
  const at = Math.min(index, candidates.length - 1)
  const generation = candidates[at]
  if (generation === undefined) return null

  const step = (delta: number) => {
    // No wrapping. Running off the end of a run and landing back on the first
    // picture reads as "this is the same one", which is the one thing a
    // comparison must never say by accident.
    setIndex(Math.min(Math.max(at + delta, 0), candidates.length - 1))
  }

  const verdict = (next: 'approved' | 'rejected') => {
    dispatch({
      type: 'setVerdict',
      generationId: generation.id,
      // Clicking the verdict it already has takes it back off, which is the
      // only way to undo a misclick without a third button.
      verdict: generation.verdict === next ? 'unrated' : next,
    })
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      {/* Wide, and capped against the window rather than a fixed size, so a
          portrait picture is limited by the screen and not by the dialog. */}
      <DialogContent
        className="max-w-[min(96vw,72rem)] sm:max-w-[min(96vw,72rem)]"
        // On the content rather than on the window: the dialog traps focus, so
        // every keystroke made while it is open bubbles through here, and a
        // listener on `document` would still be firing after it closed.
        //
        // Read in the reading direction. In an RTL locale the pictures are laid
        // out right to left, so the key that means "the next one" is the one
        // pointing left.
        onKeyDown={event => {
          const rtl = document.documentElement.dir === 'rtl'
          if (event.key === 'ArrowRight') step(rtl ? -1 : 1)
          if (event.key === 'ArrowLeft') step(rtl ? 1 : -1)
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate">{nameOf(generation)}</DialogTitle>
          <DialogDescription>
            {modelById(MODEL_REGISTRY, generation.recipe.modelId).label}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto">
          <Preview generation={generation} aspect={project.aspect} />
        </div>

        <GenerationBadges project={project} generation={generation} />

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={
                generation.verdict === 'approved' ? 'default' : 'outline'
              }
              aria-pressed={generation.verdict === 'approved'}
              onClick={() => verdict('approved')}
            >
              <Check className="size-3.5" />
              {t('editor.action.approve')}
            </Button>
            <Button
              size="sm"
              variant={
                generation.verdict === 'rejected' ? 'destructive' : 'outline'
              }
              aria-pressed={generation.verdict === 'rejected'}
              onClick={() => verdict('rejected')}
            >
              <X className="size-3.5" />
              {t('editor.action.reject')}
            </Button>
          </div>

          {/* Buttons as well as keys, and the count between them: without it,
              nothing on screen says how many more there are to look at.
              `aria-disabled` rather than `disabled` at the ends — a button that
              disables itself under the pointer drops keyboard focus to the body,
              and the arrow keys are read by the dialog, so pressing Next to the
              last picture would silently turn them off. */}
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              aria-label={t('editor.viewer.previous')}
              aria-disabled={at === 0}
              className={cn(at === 0 && 'opacity-50')}
              onClick={() => step(-1)}
            >
              <ChevronLeft className="size-4 rtl:rotate-180" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('editor.viewer.position', {
                index: at + 1,
                total: candidates.length,
              })}
            </span>
            <Button
              size="icon"
              variant="outline"
              aria-label={t('editor.viewer.next')}
              aria-disabled={at === candidates.length - 1}
              className={cn(at === candidates.length - 1 && 'opacity-50')}
              onClick={() => step(1)}
            >
              <ChevronRight className="size-4 rtl:rotate-180" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
