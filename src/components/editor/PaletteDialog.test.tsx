/**
 * The palette editor.
 *
 * The claim worth testing is the one the dialog exists to make: the same
 * invariant that is a *crash* when a manifest carries it is a *refusal* when
 * somebody is typing it (PRD §10.1). Getting that split wrong in either
 * direction is expensive — a crash while editing a hex is absurd, and a
 * palette that gets past this and onto disk takes the project down next time it
 * is opened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@/test/test-utils'
import {
  ATLAS,
  BUILT_IN_PALETTES,
  colourNameOf,
  writeUserPalette,
  type NamedPalette,
  type Project,
} from '@/lib/recipe'
import { commands, type JsonValue } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { PaletteDialog } from './PaletteDialog'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockCommands = vi.mocked(commands)

/** Atlas ships the first built-in, so the picker has something to agree with. */
const STUDIO = BUILT_IN_PALETTES[0]
if (STUDIO === undefined) throw new Error('the palette library lost its first')

/** The one that carries extras — what a wholesale swap is about. */
const WITH_EXTRAS = BUILT_IN_PALETTES.find(
  named => named.palette.extras.length > 0
)
if (WITH_EXTRAS === undefined) throw new Error('no built-in carries extras')

/** One of the user's own, as the file in app data holds it. */
const MINE: NamedPalette = {
  id: 'mine',
  name: 'Mine',
  palette: WITH_EXTRAS.palette,
}

function withSavedPalettes(...palettes: NamedPalette[]): void {
  mockCommands.userPalettesList.mockResolvedValue({
    status: 'ok',
    data: palettes.map(writeUserPalette) as unknown as JsonValue[],
  })
}

/** The trigger — a button under Radix, not a `<select>`. */
function picker(): HTMLElement {
  return screen.getByRole('combobox', { name: 'From the library' })
}

/**
 * What the trigger reads.
 *
 * Which is also how *Custom* is asserted now: it is the placeholder rather than
 * an option, because picking it was never an act. Under a native select it had
 * to be an option to be displayable at all.
 */
function showing(): string {
  return picker().textContent ?? ''
}

/**
 * Opens the picker and hands back the list.
 *
 * Radix mounts the options only while the select is open, so a closed picker has
 * no `option` in the DOM at all — every assertion about what is *offered* has to
 * go through here first.
 */
async function openPicker(): Promise<HTMLElement> {
  await userEvent.setup().click(picker())
  return await screen.findByRole('listbox')
}

/**
 * Picks a palette the way somebody does — by the name they can see, in the
 * group they can see it in.
 *
 * By name rather than by value on purpose. The option's value is a key the
 * picker mints to tell our `dusk` from the user's `dusk`, and a test that
 * rebuilt that key would be asserting the component's own arithmetic back at
 * it. The `group` argument is what makes the two halves distinguishable when an
 * id is shared, which is the whole point of the key.
 */
async function pick(name: string, group?: string): Promise<void> {
  const list = await openPicker()
  // Found rather than got, at both levels: the user's own half arrives from a
  // query, so an option that is not there yet is a wait rather than a failure.
  const scope =
    group === undefined
      ? within(list)
      : within(await within(list).findByRole('group', { name: group }))
  await userEvent.setup().click(await scope.findByRole('option', { name }))
}

function open(): void {
  useEditorStore.getState().dispatch({
    type: 'openProject',
    project: ATLAS,
    directory: '/tmp/atlas',
  })
}

function paletteOf() {
  const project = useEditorStore.getState().state.project
  if (project === null) throw new Error('nothing is open')
  return project.palette
}

function hexField(role: string): HTMLElement {
  return screen.getByLabelText(role)
}

/** The name box on the nth row — every row labels its own the same way. */
function nameField(index: number): HTMLElement {
  const field = screen.getAllByLabelText('Name for prompts')[index]
  if (field === undefined) throw new Error(`no name field at ${index}`)
  return field
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /save palette/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  withSavedPalettes()
  useEditorStore.getState().reset()
  open()
})

