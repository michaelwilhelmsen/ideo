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
  // Nowhere chosen yet (#31). The export panel asks once and remembers the
  // answer here, so the second export goes where the first one did.
  export_directory: null,
  // Never reconciled (#56). The first pass therefore covers the whole 90 days
  // fal will answer for, rather than the 24 hours its API defaults to.
  reconciled_through: null,
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

/**
 * Records where the last export went (#31, PRD §11).
 *
 * Here rather than in `services/export.ts` because `preferences.json` has one
 * owner: a second module that read, merged and wrote the whole file would be a
 * second place for the load-failure fallback to drift. Not `useSavePreferences`
 * either — that one announces itself with a toast, which is right when somebody
 * pressed Save in a settings pane and wrong on the back of a successful export.
 *
 * Re-reads rather than trusting the cache, so this cannot write back a stale
 * copy of the fields it does not touch. Returns whether it stuck; the caller
 * decides what a "the files are written but we forgot where" is worth saying.
 */
export async function rememberExportDirectory(
  queryClient: ReturnType<typeof useQueryClient>,
  directory: string
): Promise<boolean> {
  const loaded = await commands.loadPreferences()
  const current = loaded.status === 'ok' ? loaded.data : DEFAULT_PREFERENCES
  if (current.export_directory === directory) return true

  const updated = { ...current, export_directory: directory }
  const saved = await commands.savePreferences(updated)
  if (saved.status === 'error') {
    logger.warn('Could not remember the export folder', { error: saved.error })
    return false
  }

  queryClient.setQueryData(preferencesQueryKeys.preferences(), updated)
  return true
}

/**
 * Moves the cost reconciliation watermark forward (#56, ADR 0003).
 *
 * Here rather than in `services/billing.ts` for the reason
 * {@link rememberExportDirectory} is here: `preferences.json` has one owner,
 * and a second module doing its own read-merge-write would be a second place
 * for the load-failure fallback to drift.
 *
 * Never moves it backwards. Two passes can only overlap if one is very slow,
 * and the slow one finishing last must not un-read what the other read.
 */
export async function rememberReconciledThrough(
  queryClient: ReturnType<typeof useQueryClient>,
  through: number
): Promise<boolean> {
  const loaded = await commands.loadPreferences()
  const current = loaded.status === 'ok' ? loaded.data : DEFAULT_PREFERENCES
  if ((current.reconciled_through ?? 0) >= through) return true

  const updated = { ...current, reconciled_through: through }
  const saved = await commands.savePreferences(updated)
  if (saved.status === 'error') {
    // The pass itself succeeded and the manifests hold fal's figures. All this
    // costs is reading the same span again next time.
    logger.warn('Could not record how far costs are reconciled', {
      error: saved.error,
    })
    return false
  }

  queryClient.setQueryData(preferencesQueryKeys.preferences(), updated)
  return true
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
