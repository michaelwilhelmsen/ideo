/**
 * The user's own palettes — the fork half of #49, over the same store the three
 * preset libraries use.
 *
 * A deliberate mirror of `services/style-presets.ts` rather than a
 * generalisation of it, for the reason the source service gives at greater
 * length: what these libraries share is a *storage* shape, and folding them into
 * one parameterised hook would put a `library` string in every call site. Here
 * the case against folding is the strongest of the four — a palette is not a
 * preset at all. It seeds no stage, composes no prompt, and is copied onto a
 * project rather than pointed at by a recipe.
 *
 * Everything the style service says still applies: TanStack Query owns it
 * because it is persistent data outside the session, Rust treats the documents
 * as opaque because the schema is TypeScript's, and a malformed file is
 * **skipped** with the count carried back — one hand-edited palette must not
 * cost the library.
 *
 * The one thing this loader refuses that the preset loaders do not is a palette
 * that breaks the lightness invariant. `readUserPalette` throws on it, so it
 * lands in the skipped count with the malformed ones: the editor refuses to save
 * an invalid palette, and a file that got one there by hand must not be able to
 * put it back on a project.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { readUserPalette, writeUserPalette } from '@/lib/recipe'
import type { NamedPalette } from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { report } from './report'

export const paletteKeys = {
  all: ['palettes'] as const,
  list: () => [...paletteKeys.all, 'list'] as const,
}

/** What the palettes folder reads back as. */
export interface UserPaletteLibrary {
  readonly palettes: readonly NamedPalette[]
  /**
   * How many files could not be read — malformed, from a future build, or
   * carrying a palette the invariant refuses. Surfaced rather than logged only:
   * a library that is quietly one palette short looks like one that was quietly
   * deleted.
   */
  readonly unreadable: number
}

export const EMPTY_PALETTES: UserPaletteLibrary = {
  palettes: [],
  unreadable: 0,
}

/** Every palette the user has saved, validated, worst files skipped. */
export function usePalettes() {
  return useQuery({
    queryKey: paletteKeys.list(),
    queryFn: loadPalettes,
  })
}

async function loadPalettes(): Promise<UserPaletteLibrary> {
  const result = await commands.userPalettesList()
  if (result.status === 'error') {
    logger.error('Could not list the saved palettes', { error: result.error })
    throw new Error(result.error)
  }

  const palettes: NamedPalette[] = []
  let unreadable = 0

  for (const document of result.data) {
    try {
      // No built-in-id check, unlike the preset libraries. Theirs exists because
      // a recipe records a preset id that has to resolve to exactly one library;
      // a palette's id is never written down anywhere, so a fork sharing an id
      // with a built-in shadows nothing — it is two entries in one picker, told
      // apart by the group they are in.
      palettes.push(readUserPalette(document))
    } catch (error) {
      unreadable += 1
      logger.warn('Skipped a saved palette that could not be read', { error })
    }
  }

  return { palettes, unreadable }
}

/**
 * Writes one palette — creating it, or updating one of the user's own in place.
 *
 * Which of the two it is, is decided by the id and nowhere else: the caller
 * mints a fresh one with `paletteIdFrom` for a save-as-new and passes the
 * existing one for an update. Built-ins never reach here — a built-in's id is
 * not a file in the user's folder, it is in the repo, and read-only.
 */
export function useSavePalette() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (named: NamedPalette) => {
      const result = await commands.userPaletteSave(
        named.id,
        writeUserPalette(named) as unknown as JsonValue
      )
      if (result.status === 'error') throw new Error(result.error)
      return named
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: paletteKeys.list() })
    },
    onError: error => report('editor.error.savePalette', error),
  })
}

export function useDeletePalette() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (paletteId: string) => {
      const result = await commands.userPaletteDelete(paletteId)
      if (result.status === 'error') throw new Error(result.error)
      return paletteId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: paletteKeys.list() })
    },
    onError: error => report('editor.error.deletePalette', error),
  })
}
