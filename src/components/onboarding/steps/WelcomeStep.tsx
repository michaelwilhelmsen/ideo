import { useTranslation } from 'react-i18next'

/** What the app is for, in the three sentences someone will actually read. */
export function WelcomeStep() {
  const { t } = useTranslation()

  return (
    <ul className="space-y-2 text-sm text-muted-foreground">
      <li>{t('onboarding.welcome.stages')}</li>
      <li>{t('onboarding.welcome.cost')}</li>
      <li>{t('onboarding.welcome.browse')}</li>
    </ul>
  )
}
