/**
 * Export, as far as the frontend is concerned (#31, PRD §8).
 *
 * Three things live here and nowhere else: whether this machine has an ffmpeg,
 * where the last export went, and the call that turns a candidate into files.
 * TanStack Query owns the first two because both outlive the session — one is a
 * fact about the machine, the other is in `preferences.json` — which is exactly
 * what the state onion puts there (`docs/developer/state-management.md`).
 *
 * The encode itself is a mutation rather than a job (#24): a job exists because
 * fal charges money and takes minutes across a process boundary that may not
 * survive a quit. ffmpeg is local, free, and finishes in seconds — a queue,
 * a store and a resume path would all be machinery for a problem export does
 * not have.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'
import {
  commands,
  type ExportError,
  type ExportRequest,
} from '@/lib/tauri-bindings'
import { rememberExportDirectory } from './preferences'

export const exportKeys = {
  all: ['export'] as const,
  ffmpeg: () => [...exportKeys.all, 'ffmpeg'] as const,
}

/**
 * Whether there is an ffmpeg to export with.
 *
 * Rust probed at startup and cached the answer, so this is a cheap read rather
 * than a process spawn per render. Never retried and never refetched on focus:
 * a missing ffmpeg does not fix itself while you look away, and the one thing
 * that does fix it — installing one — has a button.
 */
export function useFfmpegStatus() {
  return useQuery({
    queryKey: exportKeys.ffmpeg(),
    queryFn: async () => {
      const result = await commands.ffmpegStatus()
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    staleTime: Infinity,
    retry: false,
  })
}

/** Looks again, after a `brew install` — no relaunch needed. */
export function useRecheckFfmpeg() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      const result = await commands.recheckFfmpeg()
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    onSuccess: status => {
      queryClient.setQueryData(exportKeys.ffmpeg(), status)
      if (!status.available) toast.error(i18n.t('export.stillNotFound'))
    },
  })
}

/**
 * Encodes one candidate, and remembers where it went.
 *
 * Takes the wire shape unchanged rather than a settings type of its own: the
 * two would be the same eight fields, and a copy between them is eight chances
 * for a boolean to end up under the wrong name.
 *
 * The folder is written back to preferences on success rather than at the
 * moment it is picked: an export that failed because the folder was unwritable
 * should not leave that folder as the one we offer next time.
 */
export function useExportGeneration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (request: ExportRequest) => {
      const result = await commands.exportGeneration(request)
      if (result.status === 'error') throw result.error
      return result.data
    },
    onSuccess: async (outcome, request) => {
      toast.success(
        i18n.t('export.done', {
          count: outcome.files.length,
          folder: request.destination,
        })
      )

      // The files are already on disk, so failing to remember where they went
      // is not worth a second toast over a successful export.
      await rememberExportDirectory(queryClient, request.destination)
    },
    onError: (error: ExportError | Error) => {
      logger.error('Export failed', { error })
      toast.error(explain(error))
    },
  })
}

/**
 * The refusal, in the user's own language (PRD §10.4).
 *
 * The same shape `importErrorMessage` takes, one layer down: `i18n.t` rather
 * than a `t` handed in, because this is called from a mutation callback and not
 * from a component — the pattern `services/presets.ts` already uses.
 *
 * Both details the error carries are spent rather than logged only. Which file
 * failed matters when three were asked for and one is missing, and ffmpeg's own
 * last words are the part that distinguishes a codec this build lacks from a
 * disk that filled up.
 */
function explain(error: ExportError | Error): string {
  if (error instanceof Error) return i18n.t('export.error.unknown')

  switch (error.reason) {
    case 'ffmpegMissing':
      return i18n.t('export.error.ffmpegMissing')
    case 'noAsset':
      return i18n.t('export.error.noAsset')
    case 'notAClip':
      return i18n.t('export.error.notAClip')
    case 'nothingRequested':
      return i18n.t('export.error.nothingRequested')
    case 'destinationUnusable':
      return i18n.t('export.error.destinationUnusable', {
        detail: error.message,
      })
    case 'encodeFailed':
      return i18n.t('export.error.encodeFailed', {
        file: fileName(error.deliverable),
        detail: error.detail,
      })
  }
}

/**
 * What to call the file that failed.
 *
 * The deliverable crosses as a bare string, so an unknown one falls back to
 * itself rather than to a missing-translation marker — a name we have never
 * seen is still more use in the sentence than `export.format.undefined`.
 */
function fileName(deliverable: string): string {
  const key = `export.format.${deliverable}`
  return i18n.exists(key) ? i18n.t(key) : deliverable
}
