/**
 * The gate on the first generate (#32, PRD §7).
 *
 * The claim is a pair, and only the pair is worth anything: browsing costs
 * nothing and asks for nothing, but the click that would spend money is
 * refused *before* the request goes out when there is no key. A submit that
 * reaches fal.ai without a key comes back as an authentication failure partway
 * through what looks like a working generation, which reads as a broken app
 * rather than as a setting nobody filled in.
 *
 * So each of these asserts on `generateImage` — whether Rust was ever asked to
 * put a job on the queue — rather than on what the screen said afterwards.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { render, screen, waitFor } from '@/test/test-utils'
import { ATLAS, LEDGER, type Project, type StageRecipe } from '@/lib/recipe'
import { commands, type ImageInput, type Job } from '@/lib/tauri-bindings'
import { useUIStore } from '@/store/ui-store'
import { useEditorStore } from '@/store/editor-store'
import { useRunStage } from './run-request'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockCommands = vi.mocked(commands)

/** The run button, without the rest of the parameter panel around it. */
function RunProbe() {
  const { run } = useRunStage(LEDGER, 'source', 1)
  return <button onClick={run}>run</button>
}

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ preferencesOpen: false, preferencesPane: 'general' })
})

describe('the first generate requires a key', () => {
  it('never reaches fal.ai when no key is stored', async () => {
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: false })

    render(<RunProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(mockCommands.hasFalApiKey).toHaveBeenCalled())
    expect(mockCommands.generateImage).not.toHaveBeenCalled()
  })

  it('says what is missing, and offers the way to fix it', async () => {
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: false })

    render(<RunProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    const [message, options] = vi.mocked(toast.error).mock.calls[0] ?? []
    expect(String(message)).toMatch(/api key/i)

    // The refusal carries the recovery: a message that only says "no key" is
    // an instruction to go hunting through Settings for a field never seen.
    const action = (options as { action?: { onClick: () => void } } | undefined)
      ?.action
    expect(action).toBeDefined()
    action?.onClick()

    expect(useUIStore.getState().preferencesOpen).toBe(true)
    expect(useUIStore.getState().preferencesPane).toBe('apiKey')
  })

  it('submits as normal once a key is stored', async () => {
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: true })

    render(<RunProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(mockCommands.generateImage).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
  })
})

/**
 * The paid path fans out (#26, PRD §4.2).
 *
 * Four candidates is a claim about what one click *submits*, so these assert
 * on `generateImage` rather than on the screen: Rust takes one job per call
 * and the semaphore paces them (PRD §3.3), which makes the batch this loop's
 * responsibility and nobody else's.
 */
function BatchProbe({ batch }: { batch: number }) {
  const { run, isRunning } = useRunStage(LEDGER, 'source', batch)
  return (
    <button onClick={run} disabled={isRunning}>
      run
    </button>
  )
}

/** The run this session recorded for a submitted candidate, if any. */
function runIdOf(generationId: string): string | null {
  const run = useEditorStore
    .getState()
    .state.runs.find(record => record.generationIds.includes(generationId))
  return run?.id ?? null
}

