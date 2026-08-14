/**
 * The user's own looks, and the one render that does not happen in the webview.
 *
 * TanStack Query owns the fork library, for the reason `services/style-presets.ts`
 * gives: it is persistent data living outside the session, read on demand and
 * re-read when it changes. The built-ins are the other half and need none of
 * this — imported JSON, validated once at module load.
 *
 * A malformed file is *skipped*, not thrown. One hand-edited fork must not cost
 * the whole library, and the count is carried back so the picker can say so out
 * loud rather than quietly showing a shorter list.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BUILT_IN_LOOKS,
  isBuiltInLookId,
  readUserLook,
  writeUserLook,
  type EffectsLook,
} from '@/lib/effects'
import { logger } from '@/lib/logger'
import { commands, type CpuEffect, type JsonValue } from '@/lib/tauri-bindings'
import { report } from './report'

export const effectsKeys = {
  all: ['effects-looks'] as const,
  list: () => [...effectsKeys.all, 'list'] as const,
}

export interface UserLookLibrary {
  readonly looks: readonly EffectsLook[]
  /**
   * How many files could not be read. Surfaced rather than logged only: a
   * library that is quietly one look short looks like a look that was quietly
   * deleted.
   */
  readonly unreadable: number
}

export const EMPTY_LOOKS: UserLookLibrary = { looks: [], unreadable: 0 }

/** Everything the user has saved, validated, worst files skipped. */
export function useUserLooks() {
  return useQuery({ queryKey: effectsKeys.list(), queryFn: loadUserLooks })
}

/**
 * Both halves, in one list — ours first, then theirs.
 *
 * The picker wants one list and the renderer wants one lookup, and neither has
 * any business knowing which folder an entry came from.
 */
export function useLookLibrary(): readonly EffectsLook[] {
  const mine = useUserLooks()
  return [...BUILT_IN_LOOKS, ...(mine.data?.looks ?? [])]
}

async function loadUserLooks(): Promise<UserLookLibrary> {
  const result = await commands.effectsLooksList()
  if (result.status === 'error') {
    logger.error('Could not list the saved looks', { error: result.error })
    throw new Error(result.error)
  }

  const looks: EffectsLook[] = []
  let unreadable = 0

  for (const document of result.data) {
    try {
      const look = readUserLook(document)

      // An id we also ship would shadow the built-in everywhere a treatment is
      // read back by id, which turns "which look produced this" into a question
      // with two answers. Skipped rather than renamed — renaming somebody's
      // file is not this function's business.
      if (isBuiltInLookId(look.id)) {
        throw new Error(`Look "${look.id}" is also a built-in`)
      }

      looks.push(look)
    } catch (error) {
      unreadable += 1
      logger.warn('Skipped a saved look that could not be read', { error })
    }
  }

  return { looks, unreadable }
}

export function useSaveLook() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (look: EffectsLook) => {
      const result = await commands.effectsLookSave(
        look.id,
        writeUserLook(look) as unknown as JsonValue
      )
      if (result.status === 'error') throw new Error(result.error)
      return look
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: effectsKeys.list() })
    },
    onError: error => report('effects.error.saveLook', error),
  })
}

export function useDeleteLook() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (lookId: string) => {
      const result = await commands.effectsLookDelete(lookId)
      if (result.status === 'error') throw new Error(result.error)
      return lookId
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: effectsKeys.list() })
    },
    onError: error => report('effects.error.deleteLook', error),
  })
}

// ── The one render that leaves the webview ──────────────────────────────────

export interface TreatedStillRequest {
  readonly projectId: string
  readonly generationId: string
  readonly effect: CpuEffect
}

/**
 * A still through Floyd–Steinberg or Atkinson, as an object URL.
 *
 * The only look that does not render in WebGL2: error diffusion decides each
 * pixel from pixels already decided, which a fragment shader cannot express.
 * Stills only — the pattern crawls between frames, and the tab disables these
 * two on a clip with the reason attached.
 *
 * Keyed by everything that changes the picture, so turning a knob is a cache
 * miss and switching back is a cache hit. The URL is revoked when the query
 * leaves the cache; `gcTime` is what bounds how many are alive at once.
 */
export function useTreatedStill(request: TreatedStillRequest | null) {
  return useQuery({
    queryKey: [...effectsKeys.all, 'still', request] as const,
    enabled: request !== null,
    // A treated frame is a pure function of its inputs, so it never goes stale
    // — the key changes when the picture does.
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: async () => {
      if (request === null) throw new Error('nothing to render')

      const result = await commands.renderTreatedStill(
        request.projectId,
        request.generationId,
        request.effect
      )
      if (result.status === 'error') throw new Error(result.error.reason)

      // The command hands back PNG bytes rather than raw pixels: a
      // full-resolution frame is ~11 MB raw and dithered output compresses
      // hard, so the encode pays for itself on the way through IPC.
      const blob = new Blob([new Uint8Array(result.data)], {
        type: 'image/png',
      })
      return URL.createObjectURL(blob)
    },
  })
}
