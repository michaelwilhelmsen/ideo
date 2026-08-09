/**
 * The preset control — picking a look, and forking it once you have changed it.
 *
 * A preset here is a **seed, not a filter** (#28): choosing one pre-fills the
 * prompt box with the fully composed prompt, plus strength and the negative
 * where the model has fields for them, and every one of them stays editable.
 * That is the whole reason this is not a one-line `<select>` any more — a seed
 * has consequences the user has to be able to see and undo:
 *
 * - A preset that does not speak the selected model's idiom is **disabled with
 *   its reason attached** (PRD §10.1), because seeding the other idiom is the
 *   cross-send `composePreset` exists to refuse, and seeding nothing at all
 *   looks like a broken picker.
 * - Switching models keeps whatever the user has written and **offers** a
 *   re-seed. Never forces one: the text may be theirs by now.
 * - Saving is the fork flow. Save-as-new always works; updating one of your own
 *   rewrites the current idiom and keeps the other verbatim, and is refused
 *   outright where the model reads an idiom this fork never spoke. Built-ins have
 *   no edit or delete affordance at all — they come from the repo and a repo
 *   update must never be able to touch yours.
 *
 * Animate has the same control over a second, independent library (#29) — look
 * and movement are orthogonal, so a recipe picks one of each. It is the simpler
 * of the two by exactly as much as its schema is: one field is seeded, no preset
 * is ever unsupported because there are no idioms, and an update cannot destroy
 * an idiom it was not saved from.
 *
 * Source still picks from a fixture list with nothing to compose (#34 gives it a
 * library of its own), so it gets the plain control.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select'
import {
  BUILT_IN_MOTION_PRESETS,
  BUILT_IN_STYLE_PRESETS,
  MODEL_REGISTRY,
  modelById,
  motionPresetFrom,
  motionSeedState,
  presetIdFrom,
  presetSeedState,
  presetsForStage,
  presetSupportsModel,
  userPresetFrom,
  type ModelCapabilities,
  type MotionPreset,
  type PresetCapture,
  type Project,
  type StageKind,
  type StageRecipe,
  type StylePreset,
} from '@/lib/recipe'
import {
  EMPTY_MOTION_PRESETS,
  useDeleteMotionPreset,
  useMotionPresets,
  useSaveMotionPreset,
} from '@/services/motion'
import {
  EMPTY_USER_PRESETS,
  useDeleteUserPreset,
  useSaveUserPreset,
  useUserPresets,
} from '@/services/presets'
import { useEditorStore } from '@/store/editor-store'

export function PresetField({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  switch (stage) {
    case 'style':
      return <StylePresetField project={project} />
    case 'animate':
      return <MotionPresetField project={project} />
    case 'source':
      return <FixturePresetField project={project} stage={stage} />
  }
}

/**
 * The style library: ours and the user's, in one picker but never mixed up.
 *
 * Grouped rather than concatenated because the two halves behave differently —
 * one is read-only and ships with the app, the other is the user's and can be
 * updated or deleted — and a picker that hid that would make the read-only half
 * look broken the moment someone tried to edit it.
 */
