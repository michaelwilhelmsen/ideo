/**
 * The project palette, as something you can change (#46).
 *
 * Six role rows in a fixed order, then the extras, then an add button. Roles
 * cannot be added or removed because a palette that is missing one is not a
 * palette — `ink` and `paper` are what let the reduction and print recipes
 * reference the project instead of hardcoding near-black, and a recipe asking
 * for a role a project does not have would be a hole in a paid prompt.
 *
 * **Editable at all** because it cannot reach backwards. Every recipe persists
 * its expanded prose, so changing a colour here alters nothing already
 * generated — only what the next preset pick seeds. That is the same test
 * `batchSizes` passed under PRD §11, and the reason the aspect ratio, which
 * fails it, is still locked at creation.
 *
 * **Refused rather than crashed.** The same invariant `readPalette` throws on —
 * ink darkest, paper lightest, the three mid roles far enough apart in OKLCH
 * lightness to duotone — is here a disabled Save with the reason under it (PRD
 * §10.1). A value being typed is not persisted data with a mistake in it, and
 * taking the app down over a half-entered hex would be absurd. Reading the same
 * palette back off disk later *is* a crash, and both are the same function.
 *
 * The name field is optional and its placeholder is the name the colour would
 * be given anyway — which is the honest way to show a derived value: visible,
 * clearly not typed, and replaceable by typing.
 *
 * **The library lives here** (#49), above the rows, rather than in preferences:
 * a palette is prompt data on the same footing as a preset, and the three preset
 * libraries put pick-and-fork in the editor for the same reason. Picking one
 * replaces the six roles *and* the extras wholesale — keeping the old extras
 * would be the "reroll rather than comparison" failure roles were introduced to
 * prevent — and it discards whatever was in the draft, which is a thing this
 * dialog is allowed to do because it is cancellable and nothing has been
 * committed yet.
 */

import { formatHex } from 'culori'
import type { TFunction } from 'i18next'
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
import {
  ColorPicker,
  ColorPickerEyeDropper,
  ColorPickerHue,
  ColorPickerSelection,
} from '@/components/kibo-ui/color-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  BUILT_IN_PALETTES,
  isHex,
  isPaletteRole,
  namedPaletteFor,
  nearestColourName,
  PALETTE_ROLES,
  paletteIdFrom,
  paletteProblem,
  type NamedPalette,
  type Palette,
  type PaletteEntry,
  type PaletteProblem,
  type PaletteRole,
  type Project,
} from '@/lib/recipe'
import {
  EMPTY_PALETTES,
  useDeletePalette,
  usePalettes,
  useSavePalette,
} from '@/services/palettes'
import { useEditorStore } from '@/store/editor-store'
import { ConfirmDeleteDialog, UnreadableNotice } from './library-chrome'

/**
 * What the picker shows while the text field holds something that is not a
 * colour yet. Never saved — `complete` refuses the palette until every hex is
 * one, so this is only ever what a swatch looks like mid-keystroke.
 */
const FALLBACK_SWATCH = '#000000'

/** One row's text, as typed — a hex mid-edit is not yet a colour. */
interface EntryDraft {
  readonly hex: string
  readonly name: string
}

/**
 * One entry in the picker: a palette, which half of the library it came from,
 * and a value that identifies it among both.
 *
 * The key exists because **an id does not identify a palette here**. Preset ids
 * are unique across all three preset libraries because a recipe records one and
 * it must resolve to exactly one library; nothing anywhere records a palette id,
 * so a fork called `dusk` alongside our `dusk` is legal and shadows nothing. Two
 * `<option>` sharing a value would make the picker apply the wrong one of them,
 * and `yours` read off a shared id would offer Update and Delete on a built-in.
 */
interface PaletteChoice extends NamedPalette {
  readonly key: string
  readonly yours: boolean
}

