/**
 * The parameter panel against the real registry (#25).
 *
 * Two claims are checked here rather than in the reducer, because they are only
 * true if the *panel* asks the registry the right question: that a model the
 * locked ratio rules out is refused at selection time with its reason attached
 * (PRD §10), and that touching a control never quietly moves the user onto a
 * different model (PRD §10.1 — "helpfulness that spends money is not helpful").
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { ATLAS, LEDGER, MODEL_REGISTRY, modelById } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { StageParameters } from './StageParameters'

describe('StageParameters — model selection', () => {
  it('offers a model the locked ratio can use', () => {
    // Atlas is 21:9, and Kontext declares 21:9 in its enum.
    render(<StageParameters project={ATLAS} stage="source" />)

    const picker = screen.getByLabelText('Model')
    expect(
      within(picker).getByRole('option', { name: /FLUX Kontext Pro/ })
    ).toBeEnabled()
  })

  it('disables a model the locked ratio rules out, and says why', () => {
    // Grok's widest enum entry is 2:1, so a 21:9 project cannot use it. The
    // refusal is here rather than at submit, where it would arrive after the
    // prompt was typed and the money spent.
    render(<StageParameters project={ATLAS} stage="source" />)

    const option = within(screen.getByLabelText('Model')).getByRole('option', {
      name: /Grok Imagine/,
    })

    expect(option).toBeDisabled()
    expect(option.textContent).toMatch(/21:9/)
  })

  it('leaves that same model selectable on a project it can serve', () => {
    // The Ledger project is 16:9, which Grok does declare — so the refusal is
    // about this project's ratio and not about the model.
    render(<StageParameters project={LEDGER} stage="source" />)

    expect(
      within(screen.getByLabelText('Model')).getByRole('option', {
        name: /Grok Imagine/,
      })
    ).toBeEnabled()
  })

  it('never lists a model belonging to another stage', () => {
    render(<StageParameters project={LEDGER} stage="animate" />)

    const options = within(screen.getByLabelText('Model')).getAllByRole(
      'option'
    )
    for (const option of options) {
      expect(
        modelById(MODEL_REGISTRY, option.getAttribute('value') ?? '').stage
      ).toBe('animate')
    }
  })

  it('does not change the model when a control is toggled', async () => {
    const user = userEvent.setup()
    render(<StageParameters project={LEDGER} stage="animate" />)

    const picker = screen.getByLabelText<HTMLSelectElement>('Model')
    const before = picker.value

    await user.click(
      screen.getByRole('switch', { name: /forward, then reverse/i })
    )

    expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe(before)
  })
})

/**
 * PRD §5's `promptStyle`. The registry has always known that Qwen reads a
 * keyword list and everything else reads prose; until it was shown, the only
 * way to learn it was to write the wrong kind of prompt and pay for the result.
 */
describe('StageParameters — prompt style', () => {
  it('says a prose model wants sentences', () => {
    render(<StageParameters project={ATLAS} stage="source" />)

    expect(screen.getByText(/reads the prompt as prose/i)).toBeInTheDocument()
  })

  it('follows the selected model onto a keyword-list one', () => {
    const onQwen = {
      ...LEDGER,
      drafts: {
        ...LEDGER.drafts,
        source: {
          ...LEDGER.drafts.source,
          modelId: 'fal-ai/qwen-image-2/text-to-image',
        },
      },
    }

    render(<StageParameters project={onQwen} stage="source" />)

    expect(
      screen.getByText(/reads the prompt as a keyword list/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/reads the prompt as prose/i)).toBeNull()
  })
})

describe('StageParameters — cost (PRD §10.2)', () => {
  it('shows an approximate figure with the date the price was checked', () => {
    render(<StageParameters project={LEDGER} stage="source" />)

    // Never presented as exact, and dated so staleness is visible rather than
    // implying a precision the registry does not have.
    expect(screen.getByText(/approximate/i).textContent).toMatch(/2026-08-09/)
    expect(screen.getByText(/approximate/i).textContent).toMatch(/^~\$/)
  })

  it('says the price is unknown rather than inventing one', () => {
    // gpt-image-2 is token-priced; there is no per-image number to show.
    const tokenPriced = {
      ...LEDGER,
      drafts: {
        ...LEDGER.drafts,
        source: { ...LEDGER.drafts.source, modelId: 'openai/gpt-image-2' },
      },
    }

    render(<StageParameters project={tokenPriced} stage="source" />)

    expect(screen.getByText(/not checked/i)).toBeVisible()
  })
})

/**
 * PRD §4.2 — how many candidates one click produces, and what the button and
 * the estimate above it say it will cost.
 */
describe('StageParameters — batch (#26)', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
  })

  /** The panel against the live project, which is how the app renders it. */
  function LivePanel({ stage }: { stage: 'source' | 'style' | 'animate' }) {
    const project = useEditorStore(store => store.state.project)
    if (project === null) return null
    return <StageParameters project={project} stage={stage} />
  }

  function open(project: typeof LEDGER): void {
    useEditorStore.getState().dispatch({
      type: 'openProject',
      project,
      directory: `/tmp/${project.id}`,
    })
  }

  it('offers four candidates on an image stage and one on video', () => {
    render(<StageParameters project={LEDGER} stage="source" />)
    expect(
      screen.getByLabelText<HTMLInputElement>('Candidates per run').value
    ).toBe('4')

    render(<StageParameters project={LEDGER} stage="animate" />)
    expect(
      screen.getAllByLabelText<HTMLInputElement>('Candidates per run')[1]?.value
    ).toBe('1')
  })

  it('says on the button what the click will actually produce', () => {
    open(LEDGER)
    render(<LivePanel stage="source" />)

    expect(screen.getByRole('button', { name: 'Generate 4' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Candidates per run'), {
      target: { value: '2' },
    })

    // The button and the estimate above it have to agree with the stepper, or
    // the number beside "Generate" is not what the click costs (PRD §10.2).
    expect(screen.getByRole('button', { name: 'Generate 2' })).toBeEnabled()
    expect(useEditorStore.getState().state.project?.imageBatchSize).toBe(2)
  })

  it('prices the batch, not one call', () => {
    open(LEDGER)
    const { rerender } = render(<LivePanel stage="source" />)

    const four = screen.getByText(/approximate/i).textContent ?? ''

    useEditorStore
      .getState()
      .dispatch({ type: 'setBatchSize', stage: 'source', size: 1 })
    rerender(<LivePanel stage="source" />)

    const one = screen.getByText(/approximate/i).textContent ?? ''
    expect(four).not.toBe(one)
  })

  it('collapses to one while the seed is pinned, and says so', async () => {
    open(LEDGER)
    render(<LivePanel stage="source" />)

    await userEvent.setup().click(screen.getByRole('switch', { name: /pin/i }))

    expect(screen.getByRole('button', { name: 'Generate 1' })).toBeEnabled()
    expect(screen.getByText(/pinned seed makes every candidate/i)).toBeVisible()
    // The setting itself is untouched — unpinning gets the four back.
    expect(
      screen.getByLabelText<HTMLInputElement>('Candidates per run').value
    ).toBe('4')
  })
})
