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
  LEDGER,
  colourNameOf,
  composePreset,
  DEFAULT_PALETTE,
  MODEL_REGISTRY,
  modelById,
  motionPresetById,
  sourcePresetById,
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
  defaults: {},
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
    aspect: null,
    headlineZone: null,
    note: null,
    ditherKernel: null,
    levelPlacement: null,
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
      aspect: null,
      headlineZone: null,
      note: null,
      ditherKernel: null,
      levelPlacement: null,
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

function picker(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Preset' })
}

/**
 * Opens a picker and hands back the list.
 *
 * Radix mounts the options only while the select is open, so every assertion
 * about what is *offered* — and every pick — has to go through here first.
 */
async function openPicker(
  trigger: HTMLElement = picker()
): Promise<HTMLElement> {
  await userEvent.setup().click(trigger)
  return await screen.findByRole('listbox')
}

/** Closes whichever picker is open, leaving the next interaction a clean start. */
async function closePicker(): Promise<void> {
  await userEvent.setup().keyboard('{Escape}')
}

/**
 * Waits for the user's own half of a library to arrive, then closes the picker.
 *
 * The user's forks come from a query, so a test that picks one has to know they
 * are there. Opening the list is the only way to see them under Radix — hence
 * the close on the way out, so what follows starts from a shut picker like
 * everything else.
 */
async function waitForYours(trigger?: HTMLElement): Promise<void> {
  const list = await openPicker(trigger ?? picker())
  await within(list).findByRole('group', { name: YOURS })
  await closePicker()
}

/**
 * Picks a preset by the name on it, in the list the user is looking at.
 *
 * By name rather than by id because Radix puts no `value` in the DOM at all —
 * an item can only be found by the words on it. Anchored at the start, since a
 * row's text carries what the component appends to the name: the aspect it was
 * composed for, and the reason it is unusable on this model.
 */
async function pickNamed(name: string, list?: HTMLElement): Promise<void> {
  const scope = within(list ?? (await openPicker()))
  const row = await scope.findByRole('option', {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  })
  await userEvent.setup().click(row)
}

/**
 * Every group label in the picker, in order.
 *
 * Asserted against by *meaning* rather than by count since #48: the built-ins
 * are grouped one group per family, so a count would be a second copy of how
 * many families the shipped library happens to have — a number that changes
 * every time somebody adds a look, and that says nothing about the behaviour
 * these tests are here for. What matters is that the user's own forks are their
 * own group and nothing of ours is in it.
 */
async function groupLabels(open?: HTMLElement): Promise<string[]> {
  const list = open ?? (await openPicker())
  // Radix names a group with `aria-labelledby` pointing at its label, so the
  // label element is what has to be read — there is no `aria-label` to take.
  return within(list)
    .getAllByRole('group')
    .map(
      group =>
        group.querySelector('[data-slot="select-label"]')?.textContent ?? ''
    )
}

const YOURS = 'Yours'

beforeEach(() => {
  vi.clearAllMocks()
  // Nobody's own library, in any of the three, unless a test says otherwise.
  //
  // `clearAllMocks` forgets the *calls* and keeps the *implementation*, so a
  // fork installed by one test was still in the picker for every test after it.
  // That went unnoticed while "offers nothing but the built-ins" asserted its
  // absence on the first render — before the query it was waiting on resolved,
  // so it passed whatever was mocked. Opening a Radix picker takes long enough
  // for the query to land, which is what turned a false pass into a failure.
  withSaved()
  mockCommands.motionPresetsList.mockResolvedValue({ status: 'ok', data: [] })
  mockCommands.sourcePresetsList.mockResolvedValue({ status: 'ok', data: [] })
  useEditorStore.getState().reset()
})

