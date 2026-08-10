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
import { fireEvent, render, screen } from '@/test/test-utils'
import { ATLAS, colourNameOf } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { PaletteDialog } from './PaletteDialog'

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

  it('picks a colour from the swatch, and the hex field follows', () => {
    // The swatch is the control, not a preview: these values are chosen by eye,
    // and a hex field alone makes that a typing exercise.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    const swatch = screen.getByLabelText('Pick the Primary colour')
    expect(swatch).toHaveAttribute('type', 'color')

    fireEvent.change(swatch, { target: { value: '#2fb6bf' } })

    // Normalised on the way in, so two spellings of one colour are one colour.
    expect(hexField('Primary')).toHaveValue('#2FB6BF')
    fireEvent.click(saveButton())
    expect(paletteOf().roles.primary.hex).toBe('#2FB6BF')
  })

  it('flags a half-typed hex on the field, not on the swatch', () => {
    // The picker cannot represent `#141` at all, so it shows the fallback and
    // the text field carries the invalid state — one control per job.
    render(<PaletteDialog project={ATLAS} onClose={vi.fn()} />)

    fireEvent.change(hexField('Ink'), { target: { value: '#141' } })

    expect(screen.getByLabelText('Pick the Ink colour')).toHaveValue('#000000')
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
