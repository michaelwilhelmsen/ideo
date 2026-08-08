import { describe, it, expect, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { listen } from '@tauri-apps/api/event'
import { render, screen, waitFor } from '@/test/test-utils'
import { commands } from '@/lib/tauri-bindings'
import type { GenerationProgress } from '@/lib/tauri-bindings'
import { GeneratePane } from './GeneratePane'

const mockCommands = vi.mocked(commands)
const mockListen = vi.mocked(listen)

const A_GENERATION = {
  request_id: 'req-1',
  prompt: 'a soft gradient',
  model_id: 'fal-ai/flux-pro/v1.1',
  seed: '1234567890',
  image_url: 'https://v3.fal.media/files/x/out.jpeg',
  image_path: '/Users/someone/Library/ideo/generations/req-1.jpeg',
  width: 1280,
  height: 704,
}

/** Lets a test push a progress event as if Rust had emitted it. */
function captureProgressListener() {
  const handlers: ((payload: GenerationProgress) => void)[] = []

  mockListen.mockImplementation(((
    _event: string,
    handler: (e: { payload: GenerationProgress }) => void
  ) => {
    handlers.push(payload => handler({ payload }))
    return Promise.resolve(() => {
      // unlisten
    })
  }) as unknown as typeof listen)

  return (payload: GenerationProgress) => handlers.forEach(h => h(payload))
}

async function promptAndGenerate(prompt = 'a soft gradient') {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/prompt/i), prompt)
  await user.click(screen.getByRole('button', { name: /generate/i }))
}

describe('GeneratePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListen.mockResolvedValue(() => {
      // unlisten
    })
  })

  it('cannot generate without a prompt', async () => {
    render(<GeneratePane />)

    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled()
  })

  it('shows the generated image once the job finishes', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'ok',
      data: A_GENERATION,
    })

    render(<GeneratePane />)
    await promptAndGenerate()

    const image = await screen.findByRole('img', { name: /a soft gradient/i })
    expect(image).toHaveAttribute('src', A_GENERATION.image_url)
    expect(mockCommands.generateImage).toHaveBeenCalledWith('a soft gradient')
  })

  it('shows where the image was saved', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'ok',
      data: A_GENERATION,
    })

    render(<GeneratePane />)
    await promptAndGenerate()

    expect(await screen.findByText(/req-1\.jpeg/)).toBeInTheDocument()
  })

  it('says something while the job is queued rather than sitting silent', async () => {
    const emitProgress = captureProgressListener()
    mockCommands.generateImage.mockReturnValue(
      new Promise(() => {
        // never settles: the job is still running
      })
    )

    render(<GeneratePane />)
    await promptAndGenerate()

    emitProgress({
      request_id: 'req-1',
      status: 'queued',
      queue_position: 3,
      elapsed_ms: 1200,
    })

    expect(await screen.findByText(/queue/i)).toBeInTheDocument()
    expect(await screen.findByText(/3/)).toBeInTheDocument()
  })

  it('reports that the job is running once it leaves the queue', async () => {
    const emitProgress = captureProgressListener()
    mockCommands.generateImage.mockReturnValue(
      new Promise(() => {
        // never settles: the job is still running
      })
    )

    render(<GeneratePane />)
    await promptAndGenerate()

    emitProgress({
      request_id: 'req-1',
      status: 'running',
      queue_position: null,
      elapsed_ms: 4000,
    })

    expect(await screen.findByText(/generating/i)).toBeInTheDocument()
  })

  it('says the request is on its way before the first progress tick', async () => {
    mockCommands.generateImage.mockReturnValue(
      new Promise(() => {
        // never settles: the job is still running
      })
    )

    render(<GeneratePane />)
    await promptAndGenerate()

    expect(await screen.findByText(/sending to fal\.ai/i)).toBeInTheDocument()
  })

  it('turns a failure reason into a sentence rather than staying silent', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: { reason: 'keyRejected', detail: null, status: null },
    })

    render(<GeneratePane />)
    await promptAndGenerate()

    expect(
      await screen.findByText(/rejected your API key/i)
    ).toBeInTheDocument()
  })

  it('passes on what the API objected to when it said', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: {
        reason: 'requestRejected',
        detail: 'prompt too long',
        status: null,
      },
    })

    render(<GeneratePane />)
    await promptAndGenerate()

    expect(await screen.findByText(/prompt too long/i)).toBeInTheDocument()
  })

  it('says being offline is not a rejected key', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: { reason: 'offline', detail: null, status: null },
    })

    render(<GeneratePane />)
    await promptAndGenerate()

    expect(
      await screen.findByText(/could not reach fal\.ai/i)
    ).toBeInTheDocument()
    expect(screen.queryByText(/rejected your API key/i)).not.toBeInTheDocument()
  })

  it('drops a stale error when a new generation starts', async () => {
    mockCommands.generateImage.mockResolvedValue({
      status: 'error',
      error: { reason: 'keyRejected', detail: null, status: null },
    })

    render(<GeneratePane />)
    await promptAndGenerate()
    await screen.findByText(/rejected your API key/i)

    mockCommands.generateImage.mockReturnValue(
      new Promise(() => {
        // never settles: the job is still running
      })
    )
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() =>
      expect(
        screen.queryByText(/rejected your API key/i)
      ).not.toBeInTheDocument()
    )
  })
})
