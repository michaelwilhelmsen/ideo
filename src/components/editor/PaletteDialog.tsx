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
 */

import { formatHex } from 'culori'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  isHex,
  isPaletteRole,
  nearestColourName,
  PALETTE_ROLES,
  paletteProblem,
  type Palette,
  type PaletteEntry,
  type PaletteProblem,
  type PaletteRole,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'

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
