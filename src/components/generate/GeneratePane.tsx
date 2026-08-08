import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useGenerateImage, useGenerationProgress } from '@/services/generate'
import type { Generation, GenerationError } from '@/lib/tauri-bindings'

const PROMPT_INPUT_ID = 'generation-prompt'

/**
 * Prompt in, image out — the tracer bullet (#22).
 *
 * One model, one size, no persistence: the generation lives in the mutation and
 * is gone on reload. #23 gives it a project to belong to.
 */
export function GeneratePane() {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')

  // The mutation already holds the last result and the last failure, and clears
  // both when a new one starts — no second copy in component state.
  const generate = useGenerateImage()

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-6">
      <div className="space-y-2">
        <Label htmlFor={PROMPT_INPUT_ID}>{t('generate.prompt.label')}</Label>
        <Textarea
          id={PROMPT_INPUT_ID}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={t('generate.prompt.placeholder')}
          rows={3}
          disabled={generate.isPending}
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={() => generate.mutate(prompt.trim())}
            disabled={prompt.trim().length === 0 || generate.isPending}
          >
            {t('generate.action')}
          </Button>
          {generate.isPending && <GenerationStatus />}
        </div>
      </div>

      {generate.error && <GenerationFailure error={generate.error} />}

      {generate.data && <GenerationResult generation={generate.data} />}
    </div>
  )
}

/**
 * What the job is doing right now. Without this a 30-second generation looks
 * like a frozen window.
 */
function GenerationStatus() {
  const { t } = useTranslation()
  const progress = useGenerationProgress()

  const message = () => {
    // No tick yet means the submit itself is still in flight.
    if (progress === null) {
      return t('generate.submitting')
    }

    if (progress.status === 'queued') {
      return progress.queue_position === null
        ? t('generate.queued')
        : t('generate.queuedAt', { position: progress.queue_position })
    }

    return t('generate.generatingFor', {
      seconds: Math.round(progress.elapsed_ms / 1000),
    })
  }

  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Spinner className="size-4" />
      {message()}
    </p>
  )
}

/**
 * The one place a failure reason becomes a sentence — the same split as
 * `ApiKeyPane`, so Rust never has to pick a language.
 */
function GenerationFailure({ error }: { error: GenerationError }) {
  const { t } = useTranslation()

  const message = (): string => {
    switch (error.reason) {
      case 'emptyPrompt':
        return t('generate.error.emptyPrompt')
      case 'noApiKey':
        return t('generate.error.noApiKey')
      case 'keyRejected':
        return t('generate.error.keyRejected')
      case 'requestRejected':
        return error.detail === null
          ? t('generate.error.requestRejected')
          : t('generate.error.requestRejectedBecause', { detail: error.detail })
      case 'rateLimited':
        return t('generate.error.rateLimited')
      case 'offline':
        return t('generate.error.offline')
      case 'jobFailed':
        return error.detail === null
          ? t('generate.error.jobFailed')
          : t('generate.error.jobFailedBecause', { detail: error.detail })
      case 'gaveUpWaiting':
        return t('generate.error.gaveUpWaiting')
      case 'couldNotSave':
        return t('generate.error.couldNotSave')
      default:
        return error.status === null
          ? t('generate.error.unexpected')
          : t('generate.error.unexpectedStatus', { status: error.status })
    }
  }

  return (
    <p role="alert" className="text-sm text-destructive">
      {message()}
    </p>
  )
}

function GenerationResult({ generation }: { generation: Generation }) {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      {/* The fal-hosted URL, not the file on disk — showing the local copy
          needs the asset protocol, which arrives with #23's reopening. */}
      <img
        src={generation.image_url}
        alt={generation.prompt}
        className="w-full rounded-lg border border-border"
      />
      <p className="text-sm text-muted-foreground">
        {t('generate.savedTo', { path: generation.image_path })}
      </p>
    </div>
  )
}
