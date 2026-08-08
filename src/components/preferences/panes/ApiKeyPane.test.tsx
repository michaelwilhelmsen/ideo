import { describe, it, expect, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { commands } from '@/lib/tauri-bindings'
import { ApiKeyPane } from './ApiKeyPane'

const mockCommands = vi.mocked(commands)

const VALID_KEY = 'a-key-that-the-api-accepts'

async function typeKeyAndSave() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/api key/i), VALID_KEY)
  await user.click(screen.getByRole('button', { name: /^save/i }))
}

describe('ApiKeyPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: false })
    mockCommands.clearFalApiKey.mockResolvedValue({ status: 'ok', data: null })
  })

  it('reports when no key is stored yet', async () => {
    render(<ApiKeyPane />)

    expect(await screen.findByText(/no key saved/i)).toBeInTheDocument()
  })

  it('confirms a key the API accepts, and shows the balance', async () => {
    mockCommands.saveFalApiKey.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'valid', balance: 9.9416, status: null },
    })

    render(<ApiKeyPane />)
    await typeKeyAndSave()

    expect(await screen.findByText(/key works/i)).toBeInTheDocument()
    expect(screen.getByText(/9\.94/)).toBeInTheDocument()
    expect(mockCommands.saveFalApiKey).toHaveBeenCalledWith(VALID_KEY)
  })

  it('empties the input once a key is saved, so it is not left in the DOM', async () => {
    mockCommands.saveFalApiKey.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'valid', balance: null, status: null },
    })

    render(<ApiKeyPane />)
    await typeKeyAndSave()

    await waitFor(() =>
      expect(screen.getByLabelText(/api key/i)).toHaveValue('')
    )
  })

  it('rejects a key the API refuses, with a message about the key', async () => {
    mockCommands.saveFalApiKey.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'rejected', balance: null, status: null },
    })

    render(<ApiKeyPane />)
    await typeKeyAndSave()

    expect(await screen.findByText(/rejected this key/i)).toBeInTheDocument()
    // A refused key is useless — don't leave it sitting in the field.
    await waitFor(() =>
      expect(screen.getByLabelText(/api key/i)).toHaveValue('')
    )
  })

  it('distinguishes being offline from a rejected key', async () => {
    mockCommands.saveFalApiKey.mockResolvedValue({
      status: 'ok',
      data: {
        outcome: 'unreachable',
        balance: null,
        status: null,
      },
    })

    render(<ApiKeyPane />)
    await typeKeyAndSave()

    expect(
      await screen.findByText(/could not reach fal\.ai/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/rejected this key/i)).not.toBeInTheDocument()
    // Nothing was answered for, so the key stays put for a retry.
    expect(screen.getByLabelText(/api key/i)).toHaveValue(VALID_KEY)
  })

  it('re-checks the stored key on demand', async () => {
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: true })
    mockCommands.checkFalApiKey.mockResolvedValue({
      status: 'ok',
      data: { outcome: 'rejected', balance: null, status: null },
    })

    render(<ApiKeyPane />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /test/i }))

    expect(await screen.findByText(/rejected this key/i)).toBeInTheDocument()
  })

  it('clears a stored key', async () => {
    mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: true })

    render(<ApiKeyPane />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /clear/i }))

    await waitFor(() => expect(mockCommands.clearFalApiKey).toHaveBeenCalled())
  })

  it('cannot save an empty key', async () => {
    render(<ApiKeyPane />)

    expect(await screen.findByRole('button', { name: /^save/i })).toBeDisabled()
  })
})
