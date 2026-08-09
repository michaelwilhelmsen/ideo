/**
 * The parameter panel for one stage — model, prompt, preset, seed, and
 * whatever the chosen model actually supports.
 *
 * Every control asks the registry whether it exists (PRD §5) and the registry
 * answers with one of three states (PRD §10.1): available, disabled with a
 * reason, or gone. No component here knows which capability is headline and
 * which is plumbing; that judgement lives in `controlAvailability`.
 *
 * Shared by all three variants because it is *content*. Where it goes — right
 * sidebar, inline drawer, overlay — is the thing being compared.
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  batchSizeFor,
  blockedReasonKey,
  configuredBatchSize,
  controlAvailability,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  estimateCost,
  loopsOnEndFrame,
  MODEL_REGISTRY,
  modelAvailability,
  modelById,
  modelsForStage,
  selectedGeneration,
  type AspectId,
  type ControlAvailability,
  type ControlId,
  type ModelCapabilities,
  type Project,
  type StageKind,
  type StageRecipe,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { PresetField } from './PresetField'
import { rollSeed, useRunStage } from './run-request'
import { useCancelJob, useJobProgress, useStageJobs } from '@/services/jobs'
import { InputSummary } from './shared'
import type { GenerationProgress, Job } from '@/lib/tauri-bindings'

/** PRD §6.3 — above this the composition drifts and then disappears. */
const STRENGTH_WARNING_ABOVE = 0.85

