/**
 * Turning a generation failure into a sentence.
 *
 * Rust names the reason and, when fal said something specific, attaches it;
 * choosing the words is the frontend's job because it is the only side that
 * knows what language to say them in (PRD §10.4). The detail is appended
 * rather than substituted — "fal.ai could not use this request" is still true
 * when the reason it gave is unreadable.
 */

import type { TFunction } from 'i18next'
import type {
  GenerationError,
  ImportError,
  InputImageProblem,
} from '@/lib/tauri-bindings'

export function generationErrorMessage(
  t: TFunction,
  error: GenerationError
): string {
  switch (error.reason) {
    case 'emptyPrompt':
      return t('generate.error.emptyPrompt')
    case 'noApiKey':
      return t('generate.error.noApiKey')
    case 'inputImageUnusable':
      return inputImageMessage(t, error.inputImage)
    case 'keyRejected':
      return t('generate.error.keyRejected')
    case 'requestRejected':
      return error.detail === null
        ? t('generate.error.requestRejected')
        : t('generate.error.requestRejectedBecause', { detail: error.detail })
    case 'rateLimited':
      return t('generate.error.rateLimited')
    case 'offline':
      return t('generate.error.offline')
    case 'jobFailed':
      return error.detail === null
        ? t('generate.error.jobFailed')
        : t('generate.error.jobFailedBecause', { detail: error.detail })
    case 'gaveUpWaiting':
      return t('generate.error.gaveUpWaiting')
    case 'couldNotSave':
      return t('generate.error.couldNotSave')
    case 'unexpected':
      return error.status === null
        ? t('generate.error.unexpected')
        : t('generate.error.unexpectedStatus', { status: error.status })
  }
}

/**
 * Why the image a run was going to restyle could not be used (#28).
 *
 * This refusal never reached fal — it happens before the key is even fetched —
 * so there is no supplied text to append and nothing to quote. Rust names a
 * code and, where the number is the point, the number; every word is chosen
 * here. `null` is a refusal from a build that only had the reason, which reads
 * as the general sentence rather than as a missing one.
 */
function inputImageMessage(
  t: TFunction,
  problem: InputImageProblem | null
): string {
  if (problem === null) return t('generate.error.inputImageUnusable')

  switch (problem.code) {
    case 'noneNamed':
      return t('generate.error.inputImageNoneNamed')
    case 'notOnDisk':
      return t('generate.error.inputImageNotOnDisk')
    case 'unreadable':
      return t('generate.error.inputImageUnreadable')
    case 'unsupportedFormat':
      return t('generate.error.inputImageUnsupportedFormat')
    case 'tooLarge':
      // The ceiling, not the overshoot: "under 10 MB" is actionable and "13.4
      // MB" is only a complaint.
      return t('generate.error.inputImageTooLarge', {
        limit: formatMegabytes(problem.limit),
      })
    case 'noField':
      return t('generate.error.inputImageNoField')
  }
}

/**
 * Why an image the user picked could not be brought in (#27).
 *
 * Same division of labour as above: Rust decides what was wrong with the file,
 * this decides what to say about it. Every one of these is a refusal that
 * happens before anything is recorded and long before any paid call — so the
 * sentence has to be specific enough to act on, which is why the size ceiling
 * and the format we actually found are named rather than alluded to.
 */
export function importErrorMessage(t: TFunction, error: ImportError): string {
  switch (error.reason) {
    case 'notFound':
      return t('editor.upload.error.notFound')
    case 'unreadable':
      return t('editor.upload.error.unreadable')
    case 'unsupportedFormat':
      return error.detail === null || error.detail === 'unknown'
        ? t('editor.upload.error.unsupportedFormat')
        : t('editor.upload.error.unsupportedFormatIs', { format: error.detail })
    case 'tooLarge':
      return t('editor.upload.error.tooLarge', {
        limit: formatMegabytes(error.maxBytes),
      })
    case 'unreadableImage':
      return t('editor.upload.error.unreadableImage')
    case 'couldNotSave':
      return t('editor.upload.error.couldNotSave')
  }
}

/** The ceiling as a round number of megabytes, because that is how it reads. */
function formatMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}
