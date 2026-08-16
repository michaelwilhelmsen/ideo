/**
 * The parameter panel for one node — its models, prompt, preset, seed, and
 * whatever the model being examined actually supports.
 *
 * Every control asks the registry whether it exists (PRD §5) and the registry
 * answers with one of three states (PRD §10.1): available, disabled with a
 * reason, or gone. No component here knows which capability is headline and
 * which is plumbing; that judgement lives in `controlAvailability`.
 *
 * **One panel, N models** (ADR 0005). The parameter bag is shared across a
 * node's whole fan-out and keyed by each model's own field names, so the panel
 * shows the knobs of *one* model at a time — the focused one — and the rest are
 * reconciled per model at freeze time. Anything above the knobs (prompt, preset,
 * seed, batch size) is genuinely shared and is shown once.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import {
  batchSizeFor,
  blockedReasonKey,
  controlAvailability,
  estimateCost,
  loopsOnEndFrame,
  MAX_BATCH_SIZE,
  MAX_MODELS_PER_NODE,
  MIN_BATCH_SIZE,
  MODEL_REGISTRY,
  modelAvailability,
  modelById,
  modelsForStage,
  pickedGeneration,
  runSizeFor,
  unresolvedVariables,
  type AspectId,
  type ControlAvailability,
  type ControlId,
  type DraftNode,
  type DraftRecipe,
  type ModelCapabilities,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { PresetField } from './PresetField'
import { rollSeed, useRunNode } from './run-request'
import { useCancelJob, useJobProgress, useNodeJobs } from '@/services/jobs'
import { InputRow, InputSummary } from './shared'
import type { GenerationProgress, Job } from '@/lib/tauri-bindings'

/** PRD §6.3 — above this the composition drifts and then disappears. */
const STRENGTH_WARNING_ABOVE = 0.85

/** Below this a two-decimal price rounds to zero, which reads as free. */
const SMALLEST_SHOWN = 0.01

