/**
 * The preset control — picking a scene or a look, and forking it once you have
 * changed it.
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
 * **Source and style share that control** (#47), because they share a type and a
 * loader: both compose a prompt out of a per-idiom variant and one block their
 * library holds, and every sentence above is true of each. What differs is data
 * — which library, which folder a fork of it goes in, and whether its presets
 * carry an aspect hint — so it is passed in rather than branched on.
 *
 * Animate has the same control over a third, independent library (#29). It is
 * the simpler of the two by exactly as much as its schema is: one field is
 * seeded, no preset is ever unsupported because there are no idioms, and an
 * update cannot destroy an idiom it was not saved from.
 */

import type { UseMutationResult } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { FieldDescription } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  composePreset,
  MODEL_REGISTRY,
  modelById,
  motionPresetFrom,
  motionSeedState,
  builtInPresetIds,
  presetIdFrom,
  presetSeedState,
  presetsForStage,
  presetSupportsModel,
  userPresetFrom,
  type ModelCapabilities,
  type MotionPreset,
  type Preset,
  type PresetCapture,
  presetVariablesFor,
  type PresetVariable,
  type PresetVariableValues,
  type Project,
  type DraftNode,
  type DraftRecipe,
} from '@/lib/recipe'
import {
  EMPTY_MOTION_PRESETS,
  useDeleteMotionPreset,
  useMotionPresets,
  useSaveMotionPreset,
} from '@/services/motion'
import {
  EMPTY_STYLE_PRESETS,
  useDeleteStylePreset,
  useSaveStylePreset,
  useStylePresets,
  type UserPresetLibrary,
} from '@/services/style-presets'
import {
  EMPTY_SOURCE_PRESETS,
  useDeleteSourcePreset,
  useSaveSourcePreset,
  useSourcePresets,
} from '@/services/source-presets'
import { useEditorStore } from '@/store/editor-store'
import { ConfirmDeleteDialog, UnreadableNotice } from './library-chrome'

/**
 * The value the "None" row carries.
 *
 * Radix spells "nothing is selected" as `value=""` on the root and refuses it on
 * an item, so deselecting needs a token of its own — and *None* is a genuine
 * choice here, unlike the palette picker's *Custom*, so it cannot become a
 * placeholder. The colon is what makes a collision impossible: `isPresetId`
 * accepts only `[A-Za-z0-9_-]`, so no preset id can ever be this.
 */
const NO_PRESET = ':none'

export function PresetField({
  project,
  node,
}: {
  project: Project
  node: DraftNode
}) {
  switch (node.kind) {
    case 'source':
      return <SourcePresetField project={project} node={node} />
    case 'style':
      return <StylePresetField project={project} node={node} />
    case 'animate':
      return <MotionPresetField node={node} />
  }
}

/**
 * The two composing libraries differ by which folder a fork lands in, and this
 * is where that is decided.
 *
 * Two three-line components rather than one taking the hooks as props: a hook
 * reached through a parameter is a hook whose identity the linter cannot see,
 * and the whole value of keeping the libraries apart is that neither can end up
 * writing into the other's folder by accident.
 */
function StylePresetField({
  project,
  node,
}: {
  project: Project
  node: DraftNode
}) {
  const { data } = useStylePresets()

  return (
    <ComposingPresetField
      // Remounted per **node**, so a save or delete dialog left open does not
      // carry over when another step is selected — and two style steps on one
      // canvas do not share one dialog. The variable fields are keyed by node in
      // the store rather than cleared by this remount (#46), since they have to
      // survive the far more frequent unmount of selecting elsewhere.
      key={node.id}
      project={project}
      node={node}
      kind="style"
      library={data ?? EMPTY_STYLE_PRESETS}
      hintKey={null}
      save={useSaveStylePreset()}
      remove={useDeleteStylePreset()}
    />
  )
}

function SourcePresetField({
  project,
  node,
}: {
  project: Project
  node: DraftNode
}) {
  const { data } = useSourcePresets()

  return (
    <ComposingPresetField
      key={node.id}
      project={project}
      node={node}
      kind="source"
      // Said once, in the one place a ratio appears next to a control: the hint
      // is a note about how the scene was composed and not a setting (PRD §4.4
      // locks aspect at project creation). Without it, a ratio in a picker reads
      // as a ratio the picker sets.
      hintKey="editor.preset.sourceHint"
      library={data ?? EMPTY_SOURCE_PRESETS}
      save={useSaveSourcePreset()}
      remove={useDeleteSourcePreset()}
    />
  )
}

