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
import { commands } from '@/lib/tauri-bindings'
import { useUIStore } from '@/store/ui-store'
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
