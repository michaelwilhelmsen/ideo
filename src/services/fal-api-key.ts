import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { commands, unwrapResult, type KeyCheck } from '@/lib/tauri-bindings'

/**
 * The fal.ai API key lives in the OS keychain and is only ever read in Rust.
 * These hooks deal in presence and validation outcomes — none of them can
 * return the key itself, because no command exposes it.
 */
export const falApiKeyQueryKeys = {
  all: ['fal-api-key'] as const,
  presence: () => [...falApiKeyQueryKeys.all, 'presence'] as const,
}

/**
 * Unwraps a command Result, logging the technical detail before it surfaces as
 * a thrown error the caller turns into a toast.
 */
function unwrapOrThrow<T>(
  result: { status: 'ok'; data: T } | { status: 'error'; error: string },
  context: string
): T {
  if (result.status === 'error') {
    logger.error(context, { error: result.error })
    throw new Error(result.error)
  }

  return result.data
}

/** Whether a key is stored. Local check, no network. */
export function useHasFalApiKey() {
  return useQuery({
    queryKey: falApiKeyQueryKeys.presence(),
    queryFn: async (): Promise<boolean> =>
      unwrapResult(await commands.hasFalApiKey()),
    staleTime: Infinity,
  })
}

/**
 * Validates a pasted key against the live API and stores it if it works.
 * Resolves with the outcome — a rejected key is not an error, it is an answer.
 */
export function useSaveFalApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (key: string): Promise<KeyCheck> =>
      unwrapOrThrow(
        await commands.saveFalApiKey(key),
        'Failed to save fal API key'
      ),
    onSuccess: check => {
      logger.info('fal API key save attempt finished', {
        outcome: check.outcome,
      })
      if (check.outcome === 'valid') {
        queryClient.setQueryData(falApiKeyQueryKeys.presence(), true)
      }
    },
  })
}

/** Re-validates the stored key against the live API. */
export function useCheckFalApiKey() {
  return useMutation({
    mutationFn: async (): Promise<KeyCheck> =>
      unwrapOrThrow(
        await commands.checkFalApiKey(),
        'Failed to check fal API key'
      ),
  })
}

/** Removes the stored key from the keychain. */
export function useClearFalApiKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      unwrapOrThrow(
        await commands.clearFalApiKey(),
        'Failed to clear fal API key'
      )
    },
    onSuccess: () => {
      logger.info('fal API key cleared')
      queryClient.setQueryData(falApiKeyQueryKeys.presence(), false)
    },
  })
}
