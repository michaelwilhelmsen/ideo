/**
 * The preset control, against the real registry and the real built-in library.
 *
 * What is worth asserting here is not that a `<select>` works but that the
 * *seam* does: the picker seeds the draft through the reducer, disables what it
 * cannot seed, offers a re-seed rather than performing one, and turns the form
 * into a file in app data with an id Rust will accept. So each test ends on
 * either the draft in the store or the arguments the command was called with —
 * the two places a mistake here would actually cost something.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@/test/test-utils'
import {
  ATLAS,
  composePreset,
  MODEL_REGISTRY,
  modelById,
  motionPresetById,
  stylePresetById,
  userPresetFrom,
  writeUserMotionPreset,
  writeUserPreset,
  type PromptStyle,
  type StageRecipe,
} from '@/lib/recipe'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import { PresetField } from './PresetField'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockCommands = vi.mocked(commands)

/** Atlas's style draft is on flux i2i, which reads prose. */
const FLUX_I2I = modelById(MODEL_REGISTRY, 'fal-ai/flux/dev/image-to-image')
/** The tags exemplar: a `negative_prompt`, and no strength field at all. */
const QWEN = modelById(MODEL_REGISTRY, 'fal-ai/qwen-image-2/edit')

const GLASS = stylePresetById('glass-caustics')
if (GLASS === null) throw new Error('the built-in library lost a preset')

/** A prose variant, as a fork that has been taught both idioms holds one. */
const PROSE_VARIANT = {
  transform: 'Grade it towards a warm dusk.',
  compose: '{transform}',
  negative: null,
  strength: 0.7,
} as const

/**
 * A fork that speaks both idioms — saved once from a prose model, once from a
 * tags one. The case update-in-place has to not destroy.
 */
function bilingualFork(): unknown {
  const tags = userPresetFrom({
    id: 'my-look',
    name: 'My look',
    promptStyle: 'tags',
    prompt: 'a keyword list',
    negative: null,
    strength: null,
  })

  return writeUserPreset({
    ...tags,
    variants: { tags: tags.variants.tags, prose: PROSE_VARIANT },
  })
}

/** A saved fork, as the file in app data holds it. */
function savedFork({
  id = 'my-look',
  name = 'My look',
  promptStyle = 'prose' as PromptStyle,
  prompt = 'Make it mine.',
}: {
  id?: string
  name?: string
  promptStyle?: PromptStyle
  prompt?: string
} = {}): unknown {
  return writeUserPreset(
    userPresetFrom({
      id,
      name,
      promptStyle,
      prompt,
      negative: null,
      strength: null,
    })
  )
}

function withSaved(...documents: unknown[]): void {
  mockCommands.userPresetsList.mockResolvedValue({
    status: 'ok',
    data: documents as never,
  })
}

/** The control against the live project, which is how the app renders it. */
function LivePresetField() {
  const project = useEditorStore(store => store.state.project)
  if (project === null) return null
  return <PresetField project={project} stage="style" />
}

function open(): void {
  useEditorStore.getState().dispatch({
    type: 'openProject',
    project: ATLAS,
    directory: '/tmp/atlas',
  })
}

function styleDraft(): StageRecipe {
  const project = useEditorStore.getState().state.project
  if (project === null) throw new Error('nothing is open')
  return project.drafts.style
}

function picker(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>('Preset')
}

function pick(presetId: string): void {
  fireEvent.change(picker(), { target: { value: presetId } })
}

beforeEach(() => {
  vi.clearAllMocks()
  useEditorStore.getState().reset()
})