describe('one click, several candidates', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: true })
    // Restated per test: `clearAllMocks` forgets the calls, not what a mock
    // was last told to return.
    mockCommands.generateImage.mockResolvedValue({
      status: 'ok',
      data: { requestId: 'test-request', generationId: 'test-generation' },
    })
    mockCommands.activeJobs.mockResolvedValue({ status: 'ok', data: [] })
  })

  /** Every request `generateImage` was handed, in order. */
  function submitted(): { generationId: string; recipe: unknown }[] {
    return mockCommands.generateImage.mock.calls.map(
      ([request]) =>
        request as unknown as { generationId: string; recipe: unknown }
    )
  }

  it('submits the batch, one job per candidate', async () => {
    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(submitted()).toHaveLength(4))
  })

  it('gives every candidate its own id, because each one names a file', async () => {
    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(submitted()).toHaveLength(4))

    const ids = submitted().map(request => request.generationId)
    expect(new Set(ids).size).toBe(4)
  })

  it('shares one run across the batch, so the four can be shown together', async () => {
    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(submitted()).toHaveLength(4))

    const runs = submitted().map(request => runIdOf(request.generationId))
    expect(runs.every(id => id !== null)).toBe(true)
    expect(new Set(runs).size).toBe(1)
  })

  it('freezes the recipe once, so a four-up is one recipe and not four', async () => {
    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(submitted()).toHaveLength(4))

    const recipes = submitted().map(request => request.recipe)
    for (const recipe of recipes) expect(recipe).toEqual(recipes[0])
  })

  /**
   * AC10 — what is written down is what was sent.
   *
   * The recipe on the request is the copy Rust stores with the job and hands
   * back when it lands (#24), which is the copy that ends up in the manifest. So
   * anything the request resolved after the form was frozen has to be in it, or
   * the persisted recipe describes a generation nobody can reproduce.
   */
  it('records the geometry and the seed that actually went to fal', async () => {
    // Ledger's source model takes explicit pixels, and this run pins its seed.
    const pinned: Project = {
      ...LEDGER,
      drafts: {
        ...LEDGER.drafts,
        source: {
          ...LEDGER.drafts.source,
          seed: { mode: 'pinned', value: 4242 },
        },
      },
    }

    function PinnedProbe() {
      const { run } = useRunStage(pinned, 'source', 1)
      return <button onClick={run}>run</button>
    }

    render(<PinnedProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(submitted()).toHaveLength(1))
    const request = mockCommands.generateImage.mock
      .calls[0]?.[0] as unknown as {
      params: Record<string, unknown>
      recipe: StageRecipe
    }

    expect(request.recipe.params.seed).toBe(4242)
    expect(request.recipe.params.image_size).toEqual(request.params.image_size)
    expect(request.recipe.params.image_size).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    })
    // The draft the form is still showing is untouched — it never held either.
    expect(LEDGER.drafts.source.params.image_size).toBeUndefined()
  })

  it('mints a fresh run for the next click', async () => {
    const user = userEvent.setup()
    render(<BatchProbe batch={2} />)

    await user.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(submitted()).toHaveLength(2))
    const first = runIdOf(submitted()[0]?.generationId ?? '')

    await user.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(submitted()).toHaveLength(4))
    const second = runIdOf(submitted()[2]?.generationId ?? '')

    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('stays available while jobs are in flight, so a run can be queued', async () => {
    // Three jobs run at once and the rest wait (PRD §3.3). A button that
    // locked until the queue drained would be this app inventing a limit, and
    // would stop someone queueing the next idea while this one renders.
    mockCommands.activeJobs.mockResolvedValue({
      status: 'ok',
      data: [inFlightJob()],
    })

    const user = userEvent.setup()
    render(<BatchProbe batch={2} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'run' })).toBeEnabled()
    )

    await user.click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(submitted()).toHaveLength(2))
  })

  it('says a failed batch failed once, not once per candidate', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: {
        reason: 'offline',
        detail: null,
        status: null,
        inputImage: null,
      },
    })

    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    // The reason Rust named, said in the user's language — not a count, since
    // none of the batch went out at all.
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(
      /could not reach fal\.ai/i
    )
  })

  it('says so when only part of the batch was refused', async () => {
    // One mutation observer keeps only the last call's handlers, so three
    // refusals behind one success used to go out in complete silence.
    mockCommands.generateImage
      .mockResolvedValueOnce({
        status: 'error',
        error: {
          reason: 'rateLimited',
          detail: null,
          status: null,
          inputImage: null,
        },
      })
      .mockResolvedValueOnce({
        status: 'error',
        error: {
          reason: 'rateLimited',
          detail: null,
          status: null,
          inputImage: null,
        },
      })
      .mockResolvedValue({
        status: 'ok',
        data: { requestId: 'req-ok', generationId: 'gen-ok' },
      })

    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    // How much of what was clicked actually went out — "2 of 4" and "none of
    // them" are different things to have just been charged for.
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(/2.*4/)
  })

  it('stops waiting for a candidate fal.ai refused', async () => {
    // A refused submit bought nothing and will never arrive, so the run must
    // not hold a place open for it in the grid.
    mockCommands.generateImage
      .mockResolvedValueOnce({
        status: 'error',
        error: {
          reason: 'rateLimited',
          detail: null,
          status: null,
          inputImage: null,
        },
      })
      .mockResolvedValue({
        status: 'ok',
        data: { requestId: 'req-ok', generationId: 'gen-ok' },
      })

    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    const run = useEditorStore.getState().state.runs.at(-1)
    expect(run?.generationIds).toHaveLength(4)
    expect(run?.abandonedIds).toHaveLength(1)
  })
})

