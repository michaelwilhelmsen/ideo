import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import { logger } from '@/lib/logger'
import {
  commands,
  type Generation,
  type GenerationError,
  type GenerationProgress,
} from '@/lib/tauri-bindings'

/** Matches PROGRESS_EVENT in src-tauri/src/commands/generate.rs. */
const PROGRESS_EVENT = 'generation-progress'

/**
 * Everything Rust needs to make one image and file it under a project.
 *
 * The generation id is minted here rather than returned: the file is named
 * after it, so the manifest entry and the file on disk agree by construction
 * instead of by a reconciliation step.
 */
export interface GenerationRequest {
  readonly projectId: string
  readonly generationId: string
  readonly prompt: string
  readonly aspect: string
  /** The recipe's pinned seed, if it has one (PRD §4.3). */
  readonly pinnedSeed: number | null
}

/**
 * Submits a prompt and resolves with the finished generation.
 *
 * The whole submit → poll → download exchange happens in Rust, so this is one
 * long await; what happens meanwhile arrives via {@link useGenerationProgress}.
 *
 * Rejects with the {@link GenerationError} itself rather than an `Error`, so
 * the component can translate the reason instead of printing a sentence Rust
 * chose.
 */
export function useGenerateImage() {
  return useMutation<Generation, GenerationError, GenerationRequest>({
    mutationFn: async (request: GenerationRequest): Promise<Generation> => {
      const result = await commands.generateImage(
        request.projectId,
        request.generationId,
        request.prompt,
        request.aspect,
        request.pinnedSeed
      )

      if (result.status === 'error') {
        logger.error('Generation failed', {
          reason: result.error.reason,
          detail: result.error.detail,
        })
        throw result.error
      }

      logger.info('Generation complete', {
        requestId: result.data.request_id,
        seed: result.data.seed,
        asset: result.data.asset,
      })
      return result.data
    },
  })
}

/**
 * The latest progress tick from Rust, or null before the first one.
 *
 * Progress is an event rather than a return value because the interesting part
 * happens while the command is still running.
 */
export function useGenerationProgress(): GenerationProgress | null {
  const [progress, setProgress] = useState<GenerationProgress | null>(null)

  useEffect(() => {
    const unlisten = listen<GenerationProgress>(PROGRESS_EVENT, event => {
      setProgress(event.payload)
    })

    return () => {
      unlisten
        .then(stop => stop())
        .catch(() => {
          // The listener was never attached; nothing to detach.
        })
    }
  }, [])

  return progress
}