describe('picking a look', () => {
  it('seeds the draft with the composed prompt for the selected model', async () => {
    open()
    render(<LivePresetField />)

    pick('glass-caustics')

    await waitFor(() =>
      expect(styleDraft().prompt).toBe(composePreset(GLASS, FLUX_I2I)?.prompt)
    )
    expect(styleDraft().presetId).toBe('glass-caustics')
    expect(styleDraft().presetModified).toBe(false)
  })

  it('keeps ours and the user’s own apart', async () => {
    withSaved(savedFork())
    open()
    render(<LivePresetField />)

    const groups = await waitFor(() => {
      const found = picker().querySelectorAll('optgroup')
      expect(found).toHaveLength(2)
      return found
    })

    expect([...groups].map(group => group.label)).toEqual(['Built-in', 'Yours'])
    // A name the user typed is shown as they typed it (PRD §6) — no `t()`.
    expect(
      within(groups[1] as unknown as HTMLElement).getByRole('option', {
        name: 'My look',
      })
    ).toBeEnabled()
  })

  it('offers nothing but the built-ins when nobody has saved one', async () => {
    open()
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(1)
    )
  })

  it('disables a preset that cannot speak to this model, and says why', async () => {
    // A fork carries the one idiom it was saved in. Offered anyway, it would
    // either seed nothing or cross-send — PRD §10.1: disabled, with the reason.
    withSaved(savedFork({ promptStyle: 'tags', prompt: 'a keyword list' }))
    open()
    render(<LivePresetField />)

    const option = await waitFor(() =>
      within(picker()).getByRole('option', { name: /My look/ })
    )

    expect(option).toBeDisabled()
    expect(option.textContent).toMatch(/no prose version/i)
  })

  it('says so when the selected preset cannot seed the selected model', async () => {
    withSaved(savedFork({ promptStyle: 'tags', prompt: 'a keyword list' }))
    open()
    // Selected while on Qwen, which reads tags — then the model moves away.
    useEditorStore
      .getState()
      .dispatch({ type: 'chooseModel', stage: 'style', modelId: QWEN.id })
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    pick('my-look')

    useEditorStore
      .getState()
      .dispatch({ type: 'chooseModel', stage: 'style', modelId: FLUX_I2I.id })

    expect(
      await screen.findByText(/no version written for prose/i)
    ).toBeVisible()
  })
})

/**
 * #28's settled model-switch rule: the text is kept, and a re-seed is offered.
 * Both halves matter — a forced re-seed spends an edit the user made, and no
 * offer at all leaves them holding a prompt in the wrong idiom with no way back
 * short of retyping it.
 */
describe('after switching models', () => {
  it('offers a re-seed without performing one', async () => {
    open()
    render(<LivePresetField />)
    pick('glass-caustics')

    const prose = styleDraft().prompt
    useEditorStore
      .getState()
      .dispatch({ type: 'chooseModel', stage: 'style', modelId: QWEN.id })

    const offer = await screen.findByRole('button', {
      name: /seed again from the preset/i,
    })
    expect(
      screen.getByText(/reads prompts differently from the one this text/i)
    ).toBeVisible()
    expect(styleDraft().prompt).toBe(prose)

    await userEvent.setup().click(offer)

    expect(styleDraft().prompt).toBe(composePreset(GLASS, QWEN)?.prompt)
    expect(styleDraft().presetModified).toBe(false)
  })

  it('offers one after an edit too, and calls it what it is', async () => {
    open()
    render(<LivePresetField />)
    pick('glass-caustics')

    useEditorStore
      .getState()
      .dispatch({ type: 'setPrompt', stage: 'style', prompt: 'my own words' })

    expect(
      await screen.findByText(/no longer says what the preset does/i)
    ).toBeVisible()
  })

  it('says nothing while the form still agrees with the preset', async () => {
    open()
    render(<LivePresetField />)
    pick('glass-caustics')

    await waitFor(() => expect(styleDraft().presetId).toBe('glass-caustics'))
    expect(
      screen.queryByRole('button', { name: /seed again/i })
    ).not.toBeInTheDocument()
  })
})

/**
 * The fork flow. A built-in is read-only, and what gets written is a file named
 * after an id Rust will accept — those are the two ways this can lose someone's
 * work, so they are what is asserted.
 */
