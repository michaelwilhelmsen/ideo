import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../shared/SettingsComponents'
import { ApiKeyForm } from '@/components/api-key/ApiKeyForm'
import { FalKeysLink } from '@/components/api-key/FalKeysLink'

/**
 * The Settings home of the fal.ai key.
 *
 * The control itself is shared with onboarding (#32) so the two cannot drift —
 * this pane is the frame around it, plus the link to where a key comes from.
 */
export function ApiKeyPane() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.apiKey.title')}>
        <ApiKeyForm />
        <p className="text-sm text-muted-foreground">
          {t('preferences.apiKey.description')}
        </p>
        <FalKeysLink />
      </SettingsSection>
    </div>
  )
}