describe('the palette editor', () => {
  it('offers the six roles, in the order they are declared', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    expect(hexField('Primary')).toHaveValue(ATLAS.palette.roles.primary.hex)
    for (const role of ['Secondary', 'Accent', 'Ink', 'Paper', 'Neutral']) {
      expect(hexField(role)).toBeVisible()
    }
  })

  it('shows the derived name as a placeholder rather than as typed text', () => {
    // The honest way to show a value nobody authored: visible, clearly not
    // typed, and replaceable by typing over it.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    expect(nameField(0)).toHaveAttribute(
      'placeholder',
      colourNameOf(ATLAS.palette.roles.primary)
    )
  })

  it('saves an edited colour to the project', () => {
    const onClose = vi.fn()
    render(<PaletteDialog project={ATLAS} onClose={onClose} />)

    fireEvent.change(hexField('Primary'), { target: { value: '#2FB6BF' } })
    fireEvent.click(saveButton())

    expect(paletteOf().roles.primary.hex).toBe('#2FB6BF')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a picker from the swatch, and the hex field follows it', async () => {
    // The swatch is the control, not a preview: these values are chosen by eye,
    // and a hex field alone makes that a typing exercise.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Pick the Primary colour'))

    // The picker mounts uncontrolled from the row's current hex, so what it
    // emits on open is that same colour rather than a drifted one.
    await waitFor(() => expect(hexField('Primary')).toHaveValue('#D9662C'))
  })

  it('opens a grey swatch on the grey, not on red', () => {
    // The upstream component read hue/saturation/lightness with `||` fallbacks,
    // so a saturation of 0 became 100 and every neutral opened as red. Three of
    // the six roles are greys — see the patch note in the vendored file.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Neutral'), { target: { value: '#808080' } })
    fireEvent.click(screen.getByLabelText('Pick the Neutral colour'))

    expect(hexField('Neutral')).toHaveValue('#808080')
  })

  it('shows a half-typed hex as no colour at all on the swatch', () => {
    // `#141` is not a colour, so the swatch shows nothing rather than guessing;
    // the text field beside it carries the invalid state.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Ink'), { target: { value: '#141' } })

    // jsdom resolves `transparent` to its rgba form.
    expect(screen.getByLabelText('Pick the Ink colour')).toHaveStyle({
      backgroundColor: 'rgba(0, 0, 0, 0)',
    })
    expect(hexField('Ink')).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps an authored name as the word prompts will use', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(nameField(0), { target: { value: 'House orange' } })
    fireEvent.click(saveButton())

    expect(colourNameOf(paletteOf().roles.primary)).toBe('House orange')
  })

  it('refuses a palette that would turn a two-ink recipe to mud, and says why', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    // The same hex in two mid roles: a duotone would map both to one ink.
    fireEvent.change(hexField('Accent'), {
      target: { value: ATLAS.palette.roles.primary.hex },
    })

    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/too close in lightness/i)).toBeVisible()
  })

  it('refuses a colour lighter than paper, naming the entry', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Neutral'), { target: { value: '#FFFFFF' } })

    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/Neutral is lighter/)).toBeVisible()
  })

  it('waits rather than crashing while a hex is half typed', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Ink'), { target: { value: '#14' } })

    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/needs a hex/i)).toBeVisible()
    // And nothing has reached the project.
    expect(paletteOf().roles.ink).toEqual(ATLAS.palette.roles.ink)
  })

  it('adds an unroled extra, which a recipe reaches as {{extra1}}', () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /add a colour/i }))
    fireEvent.change(hexField('Extra 1'), { target: { value: '#A3B18A' } })
    fireEvent.click(saveButton())

    expect(paletteOf().extras).toEqual([{ hex: '#A3B18A', name: null }])
  })

  it('removes an extra, and the one after it moves up a position', () => {
    // Position is the identity: extras are addressed as `extra1`, `extra2`,
    // so removing the first is not a hole, it is a renumbering.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /add a colour/i }))
    fireEvent.click(screen.getByRole('button', { name: /add a colour/i }))
    fireEvent.change(hexField('Extra 1'), { target: { value: '#A3B18A' } })
    fireEvent.change(hexField('Extra 2'), { target: { value: '#12384F' } })
    const [removeFirst] = screen.getAllByRole('button', { name: /remove/i })
    if (removeFirst === undefined) throw new Error('no extra to remove')
    fireEvent.click(removeFirst)
    fireEvent.click(saveButton())

    expect(paletteOf().extras).toEqual([{ hex: '#12384F', name: null }])
  })

  it('leaves the project alone when the dialog is cancelled', () => {
    const onClose = vi.fn()
    render(<PaletteDialog project={ATLAS} onClose={onClose} />)

    fireEvent.change(hexField('Primary'), { target: { value: '#2FB6BF' } })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(paletteOf()).toEqual(ATLAS.palette)
    expect(onClose).toHaveBeenCalled()
  })
})