describe('picking a look', () => {
  it('seeds the draft with the composed prompt for the selected model', async () => {
    open()
    render(<LivePresetField />)

    await pickNamed(GLASS.name)

    await waitFor(() =>
      expect(styleDraft().prompt).toBe(
        composePreset(GLASS, FLUX_I2I, DEFAULT_PALETTE)?.prompt
      )
    )
    expect(styleDraft().presetId).toBe('glass-caustics')
    expect(styleDraft().presetModified).toBe(false)
  })

  it('keeps ours and the user’s own apart', async () => {
    withSaved(savedFork())
    open()
    render(<LivePresetField />)

    const list = await openPicker()
    const yours = await within(list).findByRole('group', { name: YOURS })
    const labels = await groupLabels(list)

    // Ours are grouped one per family and every one of those groups says so;
    // the user's are last, under a heading that is only about being theirs.
    expect(labels[labels.length - 1]).toBe(YOURS)
    for (const label of labels.slice(0, -1)) {
      expect(label).toMatch(/^Built-in — /)
    }

    // A name the user typed is shown as they typed it (PRD §6) — no `t()`.
    expect(
      within(yours).getByRole('option', { name: 'My look' })
    ).not.toHaveAttribute('aria-disabled')
    // And nothing of ours has leaked into it.
    expect(within(yours).getAllByRole('option')).toHaveLength(1)
  })

  it('offers nothing but the built-ins when nobody has saved one', async () => {
    open()
    render(<LivePresetField />)

    const list = within(await openPicker())
    // The built-ins are there, so the list has rendered — and the user's group
    // is absent rather than empty.
    expect(
      list.getByRole('option', { name: new RegExp(GLASS.name) })
    ).toBeVisible()
    expect(list.queryByRole('group', { name: YOURS })).toBeNull()
  })

  it('disables a preset that cannot speak to this model, and says why', async () => {
    // A fork carries the one idiom it was saved in. Offered anyway, it would
    // either seed nothing or cross-send — PRD §10.1: disabled, with the reason.
    withSaved(savedFork({ promptStyle: 'tags', prompt: 'a keyword list' }))
    open()
    render(<LivePresetField />)

    const option = await within(await openPicker()).findByRole('option', {
      name: /My look/,
    })

    // `aria-disabled` rather than the `disabled` attribute: a Radix row is a div
    // that says it is unavailable, not a form control that is.
    expect(option).toHaveAttribute('aria-disabled', 'true')
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

    await waitForYours()
    await pickNamed('My look')

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
    await pickNamed(GLASS.name)

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

    expect(styleDraft().prompt).toBe(
      composePreset(GLASS, QWEN, DEFAULT_PALETTE)?.prompt
    )
    expect(styleDraft().presetModified).toBe(false)
  })

  it('offers one after an edit too, and calls it what it is', async () => {
    open()
    render(<LivePresetField />)
    await pickNamed(GLASS.name)

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
    await pickNamed(GLASS.name)

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
    await pickNamed(GLASS.name)

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
      transform: composePreset(GLASS, FLUX_I2I, DEFAULT_PALETTE)?.prompt,
      strength: 0.7,
    })

    // The fork is what the draft points at afterwards, and the form is
    // untouched: it already says exactly this.
    expect(styleDraft().presetId).toBe('warm-dusk')
    expect(styleDraft().prompt).toBe(
      composePreset(GLASS, FLUX_I2I, DEFAULT_PALETTE)?.prompt
    )
  })

  it('suffixes an id rather than overwriting an earlier fork', async () => {
    const user = userEvent.setup()
    withSaved(savedFork({ id: 'warm-dusk', name: 'Warm dusk' }))
    open()
    render(<LivePresetField />)

    await waitForYours()
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

    await waitForYours()
    await pickNamed('My look')
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

    await waitForYours()
    await pickNamed('My look')
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

    await waitForYours()
    await pickNamed('My look')
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
    await pickNamed(GLASS.name)

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

    await waitForYours()
    await pickNamed('My look')

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
      within(await openPicker()).getByRole('option', { name: 'My look' })
    ).toBeInTheDocument()
  })

  it('does not let a fork shadow a built-in of the same id', async () => {
    // Two presets answering to one id would make "which preset produced this"
    // a question with two answers, and a recipe cannot tell them apart.
    withSaved(savedFork({ id: 'glass-caustics', name: 'Not ours' }))
    open()
    render(<LivePresetField />)

    expect(await screen.findByText(/could not be read/i)).toBeVisible()
    const list = await openPicker()
    expect(await groupLabels(list)).not.toContain(YOURS)
    expect(
      within(list).getByRole('option', { name: 'Glass caustics' })
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

  function motionPicker(): HTMLElement {
    return screen.getByRole('combobox', { name: 'Motion preset' })
  }

  /** The movement picker's own pick, since it has its own trigger. */
  async function pickMovement(name: string): Promise<void> {
    await pickNamed(name, await openPicker(motionPicker()))
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

    await pickMovement(DRIFT.name)

    await waitFor(() => expect(animateDraft().prompt).toBe(DRIFT.prompt))
    expect(animateDraft().presetId).toBe(DRIFT.id)
    expect(animateDraft().presetModified).toBe(false)
  })

  it('offers every built-in movement, none of them disabled', async () => {
    // There is one prompt idiom across the eight video endpoints, so unlike the
    // style picker nothing here can fail to speak to the selected model.
    open()
    render(<LiveMotionField />)

    const options = within(await openPicker(motionPicker()))
      .getAllByRole('option')
      // "None" is a row like any other under Radix, so it is dropped by the name
      // it carries rather than by an empty value it no longer has.
      .filter(option => option.textContent !== 'None')

    expect(options.length).toBeGreaterThanOrEqual(6)
    for (const option of options) {
      expect(option).not.toHaveAttribute('aria-disabled')
    }
  })

  it('writes a fork into the motion library, not the style one', async () => {
    // Two libraries, two folders: a movement called "Warm" and a look called
    // "Warm" are different things and must not clobber each other.
    open()
    render(<LiveMotionField />)

    const user = userEvent.setup()
    await pickMovement(DRIFT.name)
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

    await pickMovement(DRIFT.name)
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

    await pickMovement(DRIFT.name)
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
      within(await openPicker(motionPicker())).getByRole('option', {
        name: 'Mine',
      })
    ).toBeInTheDocument()
  })
})