/**
 * The style stage stopped being a fixture (#28).
 *
 * Every assertion here is on the request Rust was handed, because that is where
 * the claims live: what is in the form is what is sent, the input image is named
 * rather than piped through the webview, a negative only reaches a model that has
 * a field for it, and a restyle with nothing to restyle never goes out at all.
 */
describe('restyling the source', () => {
  beforeEach(() => {
    useEditorStore.getState().reset()
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: true })
    mockCommands.generateImage.mockResolvedValue({
      status: 'ok',
      data: { requestId: 'req-style', generationId: 'gen-style' },
    })
    mockCommands.activeJobs.mockResolvedValue({ status: 'ok', data: [] })
  })

  /** One submitted request, as `generateImage` received it. */
  interface Submitted {
    readonly stage: string
    readonly prompt: string
    readonly modelId: string
    readonly params: Record<string, unknown>
    readonly recipe: StageRecipe
    readonly imageInputs: readonly ImageInput[]
  }

  function submitted(): Submitted[] {
    return mockCommands.generateImage.mock.calls.map(
      ([request]) => request as unknown as Submitted
    )
  }

  /** The same project, with a different style draft. */
  function styling(project: Project, draft: Partial<StageRecipe>): Project {
    return {
      ...project,
      drafts: {
        ...project.drafts,
        style: { ...project.drafts.style, ...draft },
      },
    }
  }

  function StyleProbe({ project }: { project: Project }) {
    const { run } = useRunStage(project, 'style', 1)
    return <button onClick={run}>run</button>
  }

  async function clickRun(project: Project) {
    render(<StyleProbe project={project} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))
  }

  it('submits a real request rather than minting a fixture candidate', async () => {
    await clickRun(ATLAS)

    await waitFor(() => expect(submitted()).toHaveLength(1))
    const request = submitted()[0]
    expect(request?.stage).toBe('style')
    expect(request?.modelId).toBe('fal-ai/flux/dev/image-to-image')
    // The prompt and the parameters as the form has them — seeding a preset
    // into those fields happened earlier and elsewhere.
    expect(request?.prompt).toBe(ATLAS.drafts.style.prompt)
    expect(request?.params.strength).toBe(0.7)
  })

  it('names the generation to restyle, so no pixels cross the boundary', async () => {
    await clickRun(ATLAS)

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.imageInputs).toEqual([
      {
        // The project's current source, whether it was generated or uploaded.
        generationId: ATLAS.selection.source,
        param: 'image_url',
        shape: 'url',
      },
    ])
    // Nothing image-shaped in the body itself: the URI is Rust's to build.
    expect(submitted()[0]?.params).not.toHaveProperty('image_url')
  })

  it('asks for an array on the models whose image field is one', async () => {
    // A string where Qwen requires an array is a 422 at the paid step, with
    // nothing on screen to say the shape rather than the prompt was wrong.
    await clickRun(
      styling(ATLAS, { modelId: 'fal-ai/qwen-image-2/edit', params: {} })
    )

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.imageInputs[0]?.param).toBe('image_urls')
    expect(submitted()[0]?.imageInputs[0]?.shape).toBe('urlArray')
  })

  it('sends a negative only where the model has a field for it', async () => {
    await clickRun(
      styling(ATLAS, {
        modelId: 'fal-ai/qwen-image-2/edit',
        params: { negative_prompt: 'no gradients' },
      })
    )

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.params.negative_prompt).toBe('no gradients')
  })

  it('drops a negative on a model with nowhere to put it, never folding it in', async () => {
    // PRD §9, settled 2026-08-09: "no gradients" inside a positive prompt reads
    // as a request for gradients.
    await clickRun(
      styling(ATLAS, {
        modelId: 'fal-ai/flux-pro/kontext',
        params: { negative_prompt: 'no gradients' },
      })
    )

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.params).not.toHaveProperty('negative_prompt')
    expect(submitted()[0]?.prompt).not.toMatch(/gradients/)
  })

  it('sends a strength only on the one model that has one', async () => {
    await clickRun(
      styling(ATLAS, {
        modelId: 'fal-ai/nano-banana-2/edit',
        params: { strength: 0.7 },
      })
    )

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.params).not.toHaveProperty('strength')
  })

  it('records the preset the fields were seeded from, and whether they moved', async () => {
    await clickRun(
      styling(ATLAS, { presetId: 'glass-caustics', presetModified: true })
    )

    await waitFor(() => expect(submitted()).toHaveLength(1))
    expect(submitted()[0]?.recipe.presetId).toBe('glass-caustics')
    expect(submitted()[0]?.recipe.presetModified).toBe(true)
    expect(submitted()[0]?.recipe.inputGenerationId).toBe(
      ATLAS.selection.source
    )
  })

  it('refuses a restyle with no source, rather than paying for a text-to-image', async () => {
    // The whole reason this is a hard failure: the Nano Banana edit endpoints do
    // not require their image field, so this call would have succeeded — and
    // been charged — as a picture of something else entirely.
    const sourceless: Project = {
      ...styling(ATLAS, { modelId: 'fal-ai/nano-banana-2/edit', params: {} }),
      selection: { ...ATLAS.selection, source: null },
    }

    await clickRun(sourceless)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockCommands.generateImage).not.toHaveBeenCalled()
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(
      /restyle/i
    )
  })

  it('says what was wrong with the input image in the user’s own words', async () => {
    // Rust refuses this one itself, before fal ever sees it — so there is no
    // supplied sentence to quote, only a code and its numbers. The words and the
    // megabytes are the frontend's (PRD §10.4).
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: {
        reason: 'inputImageUnusable',
        detail: null,
        status: null,
        inputImage: {
          code: 'tooLarge',
          bytes: 12 * 1024 * 1024,
          limit: 10 * 1024 * 1024,
        },
      },
    })

    await clickRun(ATLAS)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const said = String(vi.mocked(toast.error).mock.calls[0]?.[0])
    expect(said).toMatch(/too large/i)
    expect(said).toMatch(/10 MB/)
  })

  /** One submitted animate request's image fields, in the order they were named. */
  async function animateInputs(project: Project): Promise<ImageInput[]> {
    function AnimateProbe() {
      const { run } = useRunStage(project, 'animate', 1)
      return <button onClick={run}>run</button>
    }

    render(<AnimateProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))
    await waitFor(() => expect(mockCommands.generateImage).toHaveBeenCalled())

    return (
      mockCommands.generateImage.mock.calls[0]?.[0] as unknown as {
        imageInputs: ImageInput[]
      }
    ).imageInputs
  }

  /** The same project, with a different animate draft. */
  function animating(project: Project, draft: Partial<StageRecipe>): Project {
    return {
      ...project,
      drafts: {
        ...project.drafts,
        animate: { ...project.drafts.animate, ...draft },
      },
    }
  }

  it('submits animate against the styled still, under that model’s own field', async () => {
    // #29 — animate was the last fixture stage, and it now takes the same path
    // as the other two. The two things worth asserting are the two that cost
    // money if they are wrong: *which* image it animates (the style stage's
    // selection, resolved by `freezeRecipe`) and what the endpoint calls the
    // field it goes in — `start_image_url` on Kling O1, `image_url` on most of
    // its neighbours.
    const inputs = await animateInputs(
      animating(ATLAS, { options: { loop: false, rewind: false } })
    )

    const submitted = mockCommands.generateImage.mock.calls[0]?.[0] as {
      stage: string
      modelId: string
    }

    expect(submitted.stage).toBe('animate')
    expect(submitted.modelId).toBe('fal-ai/kling-video/o1/image-to-video')
    expect(inputs).toEqual([
      {
        generationId: ATLAS.selection.style,
        param: 'start_image_url',
        shape: 'url',
      },
    ])
  })

  /**
   * The loop, as the request builder expresses it (#30, PRD §4.5).
   *
   * One mechanism everywhere: the end frame is the start frame. So the whole
   * feature is visible here — a second image input, naming the same generation,
   * under whatever that model calls its end-frame field — and every case that
   * must *not* produce one is worth pinning, because each of them would be a
   * 422 or a silent non-loop at video prices.
   */
  describe('looping (#30)', () => {
    it('sends the still again as the end frame when looping is on', async () => {
      // Atlas's animate draft has `loop: true` on Kling O1 already.
      const inputs = await animateInputs(ATLAS)

      expect(inputs).toEqual([
        {
          generationId: ATLAS.selection.style,
          param: 'start_image_url',
          shape: 'url',
        },
        {
          generationId: ATLAS.selection.style,
          param: 'end_image_url',
          shape: 'url',
        },
      ])
    })

    it('uses the end-frame name the chosen model actually has', async () => {
      // `last_frame_url` on Veo's first/last-frame endpoint, `end_image_url` on
      // every other model that has one — the registry is the only thing that
      // knows, and the wrong spelling is a 422 at the paid step.
      // Veo has no ultrawide enum, so this one is asked of a 16:9 project.
      const inputs = await animateInputs(
        animating(
          { ...ATLAS, aspect: '16:9' },
          {
            modelId: 'fal-ai/veo3.1/first-last-frame-to-video',
            params: { duration: '6s' },
          }
        )
      )

      expect(inputs.map(i => i.param)).toEqual([
        'first_frame_url',
        'last_frame_url',
      ])
    })

    it('loops a model that requires an end frame however the option is set', async () => {
      // FLUX 3's first/last-frame endpoint refuses a submit naming only a start
      // frame, so the effective answer is derived rather than read off the
      // switch — which is also why the switch is locked on.
      const inputs = await animateInputs(
        animating(ATLAS, {
          modelId: 'blackforestlabs/flux-3/first-last-frame-to-video',
          params: { duration: '5' },
          options: { loop: false, rewind: false },
        })
      )

      expect(inputs.map(i => i.param)).toEqual([
        'start_image_url',
        'end_image_url',
      ])
    })

    it('sends nothing extra on a model with nowhere to put an end frame', async () => {
      // `options.loop` survives a model change untouched (nothing is rewritten
      // under the user), so a stored `true` reaches a model that cannot act on
      // it — and must not turn into a field the endpoint has never heard of.
      const inputs = await animateInputs(
        animating(
          { ...ATLAS, aspect: '16:9' },
          {
            modelId: 'fal-ai/veo3.1/image-to-video',
            params: { duration: '6s' },
            options: { loop: true, rewind: false },
          }
        )
      )

      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.param).toBe('image_url')
    })
  })

  it('refuses an animate run with no styled still, before anything is spent', async () => {
    // The same refusal style makes, one stage later: nothing to animate is a
    // failure rather than a mode, because a video model handed no start frame
    // renders the motion prompt instead — at video prices.
    const noStyle = {
      ...ATLAS,
      selection: { ...ATLAS.selection, style: null },
    }

    function AnimateProbe() {
      const { run } = useRunStage(noStyle, 'animate', 1)
      return <button onClick={run}>run</button>
    }

    render(<AnimateProbe />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockCommands.generateImage).not.toHaveBeenCalled()
  })
})

/** A job the store is already holding, as `activeJobs` hands it back. */
function inFlightJob(): Job {
  return {
    requestId: 'req-in-flight',
    projectId: LEDGER.id,
    generationId: 'gen-in-flight',
    stage: 'source',
    recipe: LEDGER.drafts.source as unknown as Job['recipe'],
    status: 'running' as Job['status'],
    modelId: LEDGER.drafts.source.modelId,
    seed: null,
    asset: null,
    submittedAt: Date.now(),
  }
}