describe('saving a fork', () => {
  /** The document handed to Rust on the last save. */
  function savedDocument(): Record<string, unknown> {
    const call = mockCommands.userPresetSave.mock.calls.at(-1)
    if (call === undefined) throw new Error('nothing was saved')
    return call[1] as unknown as Record<string, unknown>
  }

  it('captures the form as it stands, under an id from the name', async () => {
    const user = userEvent.setup()
    open()
    render(<LivePresetField />)
    pick('glass-caustics')

    await user.click(
      screen.getByRole('button', { name: /save as new preset/i })
    )
    // The name of what is being forked is offered as a starting point, so a
    // fork of a built-in is one edit away rather than a blank field.
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      GLASS.name
    )

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Warm dusk')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCommands.userPresetSave).toHaveBeenCalled())
    expect(mockCommands.userPresetSave.mock.calls[0]?.[0]).toBe('warm-dusk')

    const document = savedDocument()
    expect(document.name).toBe('Warm dusk')
    // One idiom, the model's own — the other is explicitly null, because a save
    // can only speak for the model in front of it.
    const variants = document.variants as Record<string, unknown>
    expect(variants.tags).toBeNull()
    expect(variants.prose).toMatchObject({
      transform: composePreset(GLASS, FLUX_I2I)?.prompt,
      strength: 0.7,
    })

    // The fork is what the draft points at afterwards, and the form is
    // untouched: it already says exactly this.
    expect(styleDraft().presetId).toBe('warm-dusk')
    expect(styleDraft().prompt).toBe(composePreset(GLASS, FLUX_I2I)?.prompt)
  })

  it('suffixes an id rather than overwriting an earlier fork', async () => {
    const user = userEvent.setup()
    withSaved(savedFork({ id: 'warm-dusk', name: 'Warm dusk' }))
    open()
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    await user.click(
      screen.getByRole('button', { name: /save as new preset/i })
    )
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Warm dusk')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockCommands.userPresetSave).toHaveBeenCalled())
    expect(mockCommands.userPresetSave.mock.calls[0]?.[0]).toBe('warm-dusk-2')
  })

  it('updates one of your own in place rather than making another', async () => {
    const user = userEvent.setup()
    withSaved(savedFork())
    open()
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    pick('my-look')
    useEditorStore.getState().dispatch({
      type: 'setPrompt',
      stage: 'style',
      prompt: 'Make it mine, warmer.',
    })

    await user.click(
      screen.getByRole('button', { name: /update this preset/i })
    )

    await waitFor(() =>
      expect(mockCommands.userPresetSave).toHaveBeenCalledOnce()
    )
    expect(mockCommands.userPresetSave.mock.calls[0]?.[0]).toBe('my-look')
    expect(
      (savedDocument().variants as Record<string, { transform: string }>).prose
        ?.transform
    ).toBe('Make it mine, warmer.')
    // The form is the preset again, so the provenance flag is clean.
    expect(styleDraft().presetModified).toBe(false)
  })

  it('keeps the fork’s other idiom when updating from this one', async () => {
    // A fork that speaks both idioms is two saves' work. Updating it from a
    // prose model used to write the prose variant and set the tags one to null,
    // which silently threw half of it away — and the picker would then disable
    // the preset for every tags model, with nothing on screen to say why.
    const user = userEvent.setup()
    withSaved(bilingualFork())
    open()
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    pick('my-look')
    useEditorStore.getState().dispatch({
      type: 'setPrompt',
      stage: 'style',
      prompt: 'Grade it towards a warmer dusk.',
    })

    await user.click(
      screen.getByRole('button', { name: /update this preset/i })
    )

    await waitFor(() =>
      expect(mockCommands.userPresetSave).toHaveBeenCalledOnce()
    )
    const variants = savedDocument().variants as Record<string, unknown>
    expect(variants.prose).toMatchObject({
      transform: 'Grade it towards a warmer dusk.',
    })
    // Verbatim, down to the strength: this save said nothing about tags.
    expect(variants.tags).toMatchObject({ transform: 'a keyword list' })
  })

  it('will not update a fork this model’s idiom cannot be read back into', async () => {
    // On `unsupported` the box holds text this fork never seeded — the model
    // reads an idiom it does not speak — so writing it in as the missing idiom
    // would be putting words in the preset's mouth. Save as new is right there.
    const user = userEvent.setup()
    withSaved(savedFork({ promptStyle: 'tags', prompt: 'a keyword list' }))
    open()
    useEditorStore
      .getState()
      .dispatch({ type: 'chooseModel', stage: 'style', modelId: QWEN.id })
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    pick('my-look')
    useEditorStore
      .getState()
      .dispatch({ type: 'chooseModel', stage: 'style', modelId: FLUX_I2I.id })

    const update = await screen.findByRole('button', {
      name: /update this preset/i,
    })
    expect(update).toBeDisabled()
    // Disabled with the reason already on screen (PRD §10.1), not hidden: it is
    // still yours, and deleting it is still offered.
    expect(screen.getByText(/no version written for prose/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /delete preset/i })).toBeEnabled()

    await user.click(update)
    expect(mockCommands.userPresetSave).not.toHaveBeenCalled()
  })

  it('offers no update or delete on a built-in', async () => {
    open()
    render(<LivePresetField />)
    pick('glass-caustics')

    await waitFor(() => expect(styleDraft().presetId).toBe('glass-caustics'))
    // Read-only is not a failure state, so the buttons are absent rather than
    // disabled — offering them would imply ours are yours to edit.
    expect(
      screen.queryByRole('button', { name: /update this preset/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /delete preset/i })
    ).not.toBeInTheDocument()
  })

  it('deletes one of your own, once, after a confirm', async () => {
    const user = userEvent.setup()
    withSaved(savedFork())
    open()
    render(<LivePresetField />)

    await waitFor(() =>
      expect(picker().querySelectorAll('optgroup')).toHaveLength(2)
    )
    pick('my-look')

    await user.click(screen.getByRole('button', { name: /delete preset/i }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm.textContent).toMatch(/My look/)

    await user.click(
      within(confirm).getByRole('button', { name: /delete preset/i })
    )

    await waitFor(() =>
      expect(mockCommands.userPresetDelete).toHaveBeenCalledWith('my-look')
    )
    // The pointer goes; the prompt in the box is the user's now either way.
    await waitFor(() => expect(styleDraft().presetId).toBeNull())
    expect(styleDraft().prompt).not.toBe('')
  })
})