/**
 * The library (#49).
 *
 * The claims worth testing here are the two that could go quietly wrong. A pick
 * has to replace the extras as well as the roles — keeping the old ones is the
 * "reroll rather than comparison" failure roles exist to prevent — and the
 * picker's label has to be derived by comparing values, because nothing records
 * where a project's colours came from and a stale label is a confident lie.
 */
describe('the palette library', () => {
  it('shows the name of the palette a project is carrying', async () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    await waitFor(() => expect(showing()).toBe(STUDIO.name))
  })

  it('drops to Custom the moment a hex is off, rather than nearly', async () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)
    await waitFor(() => expect(showing()).toBe(STUDIO.name))

    fireEvent.change(hexField('Primary'), { target: { value: '#2FB6BF' } })

    expect(showing()).toBe('Custom')
    // And it is a placeholder rather than a choice: there is nothing to pick
    // called Custom, because these six colours are either a palette in the
    // library or they are the user's own arrangement.
    expect(
      within(await openPicker()).queryByRole('option', { name: 'Custom' })
    ).toBeNull()
  })

  it('replaces the roles and the whole extras list, not just the roles', async () => {
    // A project with three extras that picks a two-extra palette ends with two.
    const busy: Project = {
      ...ATLAS,
      palette: {
        ...ATLAS.palette,
        extras: [
          { hex: '#A3B18A', name: null },
          { hex: '#12384F', name: null },
          { hex: '#6D597A', name: null },
        ],
      },
    }

    render(<PaletteDialog project={busy} onClose={vi.fn()} />)
    await pick(WITH_EXTRAS.name)
    fireEvent.click(saveButton())

    expect(paletteOf()).toEqual(WITH_EXTRAS.palette)
  })

  it('offers the user their own palettes, apart from ours', async () => {
    withSavedPalettes(MINE)
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    const list = within(await openPicker())
    expect(await list.findByRole('option', { name: 'Mine' })).toBeVisible()
    // Grouped rather than concatenated: one half is read-only and ships with
    // the app, the other is the user's and can be updated or deleted.
    expect(list.getByRole('group', { name: 'Yours' })).toBeVisible()
    expect(list.getByRole('group', { name: 'Built-in' })).toBeVisible()
  })

  it('saves the edited draft as a new palette', async () => {
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Primary'), { target: { value: '#2FB6BF' } })
    fireEvent.change(screen.getByLabelText('Palette name'), {
      target: { value: 'Warm dusk' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save as new/i }))

    await waitFor(() =>
      expect(mockCommands.userPaletteSave).toHaveBeenCalledWith(
        'warm-dusk',
        expect.objectContaining({
          id: 'warm-dusk',
          name: 'Warm dusk',
          roles: expect.objectContaining({
            primary: { hex: '#2FB6BF', name: null },
          }),
        })
      )
    )
  })

  it('will not save a palette the invariant refuses', () => {
    // Refused rather than warned: no path here writes an invalid palette.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Palette name'), {
      target: { value: 'Muddy' },
    })
    fireEvent.change(hexField('Accent'), {
      target: { value: ATLAS.palette.roles.primary.hex },
    })

    expect(screen.getByRole('button', { name: /save as new/i })).toBeDisabled()
    expect(mockCommands.userPaletteSave).not.toHaveBeenCalled()
  })

  it('updates one of your own in place, after the draft has moved off it', async () => {
    // The picker's readout says Custom by now — that is the value comparison
    // doing its job — and the update still lands on the palette this was picked
    // from, which is what makes tweak-then-update possible at all.
    withSavedPalettes(MINE)
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    await pick(MINE.name)
    fireEvent.change(hexField('Primary'), { target: { value: '#2FB6BF' } })

    expect(showing()).toBe('Custom')
    fireEvent.click(screen.getByRole('button', { name: /update this/i }))

    await waitFor(() =>
      expect(mockCommands.userPaletteSave).toHaveBeenCalledWith(
        'mine',
        expect.objectContaining({ id: 'mine', name: 'Mine' })
      )
    )
  })

  it('offers neither update nor delete on a built-in', async () => {
    // Absent rather than disabled: read-only is not a failure state, and the
    // button would imply ours are yours.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)
    await waitFor(() => expect(showing()).toBe(STUDIO.name))

    expect(screen.queryByRole('button', { name: /update this/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete palette/i })).toBeNull()
  })

  it('confirms before deleting one of your own, and keeps the colours', async () => {
    withSavedPalettes(MINE)
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    await pick(MINE.name)
    fireEvent.click(screen.getByRole('button', { name: /delete palette/i }))

    expect(await screen.findByText(/Delete Mine\?/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^delete palette$/i }))

    await waitFor(() =>
      expect(mockCommands.userPaletteDelete).toHaveBeenCalledWith('mine')
    )
    // The colours it put in the draft stay: deleting a palette is not a way to
    // lose the one you are looking at.
    expect(hexField('Primary')).toHaveValue(MINE.palette.roles.primary.hex)
  })

  it('says out loud when a saved palette could not be read', async () => {
    // Skipped rather than thrown, and counted rather than swallowed: a library
    // that is quietly one short looks like one that was quietly deleted.
    mockCommands.userPalettesList.mockResolvedValue({
      status: 'ok',
      data: [{ version: 1, id: 'broken' }],
    })
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    expect(
      await screen.findByText(/could not be read and were skipped/i)
    ).toBeVisible()
    // And the rest of the picker is still there.
    expect(
      within(await openPicker()).getByRole('option', { name: STUDIO.name })
    ).toBeVisible()
  })

  it('applies a palette without asking, even to a project with work in it', async () => {
    // Provably non-destructive — every recipe persists its expanded prose — and
    // a confirmation on a harmless action is how people learn to click through
    // the ones that matter.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    await pick(WITH_EXTRAS.name)

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(hexField('Primary')).toHaveValue(
      WITH_EXTRAS.palette.roles.primary.hex
    )
  })
})

