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
import {
  ATLAS,
  LEDGER,
  MODEL_REGISTRY,
  modelById,
  type StageParams,
} from '@/lib/recipe'
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

  it('does not change the model when a control is touched', () => {
    render(<StageParameters project={LEDGER} stage="animate" />)

    const picker = screen.getByLabelText<HTMLSelectElement>('Model')
    const before = picker.value

    // Duration rather than a switch: the two switches are covered on their own
    // below. The claim is the same one — touching a parameter never moves the
    // user onto a different endpoint.
    fireEvent.change(screen.getByLabelText('Duration'), {
      target: { value: '9s' },
    })

    expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe(before)
  })
})

/**
 * The loop switch's three states, and the rewind switch's one (#30).
 *
 * Looping is live: `buildRequest`'s companion sends the still again as the end
 * frame, so the switch is a real choice wherever the model has a field for one.
 * The interesting state is the third — on the first/last-frame endpoints the
 * end frame is *required*, so the switch shows itself checked and unclickable
 * rather than offering a choice the endpoint would refuse.
 *
 * Rewind is the other mechanism, live since #31 built the ping-pong pass — and
 * gated by nothing, because it is ffmpeg rather than the model.
 */
describe('StageParameters — the loop switch (#30)', () => {
  it('offers looping on a model with somewhere to put an end frame', () => {
    // Ledger's animate draft is Luma Ray 2, which has an `end_image_url`.
    render(<StageParameters project={LEDGER} stage="animate" />)

    expect(
      screen.getByRole('switch', { name: /return to the first frame/i })
    ).toBeEnabled()
  })

  it('locks the switch on where the model cannot run without an end frame', () => {
    // FLUX 3's first/last-frame endpoint refuses a start frame alone, so every
    // run of it loops. Checked and disabled with the reason beside it — an
    // unchecked switch would describe a run that is not going to happen.
    const project = animatingWith(
      'blackforestlabs/flux-3/first-last-frame-to-video'
    )

    render(<StageParameters project={project} stage="animate" />)

    const loop = screen.getByRole('switch', {
      name: /return to the first frame/i,
    })
    expect(loop).toBeChecked()
    expect(loop).toBeDisabled()
    expect(screen.getByText(/always loops/i)).toBeVisible()
  })

  it('shows itself off on a model that cannot loop, whatever the draft stores', () => {
    // Veo's plain image-to-video has no end-frame field, so a `loop: true`
    // carried over from an earlier model is an intent nothing acts on. The
    // switch has to say what the *run* would do — a checked switch above a
    // clip that will not loop is the one thing it must never show.
    const project = animatingWith('fal-ai/veo3.1/image-to-video', {
      loop: true,
    })

    render(<StageParameters project={project} stage="animate" />)

    const loop = screen.getByRole('switch', {
      name: /return to the first frame/i,
    })
    expect(loop).not.toBeChecked()
    expect(loop).toBeDisabled()
    expect(
      screen.getByText(/needs a model with end-frame support/i)
    ).toBeVisible()
  })

  it('offers rewind alongside it, on any video model (#31)', () => {
    // Rewind is ffmpeg rather than the model, so it is a live choice wherever
    // there is a clip — including on a model whose loop switch is greyed out.
    const noEndFrame = animatingWith('fal-ai/veo3.1/image-to-video')

    render(<StageParameters project={noEndFrame} stage="animate" />)

    expect(
      screen.getByRole('switch', { name: /forward, then reverse/i })
    ).toBeEnabled()
  })

  it('leaves the rest of the animate panel usable', () => {
    // Disabling two switches is not the same as disabling the stage: a clip
    // without a loop is still the thing #29 shipped.
    render(<StageParameters project={LEDGER} stage="animate" />)

    expect(screen.getByLabelText('Duration')).toBeEnabled()
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
    expect(useEditorStore.getState().state.project?.batchSizes.source).toBe(2)
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

/**
 * The duration control (#29) — the one lever on this stage that moves the bill
 * by an order of magnitude.
 *
 * Seedance bills $0.473 a second and offers every whole second from 4 to 30, so
 * the same click is under $2 or over $14 depending on one `<select>`. PRD §10.2
 * asks for the estimate before the money; these are the assertions that it moves
 * when the lever does.
 */
describe('StageParameters — duration as a cost lever', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
  })

  /** Ledger is 16:9 and its animate draft is on Luma; move it onto Seedance. */
  function onSeedance() {
    return {
      ...LEDGER,
      drafts: {
        ...LEDGER.drafts,
        animate: {
          ...LEDGER.drafts.animate,
          modelId: 'bytedance/seedance-2.5/image-to-video',
          params: { duration: '5', resolution: '720p' },
        },
      },
    }
  }

  function LiveAnimatePanel() {
    const project = useEditorStore(store => store.state.project)
    if (project === null) return null
    return <StageParameters project={project} stage="animate" />
  }

  it('offers every second the endpoint does, and no "auto"', () => {
    render(<StageParameters project={onSeedance()} stage="animate" />)

    const options = within(screen.getByLabelText('Duration')).getAllByRole(
      'option'
    )

    expect(options).toHaveLength(27)
    expect(options.map(option => option.textContent).at(0)).toBe('4')
    expect(options.map(option => option.textContent).at(-1)).toBe('30')
    expect(screen.queryByRole('option', { name: 'auto' })).toBeNull()
  })

  it('moves the estimate when the length moves', () => {
    useEditorStore.getState().dispatch({
      type: 'openProject',
      project: onSeedance(),
      directory: '/tmp/ledger',
    })
    render(<LiveAnimatePanel />)

    const short = screen.getByText(/approximate/i).textContent ?? ''

    fireEvent.change(screen.getByLabelText('Duration'), {
      target: { value: '30' },
    })

    const long = screen.getByText(/approximate/i).textContent ?? ''
    expect(short).not.toBe(long)
    // Rounded to the cent, 30 × $0.473 is $14.19 — the number the user is
    // deciding about, in front of them before the click.
    expect(long).toMatch(/14\.19/)
  })

  it('runs a model that needs an end frame, now that there is one to send', () => {
    // #29 refused this run outright, because there was no second frame. #30
    // sends the still again, so the endpoint is an ordinary animate model whose
    // clips happen always to loop — and the loop switch, not the run button, is
    // where that is said.
    const project = animatingWith(
      'blackforestlabs/flux-3/first-last-frame-to-video'
    )

    render(<StageParameters project={project} stage="animate" />)

    expect(screen.getByRole('button', { name: /generate/i })).toBeEnabled()
  })
})

/** Ledger with a still to animate, a chosen animate model, and our options. */
function animatingWith(modelId: string, options: StageParams = {}) {
  return {
    ...LEDGER,
    selection: { ...LEDGER.selection, style: 'gen-led-1' },
    drafts: {
      ...LEDGER.drafts,
      animate: {
        ...LEDGER.drafts.animate,
        modelId,
        options: { ...LEDGER.drafts.animate.options, ...options },
      },
    },
  }
}

/**
 * An unresolved template variable (#46).
 *
 * Settled as a warning rather than a block: `{{` is legal prose in an editable
 * box, so refusing the run would be too strong — but this is a paid click, and
 * silence is the wrong default for a prompt with a hole in it.
 */
describe('StageParameters — an unfinished prompt', () => {
  function withPrompt(prompt: string) {
    return {
      ...ATLAS,
      drafts: { ...ATLAS.drafts, source: { ...ATLAS.drafts.source, prompt } },
    }
  }

  it('warns about a blank left in the prompt, naming it', () => {
    render(
      <StageParameters
        project={withPrompt('{{subject}} on a plinth')}
        stage="source"
      />
    )

    expect(
      screen.getByText(/still has a blank in it: \{\{subject\}\}/)
    ).toBeVisible()
  })

  it('does not block the run over it', () => {
    render(
      <StageParameters
        project={withPrompt('{{subject}} on a plinth')}
        stage="source"
      />
    )

    expect(screen.getByRole('button', { name: /^Generate/ })).toBeEnabled()
  })

  it('says nothing about a prompt that has no blanks', () => {
    render(<StageParameters project={withPrompt('a kettle')} stage="source" />)

    expect(screen.queryByText(/still has/i)).not.toBeInTheDocument()
  })
})
