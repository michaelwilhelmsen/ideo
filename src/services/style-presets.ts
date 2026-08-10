/**
 * The user's own **style** presets — the fork half of PRD §6, for one of the
 * three libraries.
 *
 * TanStack Query owns it, because it is exactly what the state onion puts there
 * (`docs/developer/state-management.md`): persistent data that lives outside the
 * session, read on demand and re-read when it changes. The built-ins are the
 * other half and need none of this — they are imported JSON, validated once at
 * module load.
 *
 * Why the two halves stay separate all the way up to the picker: a user preset
 * lives in **app-level** app data, not in a project and not in the repo, so a
 * repo update that rewrites every built-in (#48 will) cannot touch it. Rust
 * treats the documents as opaque — the schema is TypeScript's, so validating
 * them is TypeScript's job too, and it happens here, once, on the way in.
 *
 * Source forks are the same document in a different folder and live in
 * `services/source-presets.ts`; movements are a different document again, in
 * `services/motion.ts`. Everything named here says *style* for that reason: a
 * "user preset" is three things now, and only the shape they share
 * ({@link UserPresetLibrary}) can honestly be called that.
 *
 * A malformed file is *skipped*, not thrown. One hand-edited fork must not cost
 * the whole library, and the count is carried back so the picker can say so out
 * loud rather than quietly showing a shorter list.
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

export const stylePresetKeys = {
  all: ['style-presets'] as const,
  list: () => [...stylePresetKeys.all, 'list'] as const,
}

/** What a folder of forks reads back as — the shape all three libraries share. */
export interface UserPresetLibrary {
  readonly presets: readonly Preset[]
  /**
   * How many files could not be read. Surfaced rather than logged only: a
   * library that is quietly one preset short looks like a preset that was
   * quietly deleted.
   */
  readonly unreadable: number
}

export const EMPTY_STYLE_PRESETS: UserPresetLibrary = {
  presets: [],
  unreadable: 0,
}

/** Everything the user has saved, validated, worst files skipped. */
export function useStylePresets() {
  return useQuery({
    queryKey: stylePresetKeys.list(),
    queryFn: loadStylePresets,
  })
}

async function loadStylePresets(): Promise<UserPresetLibrary> {
  const result = await commands.userPresetsList()
  if (result.status === 'error') {
    logger.error('Could not list the saved presets', { error: result.error })
    throw new Error(result.error)
  }

  const presets: Preset[] = []
  let unreadable = 0

  for (const document of result.data) {
    try {
      const preset = readUserPreset(document)

      // An id we also ship would shadow the built-in everywhere a recipe is
      // read back by id, which turns "which preset produced this" into a
      // question with two answers. Asked of **all three** libraries, not this
      // one: `presetById` searches all of them, so a style fork called
      // `gn-monolith` shadows a source built-in just as surely. Skipped rather
      // than renamed — renaming someone's file is not this function's business.
      if (isBuiltInPresetId(preset.id)) {
        throw new Error(`Preset "${preset.id}" is also a built-in`)
      }

      presets.push(preset)
    } catch (error) {
      unreadable += 1
      logger.warn('Skipped a saved preset that could not be read', { error })
    }
  }

  return { presets, unreadable }
}

/**
 * Writes one fork — creating it, or updating one of the user's own in place.
 *
 * Which of the two it is, is decided by the id and nowhere else: the caller
 * mints a fresh one with `presetIdFrom` for a save-as-new and passes the
 * existing one for an update. Built-ins never reach here, because a built-in's
 * id is not a file in the user's folder — it is in the repo, and read-only.
 */
export function useSaveStylePreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preset: Preset) => {
      const result = await commands.userPresetSave(
        preset.id,
        writeUserPreset(preset) as unknown as JsonValue
      )
      if (result.status === 'error') throw new Error(result.error)
      return preset
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: stylePresetKeys.list() })
    },
    onError: error => report('editor.error.savePreset', error),
  })
}

export function useDeleteStylePreset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (presetId: string) => {
      const result = await commands.userPresetDelete(presetId)
      if (result.status === 'error') throw new Error(result.error)
      return presetId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: stylePresetKeys.list() })
    },
    onError: error => report('editor.error.deletePreset', error),
  })
}
