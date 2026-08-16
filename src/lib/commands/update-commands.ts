import { RefreshCw } from 'lucide-react'
import type { AppCommand } from './types'
import { checkForUpdates } from '@/lib/updater'

export const updateCommands: AppCommand[] = [
  /**
   * The manual counterpart to the silent check at launch. Not silent: someone
   * who went looking for this wants an answer either way.
   */
  {
    id: 'app.check-for-updates',
    labelKey: 'commands.checkForUpdates.label',
    descriptionKey: 'commands.checkForUpdates.description',
    icon: RefreshCw,
    group: 'settings',
    keywords: ['update', 'upgrade', 'version', 'release', 'download'],

    execute: async () => {
      await checkForUpdates()
    },
  },
]
