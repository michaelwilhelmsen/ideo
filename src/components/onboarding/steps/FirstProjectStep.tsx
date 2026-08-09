/**
 * The last step: somewhere to put the work.
 *
 * It hands off to the real new-project dialog rather than reimplementing it,
 * because the aspect ratio is locked at creation (PRD §4.4) and a second,
 * simplified version of that decision is exactly how someone ends up locked
 * into a ratio they did not mean to choose.
 */

import { useTranslation } from 'react-i18next'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

export function FirstProjectStep() {
  const { t } = useTranslation()
  const setNewProjectOpen = useUIStore(state => state.setNewProjectOpen)
  const setOnboardingOpen = useUIStore(state => state.setOnboardingOpen)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('onboarding.firstProject.body')}
      </p>

      <Button
        onClick={() => {
          // Closing here rather than stacking dialogs: the modal has already
          // recorded the version by the time it goes, so this is a finish.
          setOnboardingOpen(false)
          setNewProjectOpen(true)
        }}
      >
        <FolderPlus />
        {t('onboarding.firstProject.create')}
      </Button>
    </div>
  )
}
