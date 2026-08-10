/**
 * The user's own source library — the fork half of the third library (#47).
 *
 * Deliberately a mirror of `services/style-presets.ts` rather than a generalisation of
 * it, for the reason `services/motion.ts` gives at greater length: the three
 * libraries share a *storage* shape and nothing else, and folding them into one
 * parameterised hook would put a `library` string in every call site. Here the
 * case for folding is stronger than it was for motion — source and style share a
 * schema and a validator too, so only the commands and the built-in list differ
 * — and it is still not strong enough. The two have different reasons to change:
 * a source fork is a scene and a style fork is a transform, and the first thing
 * either grows that the other does not would have to be unpicked again.
 *
 * Everything the style service says applies here: TanStack Query owns it because
 * it is persistent data outside the session, Rust treats the documents as opaque
 * because the schema is TypeScript's, and a malformed file is **skipped** with
 * the count carried back — one hand-edited fork must not cost the whole library.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import {
  isBuiltInPresetId,
  readUserPreset,
  writeUserPreset,
} from '@/lib/recipe'
import type { Preset } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { report } from './report'
import type { UserPresetLibrary } from './style-presets'

export const sourcePresetKeys = {
  all: ['source-presets'] as const,
  list: () => [...sourcePresetKeys.all, 'list'] as const,
}

export const EMPTY_SOURCE_PRESETS: UserPresetLibrary = {
  presets: [],
  unreadable: 0,
}

/** Every source preset the user has saved, validated, worst files skipped. */
export function useSourcePresets() {
  return useQuery({
    queryKey: sourcePresetKeys.list(),
    queryFn: loadSourcePresets,
  })
}

async function loadSourcePresets(): Promise<UserPresetLibrary> {
  const result = await commands.sourcePresetsList()
  if (result.status === 'error') {
    logger.error('Could not list the saved source presets', {
      error: result.error,
    })
    throw new Error(result.error)
  }

  const presets: Preset[] = []
  let unreadable = 0

  for (const document of result.data) {
    try {
      const preset = readUserPreset(document)

      // Asked of all three libraries — see the style service for why one
      // library's forks can shadow another library's built-ins.
      if (isBuiltInPresetId(preset.id)) {
        throw new Error(`Source preset "${preset.id}" is also a built-in`)
      }

      presets.push(preset)
    } catch (error) {
      unreadable += 1
      logger.warn('Skipped a saved source preset that could not be read', {
        error,
      })
    }
  }

  return { presets, unreadable }
}

/**
 * Writes one fork — creating it, or updating one of the user's own in place.
 *
 * Which of the two it is, is decided by the id and nowhere else, exactly as in
 * the style library. Built-ins never reach here: a built-in's id is not a file
 * in the user's folder, it is in the repo, and read-only.
 */
export function useSaveSourcePreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preset: Preset) => {
      const result = await commands.sourcePresetSave(
        preset.id,
        writeUserPreset(preset) as unknown as JsonValue
      )
      if (result.status === 'error') throw new Error(result.error)
      return preset
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sourcePresetKeys.list() })
    },
    onError: error => report('editor.error.savePreset', error),
  })
}

export function useDeleteSourcePreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (presetId: string) => {
      const result = await commands.sourcePresetDelete(presetId)
      if (result.status === 'error') throw new Error(result.error)
      return presetId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sourcePresetKeys.list() })
    },
    onError: error => report('editor.error.deletePreset', error),
  })
}