export function NodeParameters({
  project,
  node,
}: {
  project: Project
  node: DraftNode
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  const draft = node.draft

  /**
   * Which model's knobs are on screen.
   *
   * Local rather than in the store, and that is deliberate: it is not a fact
   * about the project, it is not a fact about the session either, and it has a
   * sensible answer without one — the primary model. Persisting it would put a
   * per-node scroll position into `project.json`.
   *
   * Falls back whenever the focused model leaves the fan-out, which is a normal
   * consequence of unticking it in the picker above.
   */
  const [focus, setFocus] = useState<string | null>(null)
  const focusedId =
    focus !== null && draft.modelIds.includes(focus)
      ? focus
      : (draft.modelIds[0] ?? '')

  const model = modelById(MODEL_REGISTRY, focusedId)
  const perModel = batchSizeFor(node)
  const total = runSizeFor(node)
  const picked = pickedGeneration(project, node)
  const { run, isRunning } = useRunNode(project, node, perModel)

  // This node's share of what the project has in flight. Another node has its
  // own panel, and a job belongs to the node that submitted it.
  const inFlight = useNodeJobs(project.id, node.id)

  // PRD §4.4/§10 — a chosen model is validated against the project's locked
  // ratio, and one that cannot serve it is refused here rather than at submit,
  // where the refusal would arrive after the money.
  const unusable = draft.modelIds
    .map(id => ({
      id,
      usable: modelAvailability(modelById(MODEL_REGISTRY, id), project.aspect),
    }))
    .find(entry => entry.usable.state === 'disabled')

  const blocked =
    unusable?.usable.state === 'disabled'
      ? unusable.usable.reasonKey
      : blockedReasonKey(project, node)

  const availabilityOf = (control: ControlId): ControlAvailability =>
    controlAvailability(model, control)

  const strength =
    model.strengthParam === null
      ? null
      : Number(draft.params[model.strengthParam] ?? 0)

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">
          {node.title ?? t(`editor.stage.${node.kind}`)}
        </h2>
        <InputSummary project={project} node={node} />
      </header>

      {/* Which candidate of the upstream node this one consumes. In the sidebar
          rather than on the card because it is a row of thumbnails and a card is
          360px wide — and because choosing an ingredient is a deliberate act,
          not something to be done by accident while panning. */}
      <InputRow project={project} node={node} />

      {/* The fan-out (ADR 0005). A multi-select rather than a `Select`, because
          picking a second model is not a correction of the first: it is asking
          for both, on the same prompt, in one click. */}
      <NodeField label={t('editor.field.models')}>
        <ModelPicker project={project} node={node} />
        <FieldDescription>
          {t('editor.models.hint', { max: MAX_MODELS_PER_NODE })}
        </FieldDescription>
      </NodeField>

      {/* Only worth the row once there is more than one. With a single model
          "which model's knobs are these" is not a question anybody has. */}
      {draft.modelIds.length > 1 && (
        <NodeField label={t('editor.field.focusModel')}>
          <ToggleGroup
            type="single"
            value={focusedId}
            onValueChange={value => value !== '' && setFocus(value)}
            className="flex-wrap justify-start"
          >
            {draft.modelIds.map(id => (
              <ToggleGroupItem
                key={id}
                value={id}
                className="max-w-full truncate text-xs"
              >
                {modelById(MODEL_REGISTRY, id).label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>{t('editor.models.focusHint')}</FieldDescription>
        </NodeField>
      )}

      <NodeField label={t('editor.field.prompt')}>
        <Textarea
          rows={3}
          value={draft.prompt}
          onChange={event =>
            dispatch({
              type: 'setPrompt',
              nodeId: node.id,
              prompt: event.target.value,
            })
          }
        />
        {/* PRD §5's `promptStyle`, said out loud. The registry knows Qwen reads
            a keyword list and everything else reads prose; without this the
            user finds out by writing the wrong kind of prompt and paying. */}
        <FieldDescription>
          {t(`editor.promptStyle.${model.promptStyle}`)}
        </FieldDescription>
      </NodeField>

      {/* Its own component because a style preset is a *seed* (#28): choosing
          one pre-fills the fields above, which brings a re-seed offer, a fork
          flow and a picker that has to say when a preset cannot speak to every
          model in the fan-out. */}
      <PresetField project={project} node={node} />

      {/* Seed. Headline rather than plumbing: a model with no seed makes the
          whole recipe approximate, and that has to be said out loud. Gated on
          the focused model, but the *action* is refused unless every model in
          the fan-out has a seed field — a pin that only half the comparison
          honours is not a pin. */}
      <Gated
        availability={availabilityOf('seed')}
        label={t('editor.field.seed')}
      >
        {disabled => (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id={`${node.id}-seed-pin`}
                checked={draft.seed.mode === 'pinned'}
                disabled={disabled}
                onCheckedChange={checked =>
                  checked
                    ? dispatch({
                        type: 'pinSeed',
                        nodeId: node.id,
                        value: picked?.seed ?? rollSeed(),
                      })
                    : dispatch({ type: 'unpinSeed', nodeId: node.id })
                }
              />
              <Label htmlFor={`${node.id}-seed-pin`}>
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
                      nodeId: node.id,
                      value: Number(event.target.value),
                    })
                  }
                />
                <FieldDescription>
                  {t('editor.seed.collapsesBatch')}
                </FieldDescription>
              </>
            )}
          </div>
        )}
      </Gated>

      {/* PRD §4.2 — how many candidates one click produces **per model**, per
          node (PRD §11). The number is the node's, not the app's, so raising the
          default later leaves this project alone. */}
      <NodeField label={t('editor.field.batchSize')}>
        <Input
          type="number"
          min={MIN_BATCH_SIZE}
          max={MAX_BATCH_SIZE}
          step={1}
          aria-label={t('editor.field.batchSize')}
          value={node.batchSize}
          onChange={event =>
            dispatch({
              type: 'setBatchSize',
              nodeId: node.id,
              size: Number(event.target.value),
            })
          }
        />
        {/* Only where it multiplies. With one model the field name already says
            everything, and a line restating that 4 × 1 is 4 reads as if
            something surprising had happened. */}
        {draft.modelIds.length > 1 && (
          <FieldDescription>
            {t('editor.batch.perModelHint', {
              models: draft.modelIds.length,
              perModel,
              total,
            })}
          </FieldDescription>
        )}
      </NodeField>

      {/* Plumbing: named by the model, so the label comes from the registry. */}
      {model.strengthParam !== null && strength !== null && (
        <NodeField
          label={`${t('editor.field.strength')} (${model.strengthParam})`}
        >
          <Input
            type="number"
            min={0.1}
            max={0.95}
            step={0.05}
            value={strength}
            onChange={event =>
              dispatch({
                type: 'setParam',
                nodeId: node.id,
                key: model.strengthParam ?? 'strength',
                value: Number(event.target.value),
              })
            }
          />
          {/* Two components rather than one with a swapped colour: past the
              window this stops being guidance and becomes a warning, and
              `FieldError` is the one that says so with `role="alert"`. */}
          {strength > STRENGTH_WARNING_ABOVE ? (
            <FieldError>{t('editor.strength.tooHigh')}</FieldError>
          ) : (
            <FieldDescription>{t('editor.strength.window')}</FieldDescription>
          )}
        </NodeField>
      )}

      {model.negativePromptParam !== null && (
        <NodeField label={t('editor.field.negativePrompt')}>
          <Textarea
            rows={2}
            value={String(draft.params[model.negativePromptParam] ?? '')}
            onChange={event =>
              dispatch({
                type: 'setParam',
                nodeId: node.id,
                key: model.negativePromptParam ?? 'negative_prompt',
                value: event.target.value,
              })
            }
          />
        </NodeField>
      )}

      {node.kind === 'animate' && (
        <>
          <Gated
            availability={availabilityOf('duration')}
            label={t('editor.field.duration')}
          >
            {disabled => (
              <Select
                disabled={disabled}
                value={String(
                  draft.params[model.durationParam ?? 'duration'] ?? ''
                )}
                onValueChange={value =>
                  dispatch({
                    type: 'setParam',
                    nodeId: node.id,
                    key: model.durationParam ?? 'duration',
                    value,
                  })
                }
              >
                <SelectTrigger
                  className="w-full"
                  // Named for assistive tech as well: `Gated`, like
                  // `NodeField`, renders a label beside the control rather
                  // than bound to it.
                  aria-label={t('editor.field.duration')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {model.durations.map(duration => (
                    <SelectItem key={duration} value={duration}>
                      {duration}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Gated>

          {model.resolutionParam !== null && (
            <NodeField label={t('editor.field.resolution')}>
              <Select
                value={String(draft.params[model.resolutionParam] ?? '')}
                onValueChange={value =>
                  dispatch({
                    type: 'setParam',
                    nodeId: node.id,
                    key: model.resolutionParam ?? 'resolution',
                    value,
                  })
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t('editor.field.resolution')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {model.resolutions.map(resolution => (
                    <SelectItem key={resolution} value={resolution}>
                      {resolution}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </NodeField>
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
                  id={`${node.id}-loop`}
                  checked={loopsOnEndFrame(model, draft.options)}
                  disabled={disabled}
                  onCheckedChange={checked =>
                    dispatch({
                      type: 'setOption',
                      nodeId: node.id,
                      key: 'loop',
                      value: checked,
                    })
                  }
                />
                <Label htmlFor={`${node.id}-loop`}>
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
                  id={`${node.id}-rewind`}
                  checked={draft.options.rewind === true}
                  disabled={disabled}
                  onCheckedChange={checked =>
                    dispatch({
                      type: 'setOption',
                      nodeId: node.id,
                      key: 'rewind',
                      value: checked,
                    })
                  }
                />
                <Label htmlFor={`${node.id}-rewind`}>
                  {t('editor.rewind.pingPong')}
                </Label>
              </div>
            )}
          </Gated>
        </>
      )}

      <div className="space-y-2 border-t border-border pt-4">
        <CostEstimate
          modelIds={draft.modelIds}
          aspect={project.aspect}
          draft={draft}
          perModel={perModel}
        />

        {/* #46 — a `{{…}}` still in what is about to be sent is said out loud
            and nothing more. PRD §10.1's disabled-with-a-reason is for "you
            can't do this yet"; this is merely probably-wrong, and `{{` is legal
            prose in an editable box. Silence would be wrong too: paid click. */}
        <UnresolvedWarning
          texts={[
            draft.prompt,
            model.negativePromptParam === null
              ? ''
              : String(draft.params[model.negativePromptParam] ?? ''),
          ]}
        />

        <Button
          className="w-full"
          disabled={blocked !== null || isRunning}
          onClick={run}
        >
          {isRunning
            ? t('editor.action.running')
            : t('editor.action.runCount', { count: total })}
        </Button>

        {blocked !== null && (
          <FieldError>{t(blocked, { aspect: project.aspect })}</FieldError>
        )}

        {isRunning && inFlight.length === 0 && (
          <FieldDescription>{t('generate.submitting')}</FieldDescription>
        )}

        <RunningJobs jobs={inFlight} projectId={project.id} />
      </div>
    </div>
  )
}

/**
 * Which models this node fans out to.
 *
 * A checklist rather than a list of radio buttons, because that is the shape of
 * the question ADR 0005 made askable. Everything else about it is the model
 * picker that was already here: the registry decides which models belong to
 * this kind, and one that cannot serve the project's locked ratio is refused
 * with its reason attached rather than hidden.
 *
 * The last model cannot be unticked. A node with no model is a run button that
 * submits nothing, and the honest way to say "not this one" is to tick the
 * replacement first — which is one click either way.
 */
function ModelPicker({ project, node }: { project: Project; node: DraftNode }) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const [open, setOpen] = useState(false)

  const chosen = node.draft.modelIds
  const options = modelsForStage(MODEL_REGISTRY, node.kind)

  const toggle = (modelId: string) => {
    const next = chosen.includes(modelId)
      ? chosen.filter(id => id !== modelId)
      : [...chosen, modelId]

    if (next.length === 0) return
    dispatch({ type: 'setModels', nodeId: node.id, modelIds: next })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t('editor.field.models')}
          className="h-auto w-full justify-between"
        >
          <span className="flex flex-wrap gap-1">
            {chosen.map(id => (
              <Badge key={id} variant="secondary" className="text-[10px]">
                {modelById(MODEL_REGISTRY, id).label}
              </Badge>
            ))}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={t('editor.models.search')} />
          <CommandList>
            <CommandEmpty>{t('editor.models.none')}</CommandEmpty>
            <CommandGroup>
              {options.map(candidate => {
                const usable = modelAvailability(candidate, project.aspect)
                const selected = chosen.includes(candidate.id)
                const full = !selected && chosen.length >= MAX_MODELS_PER_NODE

                return (
                  <CommandItem
                    key={candidate.id}
                    value={candidate.label}
                    disabled={usable.state !== 'available' || full}
                    onSelect={() => toggle(candidate.id)}
                  >
                    <Check
                      className={cn(
                        'size-4',
                        selected ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="flex-1">
                      {candidate.label}
                      {usable.state === 'disabled' && (
                        <span className="text-muted-foreground">
                          {` — ${t(usable.reasonKey, { aspect: project.aspect })}`}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A hole still left in what is about to be sent, immediately above the button
 * that pays for it (#46).
 *
 * Read off the fields rather than off the selected preset, because by now the
 * boxes are the only authority: the text may have been edited, seeded from a
 * preset since deleted, or typed with a `{{` in it on purpose. Both the prompt
 * and the negative, because both go on the wire — and the keys are listed, since
 * "something is unresolved" is not something anyone can act on.
 */
function UnresolvedWarning({ texts }: { texts: readonly string[] }) {
  const { t } = useTranslation()

  const unresolved = [
    ...new Set(texts.flatMap(text => unresolvedVariables(text))),
  ]
  if (unresolved.length === 0) return null

  return (
    <FieldError>
      {t('editor.prompt.unresolved', {
        count: unresolved.length,
        keys: unresolved.map(key => `{{${key}}}`).join(', '),
      })}
    </FieldError>
  )
}

/**
 * PRD §10.2 — a rough number before the money is spent, **summed across the
 * fan-out**, which is the number that actually leaves the account.
 *
 * Approximate, and labelled so, with the date the rate was read on: a figure
 * that looks exact would imply a precision the registry does not have, and the
 * date is what makes a stale price visible rather than merely wrong. Silence is
 * worse than roughness when someone is deciding whether to spend, but a
 * confident wrong number is worse than either.
 *
 * A model that cannot be priced — `gpt-image-2` is token-priced, and a
 * megapixel-billed restyle depends on an input whose size is unknown until it
 * exists — is **counted rather than guessed at**. That is why the total and the
 * unpriced count are shown together instead of the whole estimate collapsing to
 * "unknown" the moment one model in a three-model fan-out cannot be priced:
 * "about $0.12, plus one we cannot price" is actionable where "unknown" is not.
 */
function CostEstimate({
  modelIds,
  aspect,
  draft,
  perModel,
}: {
  modelIds: readonly string[]
  aspect: AspectId
  draft: DraftRecipe
  perModel: number
}) {
  const { t, i18n } = useTranslation()

  const estimates = modelIds.map(id => {
    const model = modelById(MODEL_REGISTRY, id)
    const chosen = draft.params[model.durationParam ?? '']
    return {
      model,
      amount: estimateCost(model, {
        aspect,
        batch: perModel,
        duration: chosen === undefined ? undefined : String(chosen),
      }),
    }
  })

  const priced = estimates.filter(
    (entry): entry is { model: ModelCapabilities; amount: number } =>
      entry.amount !== null && entry.model.price !== null
  )
  const unpriced = estimates.length - priced.length

  if (priced.length === 0) {
    return <FieldDescription>{t('editor.price.unknown')}</FieldDescription>
  }

  const total = priced.reduce((sum, entry) => sum + entry.amount, 0)

  // The currency is fixed and the formatting is not: fal.ai bills in US
  // dollars wherever you are, but where the symbol goes and which separators
  // it takes are facts about the language, not about the charge (PRD §10.4).
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
  })

  // The oldest verification date across the fan-out, because that is the one a
  // reader should be suspicious of — quoting the freshest would make a stale
  // price look checked.
  const verifiedOn = priced
    .map(entry => entry.model.price?.verifiedOn ?? '')
    .sort()
    .at(0)

  return (
    <FieldDescription>
      {t('editor.price.approximate', {
        // Two decimals, because that is what a price looks like — except when
        // two decimals would round a real charge to zero, which reads as free.
        // That case is a sentence rather than a symbol, because "less than" is
        // a word and words get translated.
        amount:
          total > 0 && total < SMALLEST_SHOWN
            ? t('editor.price.lessThan', { amount: money.format(0.01) })
            : money.format(total),
        date: verifiedOn,
      })}
      {unpriced > 0 &&
        ` ${t('editor.price.plusUnpriced', { count: unpriced })}`}
    </FieldDescription>
  )
}

/** A labelled row. Named for the panel it belongs to, not for a stage. */
function NodeField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </Field>
  )
}

/**
 * PRD §10.1 in one place: a control the model supports is rendered, one it does
 * not is either shown disabled with its reason or not shown at all. Which of
 * the two is the registry's judgement, never the component's.
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

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {children(availability.state === 'disabled')}
      {availability.state === 'disabled' && (
        <FieldDescription>{t(availability.reasonKey)}</FieldDescription>
      )}
    </Field>
  )
}

/**
 * What this node has on the queue right now, and the way to stop each of them.
 *
 * The progress map is subscribed to **once** here rather than per row: it is one
 * event listener over every running job, and a hook per row would register one
 * listener per candidate — sixteen of them on a full fan-out (ADR 0005).
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
      <FieldDescription>{t('generate.job.noRefund')}</FieldDescription>
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