/**
 * The source stage got the same control in #47, over a library of its own.
 *
 * What is worth asserting is only what differs — that it is a *different* list,
 * that the append block reaches a real seeded prompt, that the aspect hint is
 * on screen and inert, and that a fork of a scene lands in the source folder
 * rather than the style one. Everything else the control does is the same code
 * the style tests above already exercise.
 */
describe('picking a scene', () => {
  const MONOLITH = sourcePresetById('gn-monolith')
  if (MONOLITH === null) throw new Error('the source library lost a preset')

  /** Atlas's source draft is on flux/schnell, which reads prose. */
  const SOURCE_MODEL = modelById(MODEL_REGISTRY, ATLAS.drafts.source.modelId)

  function LiveSourceField() {
    const project = useEditorStore(store => store.state.project)
    if (project === null) return null
    return <PresetField project={project} stage="source" />
  }

  function sourceDraft(): StageRecipe {
    const project = useEditorStore.getState().state.project
    if (project === null) throw new Error('nothing is open')
    return project.drafts.source
  }

  it('offers the source library rather than the style one', async () => {
    open()
    render(<LiveSourceField />)

    const names = within(await openPicker())
      .getAllByRole('option')
      .map(option => option.textContent ?? '')

    expect(names.some(name => name.startsWith(MONOLITH.name))).toBe(true)
    expect(names.some(name => name.startsWith(GLASS.name))).toBe(false)
    await waitFor(() =>
      expect(mockCommands.sourcePresetsList).toHaveBeenCalled()
    )
  })

  it('seeds the whole scene, append block included', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)

    const composed =
      composePreset(MONOLITH, SOURCE_MODEL, DEFAULT_PALETTE)?.prompt ?? ''
    await waitFor(() => expect(sourceDraft().prompt).toBe(composed))
    expect(sourceDraft().prompt).toContain('No text, no lettering')
    // The colour hole resolved against the project's palette, by *name* — the
    // one thing a prompt may never contain is a hex (#46).
    expect(sourceDraft().prompt).toContain(
      colourNameOf(ATLAS.palette.roles.primary)
    )
    expect(sourceDraft().prompt).not.toContain('#')
    // The free-text one did not, and is visible rather than silently dropped.
    expect(sourceDraft().prompt).toContain('{{subject}}')
  })

  it('asks for the holes the scene has, pre-filled from the palette', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    // One field per `{{…}}`, named by the key so the field and the hole in the
    // prompt box above are recognisably the same thing.
    const subject = screen.getByLabelText('subject')
    expect(screen.getByLabelText('primary')).toHaveValue(
      colourNameOf(ATLAS.palette.roles.primary)
    )
    expect(subject).toHaveValue('')

    fireEvent.change(subject, { target: { value: 'a brushed steel kettle' } })

    // Filling one re-seeds the box, and what lands there is expanded prose —
    // the literal is gone, and only this ever reaches a recipe.
    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )
    expect(sourceDraft().prompt).not.toContain('{{subject}}')
  })

  it('carries a shared hole into the next scene, and only what it asks for', async () => {
    open()
    render(<LiveSourceField />)

    // Two scenes with overlapping but different holes: the monolith asks for a
    // subject and a colour, the gradient asks for two colours and no subject.
    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    fireEvent.change(screen.getByLabelText('subject'), {
      target: { value: 'a brushed steel kettle' },
    })
    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )

    await pickNamed('Soft gradient field')
    await waitFor(() => expect(sourceDraft().presetId).toBe('gn-gradient'))

    // A hole this scene does not have is neither asked about nor expanded — it
    // is waiting, not lost.
    expect(screen.queryByLabelText('subject')).toBeNull()
    expect(screen.getByLabelText('secondary')).toBeVisible()
    expect(sourceDraft().prompt).not.toContain('a brushed steel kettle')

    // Back to a scene that does ask, without retyping it: browsing the library
    // for one subject is what the library is for.
    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    expect(screen.getByLabelText('subject')).toHaveValue(
      'a brushed steel kettle'
    )
    expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    expect(sourceDraft().prompt).not.toContain('{{subject}}')
  })

  it('leaves each project holding its own answers', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)
    fireEvent.change(await screen.findByLabelText('subject'), {
      target: { value: 'a brushed steel kettle' },
    })
    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )

    // Another project's `{{subject}}` is a different question, and the answer
    // to this one is not thrown away for having looked at it.
    useEditorStore.getState().dispatch({
      type: 'openProject',
      project: LEDGER,
      directory: '/tmp/ledger',
    })
    // The panel is rebuilt for the other project — waited for, because the
    // picker below has to be that project's rather than the one being replaced.
    await waitFor(() => expect(screen.queryByLabelText('subject')).toBeNull())

    await pickNamed(MONOLITH.name)
    expect(await screen.findByLabelText('subject')).toHaveValue('')

    // Back again, to the scene and the subject that were left here. (The
    // fixture project reopens with a pristine draft, which is why the scene has
    // to be picked again — what is being asserted is that the *answer* waited.)
    open()
    await waitFor(() => expect(screen.queryByLabelText('subject')).toBeNull())

    await pickNamed(MONOLITH.name)
    expect(await screen.findByLabelText('subject')).toHaveValue(
      'a brushed steel kettle'
    )
    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )
  })

  it('keeps the fields when the sidebar takes the panel away and back', async () => {
    open()
    const panel = render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    fireEvent.change(screen.getByLabelText('subject'), {
      target: { value: 'a brushed steel kettle' },
    })
    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )

    // Changing tab, or opening the effects one, unmounts the whole stage form.
    // Values held in the control's own state came back empty while the prompt
    // kept the old expansion — which reads as a hand edit, and every later
    // variable change was then refused in silence until the next paid run.
    panel.unmount()
    render(<LiveSourceField />)

    expect(await screen.findByLabelText('subject')).toHaveValue(
      'a brushed steel kettle'
    )

    fireEvent.change(screen.getByLabelText('subject'), {
      target: { value: 'a copper teapot' },
    })

    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a copper teapot')
    )
    expect(sourceDraft().prompt).not.toContain('a brushed steel kettle')
  })

  it('carries the field into the re-seed the user finally accepts', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    // Their own words, so a variable change must not rewrite the box (#28) —
    // but it is still recorded, and the offer takes it when it is accepted.
    useEditorStore.getState().dispatch({
      type: 'setPrompt',
      stage: 'source',
      prompt: 'my own words',
    })

    fireEvent.change(await screen.findByLabelText('subject'), {
      target: { value: 'a brushed steel kettle' },
    })
    expect(sourceDraft().prompt).toBe('my own words')

    fireEvent.click(
      screen.getByRole('button', { name: /seed again from the preset/i })
    )

    await waitFor(() =>
      expect(sourceDraft().prompt).toContain('a brushed steel kettle')
    )
  })

  it('offers a re-seed rather than spending an edit the user made', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    // The prompt is theirs now (#28's settled rule), so a variable change must
    // not rewrite it underneath them.
    useEditorStore.getState().dispatch({
      type: 'setPrompt',
      stage: 'source',
      prompt: 'my own words',
    })

    // The offer appears, which is also what says the control has caught up.
    expect(
      await screen.findByRole('button', { name: /seed again from the preset/i })
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('subject'), {
      target: { value: 'a brushed steel kettle' },
    })

    expect(sourceDraft().prompt).toBe('my own words')
  })

  it('leaves the scene that wants lettering without the append block', async () => {
    open()
    render(<LiveSourceField />)

    await pickNamed('Labelled isometric lineup')

    await waitFor(() =>
      expect(sourceDraft().presetId).toBe('gn-isometric-lineup')
    )
    expect(sourceDraft().prompt).not.toContain('No text, no lettering')
  })

  it('shows the aspect hint without letting it touch the project', async () => {
    open()
    render(<LiveSourceField />)

    const list = await openPicker()
    const option = within(list).getByRole('option', {
      name: new RegExp(`${MONOLITH.name}.*designed for 3:2`),
    })
    expect(option).not.toHaveAttribute('aria-disabled')

    // 3:2 against a 21:9 project, and still offered, still in library order:
    // the hint does not filter, sort or dim (PRD §4.4 locks the ratio anyway).
    expect(ATLAS.aspect).toBe('21:9')
    // Picked from the list already open — Radix takes focus into it, so the
    // trigger cannot be found again until this one is dealt with.
    await pickNamed(MONOLITH.name, list)

    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))
    const project = useEditorStore.getState().state.project
    expect(project?.aspect).toBe('21:9')
  })

  it('writes a fork into the source library, not the style one', async () => {
    open()
    render(<LiveSourceField />)

    const user = userEvent.setup()
    await pickNamed(MONOLITH.name)
    await waitFor(() => expect(sourceDraft().presetId).toBe(MONOLITH.id))

    await user.click(screen.getByRole('button', { name: /save as new/i }))
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'My monolith')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(mockCommands.sourcePresetSave).toHaveBeenCalled()
    )
    expect(mockCommands.userPresetSave).not.toHaveBeenCalled()

    const [id, document] = mockCommands.sourcePresetSave.mock.calls[0] as [
      string,
      { aspect: string | null },
    ]
    expect(id).toBe('my-monolith')
    // The hint travels with the text it was seeded from — the fork is still a
    // scene composed for 3:2.
    expect(document.aspect).toBe('3:2')
  })
})
