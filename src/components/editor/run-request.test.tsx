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
import { LEDGER } from '@/lib/recipe'
import { commands, type Job } from '@/lib/tauri-bindings'
import { useUIStore } from '@/store/ui-store'
import { runIdOf } from '@/services/run-ids'
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

describe('one click, several candidates', () => {
  beforeEach(() => {
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
      error: { reason: 'offline', detail: null, status: null },
    })

    render(<BatchProbe batch={4} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'run' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
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