function StylePresetField({ project }: { project: Project }) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const { data } = useUserPresets()
  const { presets: userPresets, unreadable } = data ?? EMPTY_USER_PRESETS

  const draft = project.drafts.style
  const model = modelById(MODEL_REGISTRY, draft.modelId)

  /** Everything selectable, in picker order — ours first, then theirs. */
  const library = [...BUILT_IN_STYLE_PRESETS, ...userPresets]

  const selected = library.find(preset => preset.id === draft.presetId) ?? null
  /** Only your own can be updated in place or deleted. */
  const yours = userPresets.some(preset => preset.id === draft.presetId)
  const seed = presetSeedState(draft.prompt, selected, model)

  const [savingAs, setSavingAs] = useState(false)
  const [deleting, setDeleting] = useState<StylePreset | null>(null)

  const save = useSaveUserPreset()
  const remove = useDeleteUserPreset()

  const choose = (preset: StylePreset | null): void => {
    dispatch({
      type: 'choosePreset',
      stage: 'style',
      presetId: preset?.id ?? null,
      preset,
    })
  }

  /** The pointer only — used after a save, when the form already agrees. */
  const point = (presetId: string | null): void => {
    dispatch({ type: 'choosePreset', stage: 'style', presetId, preset: null })
  }

  const option = (preset: StylePreset) => {
    const usable = presetSupportsModel(preset, model)
    return (
      <NativeSelectOption key={preset.id} value={preset.id} disabled={!usable}>
        {/* A name is user data, whoever wrote it (PRD §6) — no `t()` near it.
            The reason for a refusal is ours, and is translated. */}
        {preset.name}
        {usable
          ? ''
          : ` — ${t('editor.preset.noIdiom', { idiom: idiomOf(t, model) })}`}
      </NativeSelectOption>
    )
  }

  // A preset with an empty prompt is not a preset — it would read back as a
  // variant with nothing in it, which the loader refuses on the way in.
  const savable = draft.prompt.trim() !== '' && !save.isPending

  /**
   * Updating needs a preset this model's idiom can actually be read back into.
   *
   * On `unsupported` the form was never seeded from this fork — the model reads
   * an idiom it does not speak — so what is in the box is unrelated text, and
   * writing it in as this fork's missing idiom would be putting words in the
   * preset's mouth. Disabled with the reason already on screen (PRD §10.1)
   * rather than hidden: it is still yours, and "Save as new" is right there.
   */
  const updatable = savable && seed.state !== 'unsupported'

  /**
   * Update in place — the current idiom from the form, the other one kept.
   *
   * `selected` goes in as the base so a fork that speaks both idioms survives
   * being updated from a model that reads one of them: a save says what the form
   * in front of you says, and nothing at all about the other idiom.
   */
  const update = (): void => {
    if (selected === null || !yours || !updatable) return

    save.mutate(
      userPresetFrom(
        {
          ...captureOf(draft, model),
          id: selected.id,
          name: selected.name,
        },
        selected
      ),
      {
        onSuccess: preset => {
          // The form *is* the preset now, so the provenance flag goes back to
          // clean — and nothing is re-seeded, because nothing has moved.
          point(preset.id)
          toast.success(t('editor.preset.saved', { name: preset.name }))
        },
      }
    )
  }

  return (
    <div className="space-y-2">
      <Label>{t('editor.field.preset')}</Label>

      <NativeSelect
        className="w-full"
        aria-label={t('editor.field.preset')}
        value={draft.presetId ?? ''}
        onChange={event => {
          const id = event.target.value
          choose(
            id === ''
              ? null
              : (library.find(preset => preset.id === id) ?? null)
          )
        }}
      >
        <NativeSelectOption value="">
          {t('editor.preset.none')}
        </NativeSelectOption>
        <NativeSelectOptGroup label={t('editor.preset.builtIn')}>
          {BUILT_IN_STYLE_PRESETS.map(option)}
        </NativeSelectOptGroup>
        {userPresets.length > 0 && (
          <NativeSelectOptGroup label={t('editor.preset.yours')}>
            {userPresets.map(option)}
          </NativeSelectOptGroup>
        )}
      </NativeSelect>

      {/* The selected preset cannot seed the selected model — usually because a
          model switch landed on an idiom this fork was never saved in. */}
      {seed.state === 'unsupported' && (
        <p className="text-xs text-muted-foreground">
          {t('editor.preset.unsupported', { idiom: idiomOf(t, model) })}
        </p>
      )}

      {/* Offered, never forced (#28): the text in the box may be the user's own
          by now, and re-seeding would spend their edit for them. */}
      {seed.state === 'stale' && (
        <div className="space-y-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => choose(selected)}
          >
            {t('editor.preset.reseed')}
          </Button>
          <p className="text-xs text-muted-foreground">{t(seed.reasonKey)}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!savable}
          onClick={() => setSavingAs(true)}
        >
          {t('editor.preset.saveAsNew')}
        </Button>

        {/* Absent rather than disabled on a built-in: read-only is not a
            failure state, and offering the button would imply ours are yours. */}
        {yours && selected !== null && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!updatable}
              onClick={update}
            >
              {t('editor.preset.update')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setDeleting(selected)}
            >
              {t('editor.preset.delete')}
            </Button>
          </>
        )}
      </div>

      <UnreadableNotice count={unreadable} />

      {savingAs && (
        <NamePresetDialog
          description={t('editor.preset.saveDescription', {
            idiom: idiomOf(t, model),
          })}
          suggestion={selected?.name ?? ''}
          pending={save.isPending}
          onClose={() => setSavingAs(false)}
          onSubmit={name => {
            save.mutate(
              userPresetFrom({
                ...captureOf(draft, model),
                id: presetIdFrom(
                  name,
                  library.map(preset => preset.id)
                ),
                name,
              }),
              {
                onSuccess: preset => {
                  // Selected, but deliberately not re-seeded: the form already
                  // says exactly this, and re-seeding would put the preset's
                  // clamped strength back over the number the user just chose.
                  point(preset.id)
                  toast.success(t('editor.preset.saved', { name: preset.name }))
                  setSavingAs(false)
                },
              }
            )
          }}
        />
      )}

      <DeletePresetDialog
        preset={deleting}
        onClose={() => setDeleting(null)}
        onDelete={doomed => {
          remove.mutate(doomed.id, {
            onSuccess: () => {
              // The text stays; only the pointer to a preset that no longer
              // exists goes.
              if (draft.presetId === doomed.id) point(null)
            },
          })
        }}
      />
    </div>
  )
}

