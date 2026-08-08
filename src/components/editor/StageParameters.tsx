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
  controlAvailability,
  FIXTURE_REGISTRY,
  modelAvailability,
  modelById,
  modelsForStage,
  presetsForStage,
  selectedGeneration,
  type ControlAvailability,
  type ControlId,
  type Project,
  type StageKind,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { runStageAction, rollSeed } from './run-request'
import { InputSummary } from './shared'

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
  const model = modelById(FIXTURE_REGISTRY, draft.modelId)
  const blocked = blockedReasonKey(project, stage)
  const batch = batchSizeFor(stage, draft)
  const selected = selectedGeneration(project, stage)

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
          value={draft.modelId}
          onChange={event =>
            dispatch({
              type: 'chooseModel',
              stage,
              modelId: event.target.value,
            })
          }
        >
          {modelsForStage(FIXTURE_REGISTRY, stage).map(candidate => {
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
      </Field>

      <Field label={t('editor.field.preset')}>
        <NativeSelect
          className="w-full"
          value={draft.presetId ?? ''}
          onChange={event =>
            dispatch({
              type: 'choosePreset',
              stage,
              presetId: event.target.value === '' ? null : event.target.value,
            })
          }
        >
          <NativeSelectOption value="">
            {t('editor.preset.none')}
          </NativeSelectOption>
          {presetsForStage(stage).map(preset => (
            <NativeSelectOption key={preset.id} value={preset.id}>
              {preset.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

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

          <Gated
            availability={availabilityOf('loop')}
            label={t('editor.field.loop')}
          >
            {disabled => (
              <div className="flex items-center gap-2">
                <Switch
                  id={`${stage}-loop`}
                  checked={draft.options.loop === true}
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
        {/* PRD §10.2 — approximate, dated, and never presented as exact. */}
        <p className="text-xs text-muted-foreground">
          {model.price === null
            ? t('editor.price.unknown')
            : t('editor.price.estimate', {
                amount: (model.price.amount * batch).toFixed(3),
                count: batch,
                unit: model.price.unit,
                date: model.price.verifiedOn,
              })}
        </p>

        <Button
          className="w-full"
          disabled={blocked !== null}
          onClick={() => dispatch(runStageAction(stage, batch))}
        >
          {t('editor.action.run', { count: batch })}
        </Button>

        {blocked !== null && (
          <p className="text-xs text-destructive">{t(blocked)}</p>
        )}
      </div>
    </div>
  )
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
 * the reason attached.
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

  const disabled = availability.state === 'disabled'

  return (
    <div className={cn('space-y-2', disabled && 'opacity-60')}>
      <Label>{label}</Label>
      {children(disabled)}
      {availability.state === 'disabled' && (
        <p className="text-xs text-muted-foreground">
          {t(availability.reasonKey)}
        </p>
      )}
    </div>
  )
}
