/**
 * Saying what went wrong, once, for every service that has to.
 *
 * Written out four times before #47 — projects, and one per preset library —
 * and about to be a fifth every time a library is added. The libraries are kept
 * apart on purpose (see `services/source-presets.ts`), but this is the part of
 * them that is genuinely not about which library it is: log the technical
 * detail, show the person a sentence with none of it in
 * (`docs/developer/error-handling.md`).
 *
 * Non-React context by definition — it is called from mutation callbacks — so
 * `i18n.t` directly rather than the hook.
 */

import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'

export function report(messageKey: string, error: unknown): void {
  logger.error(messageKey, { error })
  toast.error(i18n.t(messageKey))
}
