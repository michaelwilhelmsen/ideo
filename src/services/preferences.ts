import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { commands, type AppPreferences } from '@/lib/tauri-bindings'

// Query keys for preferences
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: () => [...preferencesQueryKeys.all] as const,
}

/**
 * What preferences are before anything has been saved — and what a failed load
 * falls back to. `onboarding_version: 0` is load-bearing: it is what makes a
 * fresh install, and a preferences file written before onboarding existed,
 * both read as "never onboarded" (#32).
 */
export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'system',
  quick_pane_shortcut: null,
  language: null,
  onboarding_version: 0,
}

// TanStack Query hooks following the architectural patterns
export function usePreferences() {
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(),
    queryFn: async (): Promise<AppPreferences> => {
      logger.debug('Loading preferences from backend')
      const result = await commands.loadPreferences()

      if (result.status === 'error') {
        // Return defaults if preferences file doesn't exist yet
        logger.warn('Failed to load preferences, using defaults', {
          error: result.error,
        })
        return DEFAULT_PREFERENCES
      }

      logger.info('Preferences loaded successfully', {
        preferences: result.data,
      })
      return result.data
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preferences: AppPreferences) => {
      logger.debug('Saving preferences to backend', { preferences })
      const result = await commands.savePreferences(preferences)

      if (result.status === 'error') {
        logger.error('Failed to save preferences', {
          error: result.error,
          preferences,
        })
        toast.error('Failed to save preferences', { description: result.error })
        throw new Error(result.error)
      }

      logger.info('Preferences saved successfully')
    },
    onSuccess: (_, preferences) => {
      // Update the cache with the new preferences
      queryClient.setQueryData(preferencesQueryKeys.preferences(), preferences)
      logger.info('Preferences cache updated')
      toast.success('Preferences saved')
    },
  })
}