describe('a palette of yours that shares an id with one of ours', () => {
  /**
   * Legal, and it has to stay legal: nothing anywhere records a palette id, so
   * a fork called `studio` shadows nothing. What it must not do is make the
   * picker apply the wrong one of them, or offer Update and Delete on ours.
   */
  const SHADOW: NamedPalette = {
    id: STUDIO.id,
    name: 'My studio',
    palette: WITH_EXTRAS.palette,
  }

  it('applies yours when yours is the one picked', async () => {
    withSavedPalettes(SHADOW)
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    await pick('My studio', 'Yours')

    expect(hexField('Primary')).toHaveValue(
      WITH_EXTRAS.palette.roles.primary.hex
    )
    expect(screen.getByRole('button', { name: /update this/i })).toBeVisible()
  })

  it('offers no update or delete on ours, even so', async () => {
    withSavedPalettes(SHADOW)
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    // Opened once and held open: waiting for the Yours group is what proves the
    // fork has arrived, and re-opening the picker to click ours would close it.
    const list = within(await openPicker())
    await list.findByRole('group', { name: 'Yours' })
    await userEvent
      .setup()
      .click(
        within(list.getByRole('group', { name: 'Built-in' })).getByRole(
          'option',
          { name: STUDIO.name }
        )
      )

    expect(screen.queryByRole('button', { name: /update this/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete palette/i })).toBeNull()
  })
})