describe('a saved preset that cannot be read', () => {
  it('is skipped, out loud, without taking the library with it', async () => {
    // A file someone hand-edited must cost that one preset and nothing else.
    withSaved(savedFork(), { version: 1, id: 'broken' })
    open()
    render(<LivePresetField />)

    expect(await screen.findByText(/could not be read/i)).toBeVisible()
    expect(
      within(picker()).getByRole('option', { name: 'My look' })
    ).toBeInTheDocument()
  })

  it('does not let a fork shadow a built-in of the same id', async () => {
    // Two presets answering to one id would make "which preset produced this"
    // a question with two answers, and a recipe cannot tell them apart.
    withSaved(savedFork({ id: 'glass-caustics', name: 'Not ours' }))
    open()
    render(<LivePresetField />)

    expect(await screen.findByText(/could not be read/i)).toBeVisible()
    expect(picker().querySelectorAll('optgroup')).toHaveLength(1)
    expect(
      within(picker()).getByRole('option', { name: 'Glass caustics' })
    ).toBeInTheDocument()
  })
})

/**
 * The second library (#29) — the same control over a simpler schema.
 *
 * The seam is the same one the style cases exercise, so what is worth asserting
 * here is the part that differs: a motion preset seeds the prompt and nothing
 * else, it is never disabled because there are no idioms, and a fork of one
 * lands in its own library rather than shadowing a style preset of the same id.
 */
