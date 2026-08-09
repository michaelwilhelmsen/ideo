/**
 * The two ways an image the user already has becomes a project source (#27):
 * a file picker, and dropping it on the upload panel.
 *
 * Both are the *same* path — they only differ in where the path string comes
 * from, and they meet one line later in `useImportSourceImage`. That is the
 * point of the slice: there is one import, one set of refusals, and one
 * reducer action, so "picked" and "dropped" cannot drift apart in what they
 * accept or what they record.
 *
 * It only appears on the source stage. Style and animate take their input from
 * the stage above (PRD §4.1) rather than from disk, so an upload affordance
 * there would offer something the recipe model has nowhere to put.
 *
 * Two things the OS gesture forces this component to do by hand:
 *
 * **Scoping.** Tauri reports a drag against the *window*, not against a DOM
 * node, so a listener that simply believed the event would swallow a file
 * dropped anywhere — over the candidate strip, the sidebar, another stage.
 * The drop is therefore tested against this panel's own rectangle, and the
 * highlight follows the same test, so what lights up is what will accept.
 *
 * **Arity.** A source is one picture. A multi-file drop is an ambiguous
 * request, and quietly taking `paths[0]` answers it by guessing — the user
 * would watch four files vanish into one candidate with no idea which. So it
 * refuses, and says why (`editor.upload.oneAtATime`).
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { Project } from '@/lib/recipe'
import { isWithinDropZone } from './drop-zone'
import { useImportSourceImage } from './import-source'

export function SourceUpload({ project }: { project: Project }) {
  const { t } = useTranslation()
  const importer = useImportSourceImage(project)
  const [isOver, setIsOver] = useState(false)
  const zone = useRef<HTMLElement>(null)

  // `importer` is rebuilt every render, so the effect reads it through a ref
  // the compiler keeps current rather than re-registering the OS listener on
  // every keystroke elsewhere in the editor.
  const importPath = importer.importPath

  useEffect(() => {
    let isMounted = true
    let unlisten: (() => void) | null = null

    const inside = (position: { x: number; y: number }): boolean => {
      const element = zone.current
      if (element === null) return false
      return isWithinDropZone(
        element.getBoundingClientRect(),
        position,
        window.devicePixelRatio
      )
    }

    getCurrentWebview()
      .onDragDropEvent(event => {
        const payload = event.payload

        if (payload.type === 'leave') {
          setIsOver(false)
          return
        }

        const over = inside(payload.position)

        if (payload.type === 'enter' || payload.type === 'over') {
          setIsOver(over)
          return
        }

        setIsOver(false)
        if (payload.type !== 'drop' || !over) return

        // Read off `i18n` rather than the hook's `t`: this callback is
        // registered once and would otherwise keep the language it was born in.
        if (payload.paths.length !== 1) {
          toast.error(i18n.t('editor.upload.oneAtATime'))
          return
        }

        const [only] = payload.paths
        if (only === undefined) return

        void importPath(only)
      })
      .then(unlistenFn => {
        if (isMounted) {
          unlisten = unlistenFn
        } else {
          unlistenFn()
        }
      })
      .catch((error: unknown) => {
        logger.error('Could not listen for dropped files', { error })
      })

    return () => {
      isMounted = false
      unlisten?.()
    }
  }, [importPath])

  return (
    <section
      ref={zone}
      className={cn(
        'rounded-lg border border-dashed border-border p-4 transition-colors',
        isOver && 'border-primary bg-primary/5'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t('editor.upload.title')}</h2>
          <p className="max-w-md text-xs text-muted-foreground">
            {isOver
              ? t('editor.upload.dropHere')
              : t('editor.upload.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={importer.isImporting}
          onClick={() => void importer.pick()}
        >
          {importer.isImporting
            ? t('editor.upload.importing')
            : t('editor.upload.action')}
        </Button>
      </div>
    </section>
  )
}
