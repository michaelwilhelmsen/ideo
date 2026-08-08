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
import type { GenerationError } from '@/lib/tauri-bindings'

export function generationErrorMessage(
  t: TFunction,
  error: GenerationError
): string {
  switch (error.reason) {
    case 'emptyPrompt':
      return t('generate.error.emptyPrompt')
    case 'noApiKey':
      return t('generate.error.noApiKey')
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