describe('picking a movement', () => {
  const DRIFT = motionPresetById('drifting-clouds')
  if (DRIFT === null) throw new Error('the built-in motion library lost one')

  function LiveMotionField() {
    const project = useEditorStore(store => store.state.project)
    if (project === null) return null
    return <PresetField project={project} stage="animate" />
  }

  function animateDraft(): StageRecipe {
    const project = useEditorStore.getState().state.project
    if (project === null) throw new Error('nothing is open')
    return project.drafts.animate
  }

  function motionPicker(): HTMLSelectElement {
    return screen.getByLabelText<HTMLSelectElement>('Motion preset')
  }

  function withSavedMotion(...documents: unknown[]): void {
    mockCommands.motionPresetsList.mockResolvedValue({
      status: 'ok',
      data: documents as never,
    })
  }

  it('seeds the prompt box with the whole motion prompt', async () => {
    open()
    render(<LiveMotionField />)

    fireEvent.change(motionPicker(), { target: { value: DRIFT.id } })

    await waitFor(() => expect(animateDraft().prompt).toBe(DRIFT.prompt))
    expect(animateDraft().presetId).toBe(DRIFT.id)
    expect(animateDraft().presetModified).toBe(false)
  })

  it('offers every built-in movement, none of them disabled', async () => {
    // There is one prompt idiom across the eight video endpoints, so unlike the
    // style picker nothing here can fail to speak to the selected model.
    open()
    render(<LiveMotionField />)

    const options = within(motionPicker())
      .getAllByRole('option')
      .filter(option => (option as HTMLOptionElement).value !== '')

    expect(options.length).toBeGreaterThanOrEqual(6)
    for (const option of options) expect(option).toBeEnabled()
  })

  it('writes a fork into the motion library, not the style one', async () => {
    // Two libraries, two folders: a movement called "Warm" and a look called
    // "Warm" are different things and must not clobber each other.
    open()
    render(<LiveMotionField />)

    const user = userEvent.setup()
    fireEvent.change(motionPicker(), { target: { value: DRIFT.id } })
    await waitFor(() => expect(animateDraft().prompt).toBe(DRIFT.prompt))

    await user.click(screen.getByRole('button', { name: /save as new/i }))
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'My drift')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(mockCommands.motionPresetSave).toHaveBeenCalled()
    )
    expect(mockCommands.userPresetSave).not.toHaveBeenCalled()

    const [id, document] = mockCommands.motionPresetSave.mock.calls[0] as [
      string,
      { prompt: string },
    ]
    // Slugged from the name, because the id becomes a file name in app data.
    expect(id).toBe('my-drift')
    expect(document.prompt).toBe(DRIFT.prompt)
    await waitFor(() => expect(animateDraft().presetId).toBe('my-drift'))
  })

  it('offers a re-seed once the prompt has been edited, rather than forcing one', async () => {
    open()
    render(<LiveMotionField />)

    fireEvent.change(motionPicker(), { target: { value: DRIFT.id } })
    await waitFor(() => expect(animateDraft().prompt).toBe(DRIFT.prompt))

    useEditorStore.getState().dispatch({
      type: 'setPrompt',
      stage: 'animate',
      prompt: 'clouds, but faster',
    })

    const reseed = await screen.findByRole('button', { name: /seed again/i })
    expect(animateDraft().prompt).toBe('clouds, but faster')

    await userEvent.setup().click(reseed)
    await waitFor(() => expect(animateDraft().prompt).toBe(DRIFT.prompt))
  })

  it('gives a built-in movement no edit or delete affordance at all', async () => {
    open()
    render(<LiveMotionField />)

    fireEvent.change(motionPicker(), { target: { value: DRIFT.id } })
    await waitFor(() => expect(animateDraft().presetId).toBe(DRIFT.id))

    expect(
      screen.queryByRole('button', { name: /update this preset/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /delete preset/i })
    ).not.toBeInTheDocument()
  })

  it('skips an unreadable fork out loud, keeping the rest of the library', async () => {
    withSavedMotion(
      writeUserMotionPreset({ id: 'mine', name: 'Mine', prompt: 'a drift' }),
      { version: 1, id: 'broken' }
    )
    open()
    render(<LiveMotionField />)

    expect(await screen.findByText(/could not be read/i)).toBeVisible()
    expect(
      within(motionPicker()).getByRole('option', { name: 'Mine' })
    ).toBeInTheDocument()
  })
})
