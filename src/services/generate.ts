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

/**
 * Currently unwired. #22's pane was retired when #33 made the three-stage
 * editor the main window, and the editor still runs on fixtures — #23 is the
 * slice that connects this to the source stage. The Rust side of the exchange
 * is unaffected and still covered by its own tests.
 */

/** Matches PROGRESS_EVENT in src-tauri/src/commands/generate.rs. */
const PROGRESS_EVENT = 'generation-progress'

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
  return useMutation<Generation, GenerationError, string>({
    mutationFn: async (prompt: string): Promise<Generation> => {
      const result = await commands.generateImage(prompt)

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