function choiceOf(named: NamedPalette, yours: boolean): PaletteChoice {
  return { ...named, key: `${yours ? 'yours' : 'built-in'}:${named.id}`, yours }
}

export function PaletteDialog({
  project,
  onClose,
}: {
  project: Project
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  const [roles, setRoles] = useState<Record<PaletteRole, EntryDraft>>(
    () =>
      Object.fromEntries(
        PALETTE_ROLES.map(role => [role, draftOf(project.palette.roles[role])])
      ) as Record<PaletteRole, EntryDraft>
  )
  const [extras, setExtras] = useState<readonly EntryDraft[]>(() =>
    project.palette.extras.map(draftOf)
  )

  /**
   * The palette this draft was last picked from, or `null` for "whatever the
   * project already had".
   *
   * Session state and nothing more — a project deliberately records no
   * provenance (PRD §11), so this cannot outlive the dialog. It exists because
   * *updating one of your own* needs a target, and the picker's own readout
   * cannot be it: that readout is a value comparison, so it drops to Custom the
   * moment a hex changes, which is exactly when an update becomes worth
   * offering.
   */
  const [pickedFrom, setPickedFrom] = useState<PaletteChoice | null>(null)
  /** What a save would call it. Typed, never inherited — see the save block. */
  const [naming, setNaming] = useState('')
  const [deleting, setDeleting] = useState<NamedPalette | null>(null)

  const { data } = usePalettes()
  const { palettes: userPalettes, unreadable } = data ?? EMPTY_PALETTES
  const savePalette = useSavePalette()
  const removePalette = useDeletePalette()

  /**
   * Everything selectable — **the user's own first**, then ours.
   *
   * That order is the tie-break for {@link namedPaletteFor}, and it is this way
   * round deliberately: two entries can only tie by being the same six colours,
   * so both labels would be equally true, and answering with the user's own is
   * the answer that keeps Update and Delete on screen. Ours are still listed
   * first in the picker — see the groups below, which are rendered from the two
   * halves rather than from this.
   */
  const library: readonly PaletteChoice[] = [
    ...userPalettes.map(named => choiceOf(named, true)),
    ...BUILT_IN_PALETTES.map(named => choiceOf(named, false)),
  ]

  /**
   * Falls back to what the project arrived carrying, which is the case that
   * matters on open: a project sitting on one of your own palettes can be
   * tweaked and updated without picking it again first. Read off the project
   * rather than the draft so it does not move while somebody types.
   */
  const from = pickedFrom ?? namedPaletteFor(project.palette, library)
  /** Only your own can be updated in place or deleted. */
  const yours = from?.yours ?? false

  // Every hex has to be one before the invariant can be asked about at all —
  // `#12` is not a dark colour, it is an unfinished one.
  const complete =
    PALETTE_ROLES.every(role => isHex(roles[role].hex)) &&
    extras.every(entry => isHex(entry.hex))

  const edited: Palette | null = complete
    ? {
        roles: Object.fromEntries(
          PALETTE_ROLES.map(role => [role, entryOf(roles[role])])
        ) as Palette['roles'],
        extras: extras.map(entryOf),
      }
    : null

  const problem = edited === null ? null : paletteProblem(edited)

  const save = (): void => {
    if (edited === null || problem !== null) return
    dispatch({ type: 'setPalette', palette: edited })
    onClose()
  }

  /**
   * What the picker reads, by comparing values rather than by reading an id.
   *
   * Nothing records where a project's colours came from, so this is the only
   * honest answer available — and *Custom* the moment one hex is off is the
   * point rather than a shortcoming: the label is a claim that these six colours
   * are that palette, and a nearly is not.
   */
  const showing = edited === null ? null : namedPaletteFor(edited, library)

  /** A pick replaces the roles **and** the extras. There is no partial apply. */
  const apply = (choice: PaletteChoice): void => {
    setRoles(
      Object.fromEntries(
        PALETTE_ROLES.map(role => [role, draftOf(choice.palette.roles[role])])
      ) as Record<PaletteRole, EntryDraft>
    )
    setExtras(choice.palette.extras.map(draftOf))
    setPickedFrom(choice)
  }

  /** Refused, not warned: no path here writes an invalid palette to disk. */
  const savable = edited !== null && problem === null && !savePalette.isPending

  const saveToLibrary = (named: NamedPalette): void => {
    savePalette.mutate(named, {
      onSuccess: saved => {
        // The draft *is* that palette now, so an update after this one lands on
        // it rather than on whatever it was forked from. Theirs by definition:
        // this is the only way a palette gets into the user's folder.
        setPickedFrom(choiceOf(saved, true))
        setNaming('')
        toast.success(t('editor.palette.saved', { name: saved.name }))
      },
    })
  }

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('editor.palette.title')}</DialogTitle>
          <DialogDescription>
            {t('editor.palette.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <Label htmlFor="palette-library">{t('editor.palette.library')}</Label>
          <NativeSelect
            id="palette-library"
            className="w-full"
            // Keyed by which half it came from as well as by its id — the two
            // halves may legitimately share one. See {@link PaletteChoice}.
            value={showing?.key ?? ''}
            onChange={event => {
              const picked = library.find(
                choice => choice.key === event.target.value
              )
              if (picked !== undefined) apply(picked)
            }}
          >
            {/* Only offered while nothing matches, so it is never a choice that
                does nothing: these six colours are either a palette in the
                library or they are the user's own arrangement. */}
            {showing === null && (
              <NativeSelectOption value="">
                {t('editor.palette.custom')}
              </NativeSelectOption>
            )}
            {/* Ours first here, whatever order `library` resolves ties in: the
                committed palettes are the ones somebody arriving at an empty
                library needs to find. */}
            <NativeSelectOptGroup label={t('editor.palette.builtIn')}>
              {/* A name is user data, whoever wrote it (PRD §6) — no `t()` near
                  it. Ours are authored in the committed library; theirs are
                  typed. */}
              {library
                .filter(choice => !choice.yours)
                .map(choice => (
                  <NativeSelectOption key={choice.key} value={choice.key}>
                    {choice.name}
                  </NativeSelectOption>
                ))}
            </NativeSelectOptGroup>
            {userPalettes.length > 0 && (
              <NativeSelectOptGroup label={t('editor.palette.yours')}>
                {library
                  .filter(choice => choice.yours)
                  .map(choice => (
                    <NativeSelectOption key={choice.key} value={choice.key}>
                      {choice.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
            )}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            {t('editor.palette.libraryHint')}
          </p>
        </div>

        <div className="space-y-3">
          {PALETTE_ROLES.map(role => (
            <EntryRow
              key={role}
              id={`palette-${role}`}
              label={t(`editor.palette.role.${role}`)}
              entry={roles[role]}
              onChange={entry => setRoles({ ...roles, [role]: entry })}
            />
          ))}

          {extras.map((entry, index) => (
            <EntryRow
              // Position is the identity: `extra2` is whatever sits second, and
              // a row that kept a stable key across a removal would leave the
              // fields pointing at the wrong colour.
              key={`extra${index + 1}`}
              id={`palette-extra-${index + 1}`}
              label={t('editor.palette.extra', { number: index + 1 })}
              entry={entry}
              onChange={next =>
                setExtras(extras.map((old, at) => (at === index ? next : old)))
              }
              onRemove={() => setExtras(extras.filter((_, at) => at !== index))}
            />
          ))}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExtras([...extras, { hex: '#808080', name: '' }])}
          >
            {t('editor.palette.addExtra')}
          </Button>
        </div>

        {/* Saving to the library is a separate act from applying to the project
            — the footer does that — so it gets its own block rather than a
            fourth button in the footer. */}
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="palette-save-name">
            {t('editor.palette.paletteName')}
          </Label>
          <Input
            id="palette-save-name"
            value={naming}
            // The palette this came from, offered as what to call the next one
            // rather than filled in: a new palette wants a new name, and
            // pre-filling it is how somebody ends up with two called "Dusk".
            placeholder={from?.name ?? t('editor.palette.namePlaceholder')}
            onChange={event => setNaming(event.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!savable || naming.trim() === ''}
              onClick={() => {
                if (edited === null || problem !== null) return
                const name = naming.trim()
                if (name === '') return
                saveToLibrary({
                  id: paletteIdFrom(
                    name,
                    library.map(named => named.id)
                  ),
                  name,
                  palette: edited,
                })
              }}
            >
              {t('editor.palette.saveAsNew')}
            </Button>

            {/* Absent rather than disabled on a built-in: read-only is not a
                failure state, and offering the button would imply ours are
                yours. */}
            {yours && from !== null && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!savable}
                  onClick={() => {
                    if (edited === null || problem !== null) return
                    saveToLibrary({
                      id: from.id,
                      // Renamed only if somebody typed one — an empty box means
                      // "leave it called what it is".
                      name: naming.trim() === '' ? from.name : naming.trim(),
                      palette: edited,
                    })
                  }}
                >
                  {t('editor.palette.update')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removePalette.isPending}
                  onClick={() => setDeleting(from)}
                >
                  {t('editor.palette.delete')}
                </Button>
              </>
            )}
          </div>

          {/* A palette that breaks the lightness invariant is in this count
              too — refused on the way in exactly as it is on the way out. */}
          <UnreadableNotice
            count={unreadable}
            messageKey="editor.palette.unreadable"
          />
        </div>

        {/* One reason at a time, naming the entries it is about: "the palette
            is invalid" is not something anybody can act on. */}
        {(problem !== null || !complete) && (
          <p className="text-xs text-destructive">
            {problem === null
              ? t('editor.palette.problem.badHex')
              : problemMessage(t, problem)}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('editor.action.cancel')}
          </Button>
          <Button disabled={edited === null || problem !== null} onClick={save}>
            {t('editor.palette.save')}
          </Button>
        </DialogFooter>

        {/* Confirmed, unlike applying a palette to a project: that is provably
            non-destructive — every recipe persists its expanded prose — and this
            removes a file. */}
        <ConfirmDeleteDialog
          entry={deleting}
          titleKey="editor.palette.deleteTitle"
          descriptionKey="editor.palette.deleteDescription"
          confirmKey="editor.palette.delete"
          onClose={() => setDeleting(null)}
          onDelete={doomed => {
            removePalette.mutate(doomed.id, {
              // The colours stay in the draft — only the library entry goes.
              // Deleting a palette is not a way to lose the one you are
              // looking at.
              onSuccess: () => setPickedFrom(null),
            })
            setDeleting(null)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * A colour from the picker's `[r, g, b]`, as the hex everything else here uses.
 *
 * `culori` rather than the `color` package the picker itself carries: one
 * colour library owns this app's maths (it is the same one that names a colour
 * and measures the lightness invariant), and the other is an implementation
 * detail of a vendored component.
 */
function hexFrom(red: number, green: number, blue: number): string {
  return (
    formatHex({ mode: 'rgb', r: red / 255, g: green / 255, b: blue / 255 }) ??
    FALLBACK_SWATCH
  ).toUpperCase()
}

/**
 * One colour: a swatch you can pick from, its hex, and what to call it.
 *
 * **The swatch is the control**, not a preview. A hex field alone makes choosing
 * a colour into a typing exercise, and the values here are chosen by eye — this
 * is the one part of the app where somebody is picking a colour rather than
 * describing one. `<input type="color">` gets the platform's own picker for
 * free, including the eyedropper, which is what most palettes actually come
 * from: something already on screen.
 *
 * The hex field stays beside it and stays authoritative. A palette arrives from
 * a brand document as six hex codes far more often than it arrives from a colour
 * wheel, and pasting one has to be possible — so the two are bound to the same
 * value and either can move it. Only the text field can hold a value that is not
 * a colour, which is why only it carries `aria-invalid`; the picker shows
 * {@link FALLBACK_SWATCH} for the keystrokes in between rather than tracking a
 * previous value nothing else needs to remember.
 *
 * `onRemove` is absent on the six roles rather than disabled, because a role is
 * not something you are temporarily prevented from deleting.
 */
function EntryRow({
  id,
  label,
  entry,
  onChange,
  onRemove,
}: {
  id: string
  label: string
  entry: EntryDraft
  onChange: (entry: EntryDraft) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()

  const valid = isHex(entry.hex)

  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-hex`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger
            // Named after the row it belongs to, because six swatches called
            // "Pick a colour" are six controls a screen reader cannot tell
            // apart.
            aria-label={t('editor.palette.pick', { name: label })}
            className="size-8 shrink-0 cursor-pointer rounded-sm border border-border"
            // The one place a hex is a colour rather than a word. Inline
            // because it is data, and a class cannot hold a value just typed.
            style={{ backgroundColor: valid ? entry.hex : 'transparent' }}
          />
          <PopoverContent className="w-64">
            {/* Mounted only while open, which is what keeps it honest: the
                picker is uncontrolled, so opening it re-reads whatever the hex
                field currently says rather than drifting from it. */}
            <ColorPicker
              className="gap-3"
              defaultValue={valid ? entry.hex : FALLBACK_SWATCH}
              onChange={([red, green, blue]) =>
                onChange({ ...entry, hex: hexFrom(red, green, blue) })
              }
            >
              <ColorPickerSelection className="h-32" />
              <div className="flex items-center gap-2">
                <ColorPickerEyeDropper />
                <ColorPickerHue />
              </div>
              {/* No alpha and no format switcher. A palette colour is opaque —
                  a prompt cannot express transparency — and the hex field
                  beside the swatch is already this row's readout. */}
            </ColorPicker>
          </PopoverContent>
        </Popover>
        <Input
          id={`${id}-hex`}
          className="w-28 font-mono"
          value={entry.hex}
          aria-invalid={!valid}
          onChange={event => onChange({ ...entry, hex: event.target.value })}
        />
        <Input
          id={`${id}-name`}
          aria-label={t('editor.palette.name')}
          value={entry.name}
          // The derived name, shown as what it is: present, unauthored, and
          // replaceable by typing over it.
          placeholder={valid ? nearestColourName(entry.hex) : ''}
          onChange={event => onChange({ ...entry, name: event.target.value })}
        />
        {onRemove !== undefined && (
          <Button size="sm" variant="ghost" onClick={onRemove}>
            {t('editor.palette.removeExtra')}
          </Button>
        )}
      </div>
    </div>
  )
}

function draftOf(entry: PaletteEntry): EntryDraft {
  return { hex: entry.hex, name: entry.name ?? '' }
}

function entryOf(draft: EntryDraft): PaletteEntry {
  const name = draft.name.trim()
  return { hex: draft.hex.toUpperCase(), name: name === '' ? null : name }
}

/**
 * The invariant, in the user's language rather than in a throw's.
 *
 * One key per problem kind and one lookup for all of them — the `other` slot is
 * passed whether or not the sentence uses it, because a message that ignores an
 * interpolation is cheaper than a branch per kind, and a fourth kind should be a
 * string to write rather than a case to remember.
 */
function problemMessage(t: TFunction, problem: PaletteProblem): string {
  const slot = (key: string): string =>
    // A role has a translated label; `extra2` is a position and is shown as
    // the same word the editor labels the row with.
    isPaletteRole(key) ? t(`editor.palette.role.${key}`) : key

  return t(`editor.palette.problem.${problem.kind}`, {
    slot: slot(problem.slot),
    other: 'other' in problem ? slot(problem.other) : '',
  })
}
