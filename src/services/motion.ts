/**
 * The user's own motion library — the fork half of the second library (#29).
 *
 * Deliberately a mirror of `services/presets.ts` rather than a generalisation of
 * it. The two libraries share a *storage* shape and nothing else: different
 * schemas, different validators, different commands, and different reasons to
 * change. Folding them into one parameterised hook would put a `library` string
 * in every call site and make the type of what comes back depend on it, which is
 * a worse trade than the forty lines below.
 *
 * Everything the style service says applies here: TanStack Query owns it because
 * it is persistent data outside the session, Rust treats the documents as opaque
 * because the schema is TypeScript's, and a malformed file is **skipped** with
 * the count carried back — one hand-edited fork must not cost the whole library.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'
import {
  BUILT_IN_MOTION_PRESETS,
  readUserMotionPreset,
  writeUserMotionPreset,
  type MotionPreset,
} from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'

export const motionPresetKeys = {
  all: ['motion-presets'] as const,
  list: () => [...motionPresetKeys.all, 'list'] as const,
}

export interface MotionPresetLibrary {
  readonly presets: readonly MotionPreset[]
  /** How many files could not be read — surfaced, never only logged. */
  readonly unreadable: number
}

export const EMPTY_MOTION_PRESETS: MotionPresetLibrary = {
  presets: [],
  unreadable: 0,
}

/** Every motion preset the user has saved, validated, worst files skipped. */
export function useMotionPresets() {
  return useQuery({
    queryKey: motionPresetKeys.list(),
    queryFn: loadMotionPresets,
  })
}

async function loadMotionPresets(): Promise<MotionPresetLibrary> {
  const result = await commands.motionPresetsList()
  if (result.status === 'error') {
    logger.error('Could not list the saved motion presets', {
      error: result.error,
    })
    throw new Error(result.error)
  }

  const builtInIds = new Set(BUILT_IN_MOTION_PRESETS.map(preset => preset.id))
  const presets: MotionPreset[] = []
  let unreadable = 0

  for (const document of result.data) {
    try {
      const preset = readUserMotionPreset(document)

      // An id we also ship would shadow the built-in everywhere a recipe is
      // read back by id, which turns "which preset produced this" into a
      // question with two answers. Skipped rather than renamed.
      if (builtInIds.has(preset.id)) {
        throw new Error(`Motion preset "${preset.id}" is also a built-in`)
      }

      presets.push(preset)
    } catch (error) {
      unreadable += 1
      logger.warn('Skipped a saved motion preset that could not be read', {
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
 * the style library: a save-as-new mints one with `presetIdFrom`, an update
 * passes the existing one. Built-ins never reach here — theirs is a file in the
 * repo, and read-only.
 */
export function useSaveMotionPreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preset: MotionPreset) => {
      const result = await commands.motionPresetSave(
        preset.id,
        writeUserMotionPreset(preset) as unknown as JsonValue
      )
      if (result.status === 'error') throw new Error(result.error)
      return preset
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: motionPresetKeys.list() })
    },
    onError: error => report('editor.error.saveMotionPreset', error),
  })
}

export function useDeleteMotionPreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (presetId: string) => {
      const result = await commands.motionPresetDelete(presetId)
      if (result.status === 'error') throw new Error(result.error)
      return presetId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: motionPresetKeys.list() })
    },
    onError: error => report('editor.error.deleteMotionPreset', error),
  })
}

/**
 * Says what went wrong, and keeps the technical part out of it —
 * `docs/developer/error-handling.md`. Non-React context, so `i18n.t` directly.
 */
function report(messageKey: string, error: unknown): void {
  logger.error(messageKey, { error })
  toast.error(i18n.t(messageKey))
}
