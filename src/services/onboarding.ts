/**
 * Reading and recording how far a user has been onboarded (#32).
 *
 * The number rides along in `AppPreferences`, so this is a thin layer over the
 * preferences query rather than a store of its own. Recording deliberately
 * bypasses `useSavePreferences`: finishing — or skipping — onboarding is not a
 * moment to congratulate someone with a "Preferences saved" toast.
 *
 * Skipping records the version too. Nagging on every launch is what the
 * replay-from-Settings path exists to make unnecessary.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { commands, type AppPreferences } from '@/lib/tauri-bindings'
import {
  DEFAULT_PREFERENCES,
  preferencesQueryKeys,
  usePreferences,
} from './preferences'

/** The stored version, with "never onboarded" as the answer to every failure. */
export function storedOnboardingVersion(
  preferences: AppPreferences | undefined
): number {
  return preferences?.onboarding_version ?? 0
}

/**
 * The stored version, and whether it has been read yet.
 *
 * `loaded` matters: opening the modal before preferences arrive would show it
 * to a user who finished onboarding months ago.
 */
export function useOnboardingVersion(): {
  version: number
  loaded: boolean
} {
  const { data, isPending } = usePreferences()
  return { version: storedOnboardingVersion(data), loaded: !isPending }
}

/**
 * Records a version as reached — the caller passes the number, because the
 * step list is a component-layer value this hook has no business importing.
 *
 * Silent on success, and silent on failure too:
 * a preferences write that fails means onboarding offers itself again next
 * launch, which is a far better outcome than an error toast at the end of a
 * welcome flow.
 */
export function useRecordOnboardingVersion() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (version: number) => {
      const loaded = await commands.loadPreferences()
      const current: AppPreferences =
        loaded.status === 'ok' ? loaded.data : DEFAULT_PREFERENCES

      const next: AppPreferences = { ...current, onboarding_version: version }
      const result = await commands.savePreferences(next)

      if (result.status === 'error') {
        logger.warn('Could not record onboarding version', {
          error: result.error,
          version,
        })
        return current
      }

      logger.info('Onboarding version recorded', { version })
      return next
    },
    onSuccess: preferences => {
      queryClient.setQueryData(preferencesQueryKeys.preferences(), preferences)
    },
  })
}