/**
 * The motion library: ours and the user's, over the same fork flow.
 *
 * Shorter than its style counterpart by exactly the amount `motion.ts` is
 * shorter than `presets.ts`, and every missing piece is missing for a reason
 * rather than unfinished. There is no idiom, so no preset is ever disabled and
 * no save can put words in a fork's mouth; there is no strength and no negative,
 * so seeding writes the prompt and stops. What is left is the part that
 * matters — the prompt box is pre-filled and stays editable, and what is in it
 * is exactly what is sent.
 */
function MotionPresetField({ project }: { project: Project }) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const { data } = useMotionPresets()
  const { presets: userPresets, unreadable } = data ?? EMPTY_MOTION_PRESETS

  const draft = project.drafts.animate

  /** Everything selectable, in picker order — ours first, then theirs. */
  const library = [...BUILT_IN_MOTION_PRESETS, ...userPresets]

  const selected = library.find(preset => preset.id === draft.presetId) ?? null
  /** Only your own can be updated in place or deleted. */
  const yours = userPresets.some(preset => preset.id === draft.presetId)
  const seed = motionSeedState(draft.prompt, selected)

  const [savingAs, setSavingAs] = useState(false)
  const [deleting, setDeleting] = useState<MotionPreset | null>(null)

  const save = useSaveMotionPreset()
  const remove = useDeleteMotionPreset()

  const choose = (preset: MotionPreset | null): void => {
    dispatch({
      type: 'choosePreset',
      stage: 'animate',
      presetId: preset?.id ?? null,
      preset,
    })
  }

  /** The pointer only — used after a save, when the form already agrees. */
  const point = (presetId: string | null): void => {
    dispatch({ type: 'choosePreset', stage: 'animate', presetId, preset: null })
  }

  // A preset with an empty prompt is not a preset — the loader refuses one on
  // the way back in.
  const savable = draft.prompt.trim() !== '' && !save.isPending

  return (
    <div className="space-y-2">
      <Label>{t('editor.field.motionPreset')}</Label>

      <NativeSelect
        className="w-full"
        aria-label={t('editor.field.motionPreset')}
        value={draft.presetId ?? ''}
        onChange={event => {
          const id = event.target.value
          choose(
            id === ''
              ? null
              : (library.find(preset => preset.id === id) ?? null)
          )
        }}
      >
        <NativeSelectOption value="">
          {t('editor.preset.none')}
        </NativeSelectOption>
        <NativeSelectOptGroup label={t('editor.preset.builtIn')}>
          {BUILT_IN_MOTION_PRESETS.map(preset => (
            /* A name is user data, whoever wrote it (PRD §6) — no `t()` near
               it. And nothing here is ever disabled: a motion preset speaks to
               every video model, because there is only one idiom. */
            <NativeSelectOption key={preset.id} value={preset.id}>
              {preset.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
        {userPresets.length > 0 && (
          <NativeSelectOptGroup label={t('editor.preset.yours')}>
            {userPresets.map(preset => (
              <NativeSelectOption key={preset.id} value={preset.id}>
                {preset.name}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        )}
      </NativeSelect>

      <p className="text-xs text-muted-foreground">
        {t('editor.preset.motionHint')}
      </p>

      {/* Offered, never forced: the text in the box may be the user's own by
          now, and re-seeding would spend their edit for them. */}
      {seed === 'stale' && (
        <div className="space-y-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => choose(selected)}
          >
            {t('editor.preset.reseed')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('editor.preset.staleEdited')}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!savable}
          onClick={() => setSavingAs(true)}
        >
          {t('editor.preset.saveAsNew')}
        </Button>

        {/* Absent rather than disabled on a built-in: read-only is not a
            failure state, and offering the button would imply ours are yours. */}
        {yours && selected !== null && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!savable}
              onClick={() => {
                save.mutate(
                  motionPresetFrom({
                    id: selected.id,
                    name: selected.name,
                    prompt: draft.prompt,
                  }),
                  {
                    onSuccess: preset => {
                      // The form *is* the preset now, so the provenance flag
                      // goes back to clean and nothing is re-seeded.
                      point(preset.id)
                      toast.success(
                        t('editor.preset.saved', { name: preset.name })
                      )
                    },
                  }
                )
              }}
            >
              {t('editor.preset.update')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setDeleting(selected)}
            >
              {t('editor.preset.delete')}
            </Button>
          </>
        )}
      </div>

      <UnreadableNotice count={unreadable} />

      {savingAs && (
        <NamePresetDialog
          description={t('editor.preset.saveMotionDescription')}
          suggestion={selected?.name ?? ''}
          pending={save.isPending}
          onClose={() => setSavingAs(false)}
          onSubmit={name => {
            save.mutate(
              motionPresetFrom({
                id: presetIdFrom(
                  name,
                  library.map(preset => preset.id)
                ),
                name,
                prompt: draft.prompt,
              }),
              {
                onSuccess: preset => {
                  point(preset.id)
                  toast.success(t('editor.preset.saved', { name: preset.name }))
                  setSavingAs(false)
                },
              }
            )
          }}
        />
      )}

      <DeletePresetDialog
        preset={deleting}
        onClose={() => setDeleting(null)}
        onDelete={doomed => {
          remove.mutate(doomed.id, {
            onSuccess: () => {
              // The text stays; only the pointer to a preset that no longer
              // exists goes.
              if (draft.presetId === doomed.id) point(null)
            },
          })
        }}
      />
    </div>
  )
}

/**
 * Naming a fork — the one dialog both libraries use.
 *
 * The name is the only thing asked for, because everything else is already on
 * screen: that is what "the form is the preset" means, and it is equally true of
 * a style fork with three seeded fields and a motion fork with one. What differs
 * between them is what gets written, which is the caller's `onSubmit` and
 * nothing here.
 *
 * The id is derived from the name rather than typed — it becomes a file name in
 * app data, and a collision takes a suffix instead of overwriting somebody's
 * earlier fork.
 */
function NamePresetDialog({
  description,
  suggestion,
  pending,
  onSubmit,
  onClose,
}: {
  description: string
  suggestion: string
  pending: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(suggestion)

  const trimmed = name.trim()

  const submit = (): void => {
    if (trimmed === '') return
    onSubmit(trimmed)
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editor.preset.saveTitle')}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="save-preset-name">{t('editor.preset.name')}</Label>
          <Input
            id="save-preset-name"
            autoFocus
            value={name}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') submit()
            }}
            placeholder={t('editor.preset.namePlaceholder')}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('editor.action.cancel')}
          </Button>
          <Button disabled={trimmed === '' || pending} onClick={submit}>
            {t('editor.preset.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What deleting needs to know about a preset: which file, and what to call it.
 *
 * Structural rather than `StylePreset | MotionPreset` because the confirmation
 * genuinely does not care which library it is emptying — widening it to the
 * union would be claiming a difference the dialog does not have.
 */
interface DeletablePreset {
  readonly id: string
  readonly name: string
}

/**
 * Confirming a delete — the second dialog both libraries use.
 *
 * Extracted for the same reason `NamePresetDialog` was: what differs between a
 * style fork and a motion fork is *which* mutation runs and what the pointer
 * does afterwards, which is the caller's `onDelete`. The wording, the shape and
 * the fact that this is destructive-and-confirmed are the same question asked
 * about the same kind of thing, and two copies of it is two places for the
 * confirmation to quietly go missing from one library.
 *
 * `null` renders nothing at all rather than a hidden dialog: "which preset is
 * doomed" and "is the dialog open" are one fact, and keeping them as one is what
 * stops a confirmation from firing at a preset that is no longer selected.
 */
function DeletePresetDialog({
  preset,
  onClose,
  onDelete,
}: {
  preset: DeletablePreset | null
  onClose: () => void
  onDelete: (preset: DeletablePreset) => void
}) {
  const { t } = useTranslation()

  return (
    <AlertDialog
      open={preset !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {/* A name is user data (PRD §6); the sentence around it is ours. */}
            {t('editor.preset.deleteTitle', { name: preset?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('editor.preset.deleteDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('editor.action.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (preset === null) return
              onDelete(preset)
            }}
          >
            {t('editor.preset.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Files in the library folder that could not be read back.
 *
 * Said rather than swallowed: the picker showing fewer forks than the user saved
 * looks like data loss, and one line saying some files could not be read is the
 * difference between a bug report and a hand-edit somebody can go and fix.
 */
function UnreadableNotice({ count }: { count: number }) {
  const { t } = useTranslation()

  if (count === 0) return null

  return (
    <p className="text-xs text-destructive">{t('editor.preset.unreadable')}</p>
  )
}

/** Source: a fixture list, and nothing to compose from it yet (#34). */
function FixturePresetField({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const draft = project.drafts[stage]

  return (
    <div className="space-y-2">
      <Label>{t('editor.field.preset')}</Label>
      <NativeSelect
        className="w-full"
        aria-label={t('editor.field.preset')}
        value={draft.presetId ?? ''}
        onChange={event =>
          dispatch({
            type: 'choosePreset',
            stage,
            presetId: event.target.value === '' ? null : event.target.value,
            // Nothing to seed: these libraries hold a fragment, not a recipe.
            preset: null,
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
    </div>
  )
}

/**
 * The form as it stands — the three fields a preset seeds, read back under the
 * names *this* model gives them.
 *
 * Only the current model's idiom is claimed. A save can speak for the model in
 * front of it and no other — so `userPresetFrom` writes this one variant and
 * takes the other from the preset being updated, if there is one, rather than
 * inventing or discarding it.
 */
function captureOf(
  draft: StageRecipe,
  model: ModelCapabilities
): Omit<PresetCapture, 'id' | 'name'> {
  return {
    promptStyle: model.promptStyle,
    prompt: draft.prompt,
    negative:
      model.negativePromptParam === null
        ? null
        : String(draft.params[model.negativePromptParam] ?? ''),
    strength:
      model.strengthParam === null
        ? null
        : Number(draft.params[model.strengthParam] ?? 0),
  }
}

/** The idiom in two words, for a sentence about why something is refused. */
function idiomOf(t: (key: string) => string, model: ModelCapabilities): string {
  return t(`editor.idiom.${model.promptStyle}`)
}
