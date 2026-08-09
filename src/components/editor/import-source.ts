/**
 * The impure half of an upload (#27): the file dialog, the copy, and the
 * checks that have to happen before anything is recorded.
 *
 * Same shape as `run-request.ts`, and for the same reason — the reducer takes
 * finished facts, so the id is minted here and the file is already on disk by
 * the time anything is dispatched.
 *
 * Two gates stand between a picked file and a candidate, and both refuse
 * rather than warn:
 *
 * 1. Rust's, on size and format. A 200 MB TIFF is not a source image and
 *    saying so early is the difference between a sentence and a stall.
 * 2. The project's locked aspect ratio (PRD §4.4). This is the one #27 calls
 *    "caught early": a 3:2 photograph in a 16:9 project is the wrong picture
 *    for every stage after it, and the video model at the end is the pickiest
 *    of the lot — finding out there costs a video.
 *
 * The second gate runs after Rust has already copied the file, because the
 * dimensions are in the header and reading a header means reading the file.
 * The copy is simply left behind: it is unreferenced, which is precisely what
 * the deliberate cleanup pass exists to collect (PRD §10.3). Deleting it here
 * would be this app removing a file on its own initiative, which nothing else
 * in it does.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import { describeRatio, matchesAspect, type Project } from '@/lib/recipe'
import { logger } from '@/lib/logger'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { importErrorMessage } from './errors'

/** What the picker offers. The same three formats Rust accepts by magic byte. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']

export interface SourceImport {
  /** Copy this local file in, or say why not. */
  readonly importPath: (path: string) => Promise<void>
  /** Open the picker, then the above. */
  readonly pick: () => Promise<void>
  readonly isImporting: boolean
}

export function useImportSourceImage(project: Project): SourceImport {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const [isImporting, setIsImporting] = useState(false)

  const importPath = async (path: string): Promise<void> => {
    setIsImporting(true)
    try {
      // Minted here because the file is named after it — the manifest entry
      // and the file on disk agree by construction, exactly as they do for a
      // generated image (`jobs/runner.rs`).
      const generationId = crypto.randomUUID()

      const result = await commands.importSourceImage(
        project.id,
        generationId,
        path
      )

      if (result.status === 'error') {
        logger.warn('Could not import a source image', {
          projectId: project.id,
          error: result.error,
        })
        toast.error(importErrorMessage(t, result.error))
        return
      }

      const { assetName, width, height } = result.data

      if (!matchesAspect(width, height, project.aspect)) {
        toast.error(
          t('editor.upload.aspectMismatch', {
            found: describeRatio(width, height),
            aspect: project.aspect,
          })
        )
        return
      }

      dispatch({
        type: 'recordUpload',
        generationId,
        asset: assetName,
        fileName: baseName(path),
        at: Date.now(),
      })
    } finally {
      setIsImporting(false)
    }
  }

  return {
    importPath,
    isImporting,
    pick: async () => {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: t('editor.upload.filterName'), extensions: IMAGE_EXTENSIONS },
        ],
      })

      // `null` is a cancelled dialog, which is not a failure and gets no toast.
      if (typeof picked !== 'string') return
      await importPath(picked)
    },
  }
}

/** The file's own name, for the readout. Both separators, because Windows. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path
}
