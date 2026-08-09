/**
 * The step the whole flow exists for: leaving with a key that has been proved
 * to work (#32, PRD §7).
 *
 * Both halves are here because neither is any use alone — the address a key
 * comes from, and the field that validates one against the live API before
 * anyone spends money on the assumption that it is good.
 */

import { useTranslation } from 'react-i18next'
import { ApiKeyForm } from '@/components/api-key/ApiKeyForm'
import { FalKeysLink } from '@/components/api-key/FalKeysLink'

export function ApiKeyStep() {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <FalKeysLink />
      <ApiKeyForm />
      <p className="text-sm text-muted-foreground">
        {t('onboarding.apiKey.validated')}
      </p>
    </div>
  )
}