export function StageParameters({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  const draft = project.drafts[stage]
  const model = modelById(MODEL_REGISTRY, draft.modelId)
  // What the project is set to, and what this click would actually produce —
  // the same number until a pinned seed collapses the batch to one.
  const configured = configuredBatchSize(project, stage)
  const batch = batchSizeFor(project, stage)
  const selected = selectedGeneration(project, stage)
  const { run, isRunning } = useRunStage(project, stage, batch)

  // This stage's share of what the project has in flight. Other stages have
  // their own panel, and a job belongs to the stage that submitted it.
  const inFlight = useStageJobs(project.id, stage)

  // PRD §4.4/§10 — the chosen model is validated against the project's locked
  // ratio, and a model that cannot serve it is refused here rather than at
  // submit, where the refusal would arrive after the money.
  const usable = modelAvailability(model, project.aspect)
  const blocked =
    usable.state === 'disabled'
      ? usable.reasonKey
      : blockedReasonKey(project, stage)

  const availabilityOf = (control: ControlId): ControlAvailability =>
    controlAvailability(model, control)

  const strength =
    model.strengthParam === null
      ? null
      : Number(draft.params[model.strengthParam] ?? 0)

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">{t(`editor.stage.${stage}`)}</h2>
        <InputSummary project={project} stage={stage} />
      </header>

      {/* Model — per generation, not per project (PRD §10), and validated
          against the locked aspect ratio here rather than at submit. */}
      <Field label={t('editor.field.model')}>
        <NativeSelect
          className="w-full"
          // Named for assistive tech as well as sighted users: `Field` renders
          // a label beside the control, not one bound to it.
          aria-label={t('editor.field.model')}
          value={draft.modelId}
          onChange={event =>
            dispatch({
              type: 'chooseModel',
              stage,
              modelId: event.target.value,
            })
          }
        >
          {modelsForStage(MODEL_REGISTRY, stage).map(candidate => {
            const usable = modelAvailability(candidate, project.aspect)
            return (
              <NativeSelectOption
                key={candidate.id}
                value={candidate.id}
                disabled={usable.state !== 'available'}
              >
                {candidate.label}
                {usable.state === 'disabled'
                  ? ` — ${t(usable.reasonKey, { aspect: project.aspect })}`
                  : ''}
              </NativeSelectOption>
            )
          })}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">{model.notes}</p>
      </Field>

      <Field label={t('editor.field.prompt')}>
        <Textarea
          rows={3}
          value={draft.prompt}
          onChange={event =>
            dispatch({ type: 'setPrompt', stage, prompt: event.target.value })
          }
        />
        {/* PRD §5's `promptStyle`, said out loud. The registry knows Qwen reads
            a keyword list and everything else reads prose; without this the
            user finds out by writing the wrong kind of prompt and paying. */}
        <p className="text-xs text-muted-foreground">
          {t(`editor.promptStyle.${model.promptStyle}`)}
        </p>
      </Field>

      {/* Its own component because a style preset is a *seed* (#28): choosing
          one pre-fills the fields above, which brings a re-seed offer, a fork
          flow and a picker that has to say when a preset cannot speak to the
          selected model. */}
      <PresetField project={project} stage={stage} />

      {/* Seed. Headline rather than plumbing: a model with no seed makes the
          whole recipe approximate, and that has to be said out loud. */}
      <Gated
        availability={availabilityOf('seed')}
        label={t('editor.field.seed')}
      >
        {disabled => (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id={`${stage}-seed-pin`}
                checked={draft.seed.mode === 'pinned'}
                disabled={disabled}
                onCheckedChange={checked =>
                  checked
                    ? dispatch({
                        type: 'pinSeed',
                        stage,
                        value: selected?.seed ?? rollSeed(),
                      })
                    : dispatch({ type: 'unpinSeed', stage })
                }
              />
              <Label htmlFor={`${stage}-seed-pin`}>
                {t('editor.seed.pin')}
              </Label>
            </div>

            {draft.seed.mode === 'pinned' && (
              <>
                <Input
                  type="number"
                  value={draft.seed.value}
                  disabled={disabled}
                  onChange={event =>
                    dispatch({
                      type: 'pinSeed',
                      stage,
                      value: Number(event.target.value),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t('editor.seed.collapsesBatch')}
                </p>
              </>
            )}
          </div>
        )}
      </Gated>

      {/* PRD §4.2 — how many candidates one click produces, per project and
          per stage (PRD §11). The number is the project's, not the app's, so
          raising the default later leaves this project alone. */}
      <Field label={t('editor.field.batchSize')}>
        <Input
          type="number"
          min={MIN_BATCH_SIZE}
          max={MAX_BATCH_SIZE}
          step={1}
          aria-label={t('editor.field.batchSize')}
          value={configured}
          onChange={event =>
            dispatch({
              type: 'setBatchSize',
              stage,
              size: Number(event.target.value),
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          {t('editor.batch.hint')}
        </p>
      </Field>

      {/* Plumbing: named by the model, so the label comes from the registry. */}
      {model.strengthParam !== null && strength !== null && (
        <Field label={`${t('editor.field.strength')} (${model.strengthParam})`}>
          <Input
            type="number"
            min={0.1}
            max={0.95}
            step={0.05}
            value={strength}
            onChange={event =>
              dispatch({
                type: 'setParam',
                stage,
                key: model.strengthParam ?? 'strength',
                value: Number(event.target.value),
              })
            }
          />
          <p
            className={cn(
              'text-xs',
              strength > STRENGTH_WARNING_ABOVE
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {strength > STRENGTH_WARNING_ABOVE
              ? t('editor.strength.tooHigh')
              : t('editor.strength.window')}
          </p>
        </Field>
      )}

      {model.negativePromptParam !== null && (
        <Field label={t('editor.field.negativePrompt')}>
          <Textarea
            rows={2}
            value={String(draft.params[model.negativePromptParam] ?? '')}
            onChange={event =>
              dispatch({
                type: 'setParam',
                stage,
                key: model.negativePromptParam ?? 'negative_prompt',
                value: event.target.value,
              })
            }
          />
        </Field>
      )}

      {stage === 'animate' && (
        <>
          <Gated
            availability={availabilityOf('duration')}
            label={t('editor.field.duration')}
          >
            {disabled => (
              <NativeSelect
                className="w-full"
                // Named for assistive tech as well: `Gated`, like `Field`,
                // renders a label beside the control rather than bound to it.
                aria-label={t('editor.field.duration')}
                disabled={disabled}
                value={String(
                  draft.params[model.durationParam ?? 'duration'] ?? ''
                )}
                onChange={event =>
                  dispatch({
                    type: 'setParam',
                    stage,
                    key: model.durationParam ?? 'duration',
                    value: event.target.value,
                  })
                }
              >
                {model.durations.map(duration => (
                  <NativeSelectOption key={duration} value={duration}>
                    {duration}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Gated>

          {model.resolutionParam !== null && (
            <Field label={t('editor.field.resolution')}>
              <NativeSelect
                className="w-full"
                aria-label={t('editor.field.resolution')}
                value={String(draft.params[model.resolutionParam] ?? '')}
                onChange={event =>
                  dispatch({
                    type: 'setParam',
                    stage,
                    key: model.resolutionParam ?? 'resolution',
                    value: event.target.value,
                  })
                }
              >
                {model.resolutions.map(resolution => (
                  <NativeSelectOption key={resolution} value={resolution}>
                    {resolution}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}

          {/* Looping is real since #30: the still goes out again as the end
              frame. The switch shows what the *run* would do rather than what
              the draft stores, because the two disagree in both directions —
              a required end frame loops with the option off, and a model with
              no end-frame field does not loop with a carried-over `true` on.
              `loopsOnEndFrame` is the same answer the request builder acts on,
              asked once. The stored `options.loop` is left exactly as the user
              set it, because switching back to an optional model has to bring
              their answer back with it. */}
          <Gated
            availability={availabilityOf('loop')}
            label={t('editor.field.loop')}
          >
            {disabled => (
              <div className="flex items-center gap-2">
                <Switch
                  id={`${stage}-loop`}
                  checked={loopsOnEndFrame(model, draft.options)}
                  disabled={disabled}
                  onCheckedChange={checked =>
                    dispatch({
                      type: 'setOption',
                      stage,
                      key: 'loop',
                      value: checked,
                    })
                  }
                />
                <Label htmlFor={`${stage}-loop`}>
                  {t('editor.loop.endFrame')}
                </Label>
              </div>
            )}
          </Gated>

          <Gated
            availability={availabilityOf('rewind')}
            label={t('editor.field.rewind')}
          >
            {disabled => (
              <div className="flex items-center gap-2">
                <Switch
                  id={`${stage}-rewind`}
                  checked={draft.options.rewind === true}
                  disabled={disabled}
                  onCheckedChange={checked =>
                    dispatch({
                      type: 'setOption',
                      stage,
                      key: 'rewind',
                      value: checked,
                    })
                  }
                />
                <Label htmlFor={`${stage}-rewind`}>
                  {t('editor.rewind.pingPong')}
                </Label>
              </div>
            )}
          </Gated>
        </>
      )}

      <div className="space-y-2 border-t border-border pt-4">
        <CostEstimate
          model={model}
          aspect={project.aspect}
          draft={draft}
          batch={batch}
        />

        <Button
          className="w-full"
          disabled={blocked !== null || isRunning}
          onClick={run}
        >
          {isRunning
            ? t('editor.action.running')
            : t('editor.action.run', { count: batch })}
        </Button>

        {blocked !== null && (
          <p className="text-xs text-destructive">
            {t(blocked, { aspect: project.aspect })}
          </p>
        )}

        {isRunning && inFlight.length === 0 && (
          <p className="text-xs">{t('generate.submitting')}</p>
        )}

        <RunningJobs jobs={inFlight} projectId={project.id} />
      </div>
    </div>
  )
}

/**
 * PRD §10.2 — a rough number before the money is spent.
 *
 * Approximate, and labelled so, with the date the rate was read on: a figure
 * that looks exact would imply a precision the registry does not have, and the
 * date is what makes a stale price visible rather than merely wrong. Silence is
 * worse than roughness when someone is deciding whether to spend, but a
 * confident wrong number is worse than either.
 *
 * `null` is a real answer, not a gap. `gpt-image-2` is token-priced and a
 * megapixel-billed restyle depends on an input whose size we do not know until
 * it exists — both say "unknown" rather than inventing a figure.
 */
function CostEstimate({
  model,
  aspect,
  draft,
  batch,
}: {
  model: ModelCapabilities
  aspect: AspectId
  draft: StageRecipe
  batch: number
}) {
  const { t, i18n } = useTranslation()

  const chosen = draft.params[model.durationParam ?? '']
  const estimate = estimateCost(model, {
    aspect,
    batch,
    duration: chosen === undefined ? undefined : String(chosen),
  })

  if (estimate === null || model.price === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('editor.price.unknown')}
      </p>
    )
  }

  // The currency is fixed and the formatting is not: fal.ai bills in US
  // dollars wherever you are, but where the symbol goes and which separators
  // it takes are facts about the language, not about the charge (PRD §10.4).
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  })

  return (
    <p className="text-xs text-muted-foreground">
      {t('editor.price.approximate', {
        // Two decimals, because that is what a price looks like — except when
        // two decimals would round a real charge to zero, which reads as free.
        // That case is a sentence rather than a symbol, because "less than" is
        // a word and words get translated.
        amount:
          estimate > 0 && estimate < SMALLEST_SHOWN
            ? t('editor.price.lessThan', { amount: money.format(0.01) })
            : money.format(estimate),
        date: model.price.verifiedOn,
      })}
    </p>
  )
}

/** Below this, two decimals would say `$0.00` for something that costs money. */
const SMALLEST_SHOWN = 0.005

/**
 * What the queue is doing, while it does it.
 *
 * The list comes from the job store rather than from this session, so a job
 * submitted before the last quit appears here on relaunch exactly as a fresh
 * one does (#24) — which is the whole claim the slice makes, on screen.
 *
 * A generation takes tens of seconds, so silence would be indistinguishable
 * from a freeze; that is why Rust emits progress rather than returning once at
 * the end.
 */
function RunningJobs({
  jobs,
  projectId,
}: {
  jobs: readonly Job[]
  projectId: string
}) {
  const { t } = useTranslation()
  const progress = useJobProgress()
  const cancel = useCancelJob()

  if (jobs.length === 0) return null

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {jobs.map(job => (
          <li key={job.requestId} className="flex items-center gap-2">
            <span className="flex-1 text-xs text-muted-foreground">
              {statusLine(t, progress[job.requestId])}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate({ requestId: job.requestId, projectId })
              }
            >
              {t('generate.job.cancel')}
            </Button>
          </li>
        ))}
      </ul>

      {/* PRD §3.3 — cancelling may or may not prevent the charge, so this
          never says "free" and never says "refund". */}
      <p className="text-xs text-muted-foreground">
        {t('generate.job.noRefund')}
      </p>
    </div>
  )
}

/** One job's state in a sentence, before any progress has arrived and after. */
function statusLine(
  t: ReturnType<typeof useTranslation>['t'],
  progress: GenerationProgress | undefined
): string {
  if (progress === undefined) return t('generate.job.waiting')

  if (progress.status === 'queued') {
    return progress.queuePosition === null
      ? t('generate.queued')
      : t('generate.queuedAt', { position: progress.queuePosition })
  }

  return t('generate.generatingFor', {
    seconds: Math.round(progress.elapsedMs / 1000),
  })
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

/**
 * PRD §10.1 in one component: hidden means gone, disabled means visible with
 * the reason attached — and `forced` means visible, unclickable, and *on*,
 * which is the one state the control's own value has to come from the registry
 * rather than from the draft (#30).
 *
 * `forced` renders exactly like `disabled` here. The difference is entirely the
 * child's: a locked-on switch has to show itself checked, and only the caller
 * knows what "on" looks like for the control it is rendering.
 */
function Gated({
  availability,
  label,
  children,
}: {
  availability: ControlAvailability
  label: string
  children: (disabled: boolean) => React.ReactNode
}) {
  const { t } = useTranslation()

  if (availability.state === 'hidden') return null

  // Both non-available states take the control out of the user's hands, and
  // both owe them a sentence saying why.
  const disabled = availability.state !== 'available'
  const reasonKey = 'reasonKey' in availability ? availability.reasonKey : null

  return (
    <div className={cn('space-y-2', disabled && 'opacity-60')}>
      <Label>{label}</Label>
      {children(disabled)}
      {reasonKey !== null && (
        <p className="text-xs text-muted-foreground">{t(reasonKey)}</p>
      )}
    </div>
  )
}
