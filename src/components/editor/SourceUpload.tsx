/**
 * The two ways an image the user already has becomes a project source (#27):
 * a file picker, and dropping it on the window.
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
 * The drop target is the whole stage pane rather than a small rectangle: the
 * OS drag is already a coarse gesture, and Tauri reports the drop against the
 * window, not against a DOM node, so a small target would be a lie about what
 * is actually being listened to.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { Project } from '@/lib/recipe'
import { useImportSourceImage } from './import-source'

export function SourceUpload({ project }: { project: Project }) {
  const { t } = useTranslation()
  const importer = useImportSourceImage(project)
  const [isOver, setIsOver] = useState(false)

  // `importer` is rebuilt every render, so the effect reads it through a ref
  // the compiler keeps current rather than re-registering the OS listener on
  // every keystroke elsewhere in the editor.
  const importPath = importer.importPath

  useEffect(() => {
    let isMounted = true
    let unlisten: (() => void) | null = null

    getCurrentWebview()
      .onDragDropEvent(event => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setIsOver(true)
          return
        }

        setIsOver(false)
        if (event.payload.type !== 'drop') return

        // One image per source. A multi-file drop is an ambiguous request and
        // guessing which one was meant is worse than taking the first.
        const [first] = event.payload.paths
        if (first === undefined) return

        void importPath(first)
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