/** The fork flow's two mutations, whichever library they were made for. */
interface ForkFlow {
  readonly save: UseMutationResult<Preset, Error, Preset>
  readonly remove: UseMutationResult<string, Error, string>
}

/**
 * A composing library: ours and the user's, in one picker but never mixed up.
 *
 * Grouped rather than concatenated because the two halves behave differently —
 * one is read-only and ships with the app, the other is the user's and can be
 * updated or deleted — and a picker that hid that would make the read-only half
 * look broken the moment someone tried to edit it.
 */
function ComposingPresetField({
  project,
  node,
  kind,
  hintKey,
  library: { presets: userPresets, unreadable },
  save,
  remove,
}: {
  project: Project
  node: DraftNode
  /** Which library. Narrower than the node's kind, which is why it is separate. */
  kind: 'source' | 'style'
  /** A line under the picker, or `null` where the library needs no preamble. */
  hintKey: string | null
  library: UserPresetLibrary
} & ForkFlow) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  const draft = node.draft
  // The **primary** model of the fan-out (ADR 0005): it is the one seeding
  // writes strength and the negative against, and the one whose field names the
  // shared parameter bag is keyed by. Whether the *rest* of the fan-out can read
  // the preset at all is a separate question, asked by `presetSupportsModel`
  // over every model below — one prompt box cannot be prose for one model and a
  // keyword list for another.
  const model = modelById(MODEL_REGISTRY, draft.modelIds[0] ?? '')

  const builtIns = presetsForStage(kind)
  /** Everything selectable, in picker order — ours first, then theirs. */
  const library = [...builtIns, ...userPresets]

  const selected = library.find(preset => preset.id === draft.presetId) ?? null
  /** Only your own can be updated in place or deleted. */
  const yours = userPresets.some(preset => preset.id === draft.presetId)

  const [savingAs, setSavingAs] = useState(false)
  const [deleting, setDeleting] = useState<Preset | null>(null)

  /**
   * What the variable fields say (#46).
   *
   * In the editor store rather than in a `useState` here, because this panel is
   * unmounted every time the sidebar changes tab: values kept locally came back
   * empty while the prompt box still held the old expansion, which reads as
   * `stale` and silently refuses every later variable edit. Still session state
   * and still never persisted — see `EditorState.presetVariables`.
   *
   * Kept across a change of preset, by name. `{{subject}}` is the same question
   * in 21 of the 22 scenes, and trying the next one for the same subject is what
   * a library of scenes is for — so the new preset takes whatever it asks for
   * and the rest waits for a preset that asks for it.
   */
  const values = useEditorStore(store =>
    presetVariablesFor(store.state, project.id, node.id)
  )

  const composed =
    selected === null
      ? null
      : composePreset(selected, model, project.palette, values)
  const seed = presetSeedState(
    draft.prompt,
    selected,
    model,
    project.palette,
    values
  )

  const choose = (preset: Preset | null, next = values): void => {
    dispatch({
      type: 'choosePreset',
      nodeId: node.id,
      presetId: preset?.id ?? null,
      preset,
      values: next,
    })
  }

  /** The pointer only — used after a save, when the form already agrees. */
  const point = (presetId: string | null): void => {
    dispatch({ type: 'choosePreset', nodeId: node.id, presetId, preset: null })
  }

  /**
   * A variable field changed.
   *
   * Re-seeds the prompt box, unless the box has been edited by hand — in which
   * case the existing "Re-seed" offer appears instead and the user's text
   * stands. #28's settled rule, applied to the one control that would otherwise
   * spend an edit on their behalf: seeding is offered, never forced.
   *
   * Recorded either way. What the field says is not the same question as what
   * the prompt says, and the offer has to be able to take the current answer
   * with it when it is finally accepted.
   */
  const setValue = (key: string, value: string): void => {
    const next: PresetVariableValues = { ...values, [key]: value }
    if (seed.state === 'seeded') {
      choose(selected, next)
      return
    }
    dispatch({ type: 'setPresetVariables', nodeId: node.id, values: next })
  }

  const option = (preset: Preset) => {
    // Every model, not just the primary. A preset that Qwen reads as a keyword
    // list and FLUX reads as prose cannot seed one box for both, and offering it
    // would be the cross-send PRD §6.2 exists to prevent (ADR 0005).
    const usable = draft.modelIds.every(id =>
      presetSupportsModel(preset, modelById(MODEL_REGISTRY, id))
    )
    return (
      <SelectItem key={preset.id} value={preset.id} disabled={!usable}>
        {/* A name is user data, whoever wrote it (PRD §6) — no `t()` near it.
            Everything appended to it is ours, and is translated. */}
        {preset.name}
        {/* Displayed and nothing more (#47). PRD §4.4 locks aspect at project
            creation, so this cannot set it — and it deliberately does not dim,
            sort or hide the ratios that do not match either, because most of
            the source library is composed for something other than whatever
            this project is, and hiding two thirds of a library is a filter
            wearing a hint's clothes. */}
        {preset.aspect === null
          ? ''
          : ` — ${t('editor.preset.aspectHint', { aspect: preset.aspect })}`}
        {usable
          ? ''
          : ` — ${t('editor.preset.noIdiom', { idiom: idiomOf(t, model) })}`}
      </SelectItem>
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
          ...captureOf(draft, model, selected),
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

      <Select
        value={draft.presetId ?? NO_PRESET}
        onValueChange={id => {
          // With the fields as they stand: the new scene asks its own questions,
          // and the ones it shares with the old one have already been answered.
          choose(
            id === NO_PRESET
              ? null
              : (library.find(preset => preset.id === id) ?? null)
          )
        }}
      >
        {/* The name goes on the trigger, not on the root: Radix's root is a
            context provider that renders nothing, so an `aria-label` there
            reaches no element at all. */}
        <SelectTrigger className="w-full" aria-label={t('editor.field.preset')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PRESET}>{t('editor.preset.none')}</SelectItem>
          {/* Grouped by family rather than listed flat (#48). Twenty-eight looks
              and twenty-four scenes is what `family` exists for — a single list
              that long is one the user has to read end to end to find anything,
              and the families are already the vocabulary the library was
              authored in. The user's own forks stay one group: they are grouped
              by being yours, which is the only thing they have in common. */}
          {familiesOf(builtIns).map(([family, presets]) => (
            <SelectGroup key={family}>
              {/* The family is the author's word and stays as written;
                  "Built-in" around it is ours and is translated. Kept on every
                  group rather than said once at the top: drop it and the
                  read-only half of a fifty-entry picker stops being
                  distinguishable from the user's. */}
              <SelectLabel>
                {t('editor.preset.builtInFamily', { family })}
              </SelectLabel>
              {presets.map(option)}
            </SelectGroup>
          ))}
          {userPresets.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t('editor.preset.yours')}</SelectLabel>
              {userPresets.map(option)}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      {hintKey !== null && <FieldDescription>{t(hintKey)}</FieldDescription>}

      <PresetNotes preset={selected} />

      <PresetVariableFields
        variables={composed?.variables ?? []}
        values={values}
        onChange={setValue}
      />

      {/* The selected preset cannot seed the selected model — usually because a
          model switch landed on an idiom this fork was never saved in. */}
      {seed.state === 'unsupported' && (
        <FieldDescription>
          {t('editor.preset.unsupported', { idiom: idiomOf(t, model) })}
        </FieldDescription>
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
          <FieldDescription>{t(seed.reasonKey)}</FieldDescription>
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

      <UnreadableNotice
        count={unreadable}
        messageKey="editor.preset.unreadable"
      />

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
                ...captureOf(draft, model, selected),
                id: presetIdFrom(name, takenIds(library)),
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

      <ConfirmDeleteDialog
        entry={deleting}
        titleKey="editor.preset.deleteTitle"
        descriptionKey="editor.preset.deleteDescription"
        confirmKey="editor.preset.delete"
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
function MotionPresetField({ node }: { node: DraftNode }) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const { data } = useMotionPresets()
  const { presets: userPresets, unreadable } = data ?? EMPTY_MOTION_PRESETS

  const draft = node.draft

  /** Everything selectable, in picker order — ours first, then theirs. */
  const builtIns = presetsForStage('animate')
  const library = [...builtIns, ...userPresets]

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
      nodeId: node.id,
      presetId: preset?.id ?? null,
      preset,
    })
  }

  /** The pointer only — used after a save, when the form already agrees. */
  const point = (presetId: string | null): void => {
    dispatch({ type: 'choosePreset', nodeId: node.id, presetId, preset: null })
  }

  // A preset with an empty prompt is not a preset — the loader refuses one on
  // the way back in.
  const savable = draft.prompt.trim() !== '' && !save.isPending

  return (
    <div className="space-y-2">
      <Label>{t('editor.field.motionPreset')}</Label>

      <Select
        value={draft.presetId ?? NO_PRESET}
        onValueChange={id => {
          choose(
            id === NO_PRESET
              ? null
              : (library.find(preset => preset.id === id) ?? null)
          )
        }}
      >
        <SelectTrigger
          className="w-full"
          aria-label={t('editor.field.motionPreset')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PRESET}>{t('editor.preset.none')}</SelectItem>
          <SelectGroup>
            <SelectLabel>{t('editor.preset.builtIn')}</SelectLabel>
            {builtIns.map(preset => (
              /* A name is user data, whoever wrote it (PRD §6) — no `t()` near
                 it. And nothing here is ever disabled: a motion preset speaks to
                 every video model, because there is only one idiom. */
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectGroup>
          {userPresets.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t('editor.preset.yours')}</SelectLabel>
              {userPresets.map(preset => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <FieldDescription>{t('editor.preset.motionHint')}</FieldDescription>

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
          <FieldDescription>{t('editor.preset.staleEdited')}</FieldDescription>
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

      <UnreadableNotice
        count={unreadable}
        messageKey="editor.preset.unreadable"
      />

      {savingAs && (
        <NamePresetDialog
          description={t('editor.preset.saveMotionDescription')}
          suggestion={selected?.name ?? ''}
          pending={save.isPending}
          onClose={() => setSavingAs(false)}
          onSubmit={name => {
            save.mutate(
              motionPresetFrom({
                id: presetIdFrom(name, takenIds(library)),
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

      <ConfirmDeleteDialog
        entry={deleting}
        titleKey="editor.preset.deleteTitle"
        descriptionKey="editor.preset.deleteDescription"
        confirmKey="editor.preset.delete"
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
 * What the selected preset says about itself — both of it display-only (#48).
 *
 * Two different kinds of statement, and they are deliberately styled apart
 * rather than run together into one paragraph:
 *
 * - The **blurb** is what this look is for. It is the line that makes a
 *   twenty-eight entry library navigable once you have landed on an entry, and
 *   it is user data wherever it came from — no `t()` near it.
 * - The **headline zone** is where the scene leaves room for type. A note for
 *   whoever lays out the page and never a crop: headline type belongs in HTML,
 *   which is the whole reason the source library appends "no lettering" to
 *   every prompt it composes.
 *
 * What is *not* here is the outstanding dither the four reduction recipes want.
 * That is a job for #36 and is declared as `ditherKernel` for it to read — a
 * to-do belongs next to the code that will do it, not in a panel the user can
 * only read and not act on.
 *
 * Nothing here is rendered for a preset that has none of it, which is the
 * normal state of a fork.
 */
function PresetNotes({ preset }: { preset: Preset | null }) {
  const { t } = useTranslation()

  if (preset === null) return null
  if (preset.blurb === null && preset.headlineZone === null) return null

  return (
    <div className="space-y-1">
      {preset.blurb !== null && (
        <FieldDescription>{preset.blurb}</FieldDescription>
      )}

      {preset.headlineZone !== null && (
        <FieldDescription>
          {t(`editor.preset.headlineZone.${preset.headlineZone}`)}
        </FieldDescription>
      )}
    </div>
  )
}

/**
 * The built-ins grouped by family, families in first-appearance order.
 *
 * First appearance rather than alphabetical: the libraries are authored in a
 * deliberate order — the strongest demo first, the subtle and the specialist
 * last — and sorting the groups by name would throw that away in exchange for
 * nothing, since nobody arrives at a preset picker knowing the family name they
 * want. Within a family the authored order stands for the same reason.
 */
function familiesOf(
  presets: readonly Preset[]
): readonly (readonly [string, readonly Preset[]])[] {
  const families = new Map<string, Preset[]>()

  for (const preset of presets) {
    const family = families.get(preset.family)
    if (family === undefined) {
      families.set(preset.family, [preset])
      continue
    }
    family.push(preset)
  }

  return [...families]
}

/**
 * The holes in the selected preset's prompt, as editable fields (#46).
 *
 * One per `{{…}}`, pre-filled with whatever it resolves to — a colour's name
 * where the variable addresses the project palette, the preset's own authored
 * default where it does not. What is in these fields is not stored anywhere: it
 * is spent on the prompt box the moment it changes, and the *expanded* prose is
 * the only thing that reaches a recipe.
 *
 * An empty field is a real state and not an error, which is why nothing here is
 * disabled or marked red. It means the prompt still carries the literal
 * `{{key}}`, which is visible in the box above and warned about next to the run
 * button — hard-blocking would be too strong for text somebody may have meant.
 */
function PresetVariableFields({
  variables,
  values,
  onChange,
}: {
  variables: readonly PresetVariable[]
  values: PresetVariableValues
  onChange: (key: string, value: string) => void
}) {
  const { t } = useTranslation()

  if (variables.length === 0) return null

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <FieldDescription>{t('editor.preset.variablesHint')}</FieldDescription>

      {variables.map(variable => (
        <div key={variable.key} className="space-y-1">
          {/* The key itself, not a translated label: it is the author's word
              and it is what the user sees in the prompt box as `{{subject}}`,
              so renaming it here would break the one link between the field
              and the hole it fills. */}
          <Label htmlFor={`preset-variable-${variable.key}`}>
            {variable.key}
          </Label>
          <Input
            id={`preset-variable-${variable.key}`}
            value={values[variable.key] ?? variable.value}
            placeholder={`{{${variable.key}}}`}
            onChange={event => onChange(variable.key, event.target.value)}
          />
          {variable.fromPalette && (
            <FieldDescription>
              {variable.value === ''
                ? t('editor.preset.variableNoColour')
                : t('editor.preset.variableFromPalette')}
            </FieldDescription>
          )}
        </div>
      ))}
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
 * The form as it stands — the three fields a preset seeds, read back under the
 * names *this* model gives them, plus the one thing carried rather than typed.
 *
 * Only the current model's idiom is claimed. A save can speak for the model in
 * front of it and no other — so `userPresetFrom` writes this one variant and
 * takes the other from the preset being updated, if there is one, rather than
 * inventing or discarding it.
 *
 * `seeded` is whatever the form was filled from, and contributes only its aspect
 * hint. That is not a field on the form, and it comes along anyway because the
 * prompt does: a fork of a scene composed for 3:2 is still composed for 3:2, and
 * dropping the hint would make the fork say less than its own text knows.
 */
function captureOf(
  // The **draft**, not a frozen recipe: a save reads what the form says right
  // now. Every field it touches — prompt, params — is shared across the fan-out,
  // so the model is passed alongside rather than read off the draft (ADR 0005).
  draft: DraftRecipe,
  model: ModelCapabilities,
  seeded: Preset | null
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
    aspect: seeded?.aspect ?? null,
    headlineZone: seeded?.headlineZone ?? null,
    ditherKernel: seeded?.ditherKernel ?? null,
    levelPlacement: seeded?.levelPlacement ?? null,
  }
}

/**
 * The ids a new fork must not take.
 *
 * Every built-in from **all three** libraries, plus this library's forks. The
 * other two libraries' built-ins are in there because `presetById` searches all
 * three: a source fork slugged to `mesh-gradient` would be a second answer to
 * "which preset produced this", and the wrong one is the one that wins. Other
 * libraries' *forks* are not, and cannot be — they are behind their own query,
 * which this control has not loaded — but they are the case a collision costs
 * least, since both names came from the same person.
 */
function takenIds(library: readonly { readonly id: string }[]): string[] {
  return [...builtInPresetIds(), ...library.map(preset => preset.id)]
}

/** The idiom in two words, for a sentence about why something is refused. */
function idiomOf(t: (key: string) => string, model: ModelCapabilities): string {
  return t(`editor.idiom.${model.promptStyle}`)
}
