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
 * - Saving is the fork flow. Save-as-new always works, updating one of your own
 *   works, and built-ins have no edit or delete affordance at all — they come
 *   from the repo and a repo update must never be able to touch yours.
 *
 * Source and animate still pick from fixture lists with nothing to compose
 * (#34 gives them libraries of their own), so they get the plain control.
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
  BUILT_IN_STYLE_PRESETS,
  MODEL_REGISTRY,
  modelById,
  presetIdFrom,
  presetSeedState,
  presetsForStage,
  presetSupportsModel,
  userPresetFrom,
  type ModelCapabilities,
  type PresetCapture,
  type Project,
  type StageKind,
  type StageRecipe,
  type StylePreset,
} from '@/lib/recipe'
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
  return stage === 'style' ? (
    <StylePresetField project={project} />
  ) : (
    <FixturePresetField project={project} stage={stage} />
  )
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

  const selected =
    [...BUILT_IN_STYLE_PRESETS, ...userPresets].find(
      preset => preset.id === draft.presetId
    ) ?? null
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

  const update = (): void => {
    if (selected === null || !yours) return

    save.mutate(
      userPresetFrom({
        ...captureOf(draft, model),
        id: selected.id,
        name: selected.name,
      }),
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

  // A preset with an empty prompt is not a preset — it would read back as a
  // variant with nothing in it, which the loader refuses on the way in.
  const savable = draft.prompt.trim() !== '' && !save.isPending

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
              : ([...BUILT_IN_STYLE_PRESETS, ...userPresets].find(
                  preset => preset.id === id
                ) ?? null)
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
              disabled={!savable}
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

      {unreadable > 0 && (
        <p className="text-xs text-destructive">
          {t('editor.preset.unreadable')}
        </p>
      )}

      {savingAs && (
        <SavePresetDialog
          draft={draft}
          model={model}
          suggestion={selected?.name ?? ''}
          taken={[...BUILT_IN_STYLE_PRESETS, ...userPresets].map(
            preset => preset.id
          )}
          onClose={() => setSavingAs(false)}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={open => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('editor.preset.deleteTitle', { name: deleting?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('editor.preset.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('editor.action.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const doomed = deleting
                if (doomed === null) return
                remove.mutate(doomed.id, {
                  onSuccess: () => {
                    // The text stays; only the pointer to a preset that no
                    // longer exists goes.
                    if (draft.presetId === doomed.id) point(null)
                  },
                })
              }}
            >
              {t('editor.preset.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Naming a fork.
 *
 * The name is the only thing asked for, because everything else is already on
 * screen — that is what "the form is the preset" means. The id is derived from
 * the name rather than typed: it is a file name in app data, and a collision
 * takes a suffix instead of overwriting somebody's earlier fork.
 */
function SavePresetDialog({
  draft,
  model,
  suggestion,
  taken,
  onClose,
}: {
  draft: StageRecipe
  model: ModelCapabilities
  suggestion: string
  taken: readonly string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const save = useSaveUserPreset()
  const [name, setName] = useState(suggestion)

  const trimmed = name.trim()

  const submit = (): void => {
    if (trimmed === '') return

    save.mutate(
      userPresetFrom({
        ...captureOf(draft, model),
        id: presetIdFrom(trimmed, taken),
        name: trimmed,
      }),
      {
        onSuccess: preset => {
          // Selected, but deliberately not re-seeded: the form already says
          // exactly this, and re-seeding would put the preset's clamped
          // strength back over the number the user just chose.
          dispatch({
            type: 'choosePreset',
            stage: 'style',
            presetId: preset.id,
            preset: null,
          })
          toast.success(t('editor.preset.saved', { name: preset.name }))
          onClose()
        },
      }
    )
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
          <DialogDescription>
            {t('editor.preset.saveDescription', { idiom: idiomOf(t, model) })}
          </DialogDescription>
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
          <Button disabled={trimmed === '' || save.isPending} onClick={submit}>
            {t('editor.preset.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Source and animate: a fixture list, and nothing to compose from it yet. */
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
 * front of it and no other, which is why the other variant comes out `null`.
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
