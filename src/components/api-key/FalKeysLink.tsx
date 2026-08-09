/**
 * Where a key comes from (#32).
 *
 * "Paste your fal.ai key" is useless to someone who has never had one, so the
 * address is both written out and clickable. It opens in the system browser
 * through the opener plugin — a webview navigating away from the app would be
 * a one-way trip.
 */

import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { logger } from '@/lib/logger'
import { FAL_KEYS_URL } from '@/lib/onboarding/steps'

export function FalKeysLink() {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-primary underline underline-offset-4"
      onClick={() => {
        openUrl(FAL_KEYS_URL).catch(error =>
          logger.warn('Could not open the fal.ai keys page', { error })
        )
      }}
    >
      {t('onboarding.apiKey.getOne', { url: FAL_KEYS_URL })}
      <ExternalLink className="size-3.5" aria-hidden />
    </button>
  )
}
