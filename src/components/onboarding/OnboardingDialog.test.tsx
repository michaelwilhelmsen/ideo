/**
 * The modal's four claims from #32, checked where they can actually fail.
 *
 * The version arithmetic is tested on the pure functions in
 * `lib/onboarding/steps.test.ts`. What is only true of the *component* is that
 * it obeys those numbers on screen: that a first launch opens it, that a
 * returning user is left alone, that skipping records the version rather than
 * queuing up another prompt next launch — and that a step added to the array is
 * genuinely all it takes, which is why one test hands it a longer list.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { commands } from '@/lib/tauri-bindings'
import type { OnboardingStep } from '@/lib/onboarding/steps'
import { ONBOARDING_STEPS, ONBOARDING_VERSION } from './steps'
import { useUIStore } from '@/store/ui-store'
import { OnboardingDialog } from './OnboardingDialog'

const mockCommands = vi.mocked(commands)

/** A preferences file that says this user has never been onboarded. */
function firstLaunch() {
  mockCommands.loadPreferences.mockResolvedValue({
    status: 'ok',
    data: {
      theme: 'system',
      quick_pane_shortcut: null,
      language: null,
      onboarding_version: 0,
    },
  })
}

function alreadyOnboarded(version = ONBOARDING_VERSION) {
  mockCommands.loadPreferences.mockResolvedValue({
    status: 'ok',
    data: {
      theme: 'system',
      quick_pane_shortcut: null,
      language: null,
      onboarding_version: version,
    },
  })
}

/** The version handed to `save_preferences`, or null if nothing was saved. */
function savedVersion(): number | null {
  const call = mockCommands.savePreferences.mock.calls.at(-1)
  return call === undefined ? null : (call[0].onboarding_version ?? null)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCommands.savePreferences.mockResolvedValue({ status: 'ok', data: null })
  mockCommands.hasFalApiKey.mockResolvedValue({ status: 'ok', data: false })
  useUIStore.setState({ onboardingOpen: false, onboardingFromVersion: 0 })
})

describe('onboarding on launch', () => {
  it('presents itself to a user who has never seen it', async () => {
    firstLaunch()
    render(<OnboardingDialog />)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/welcome to ideo/i)).toBeInTheDocument()
  })

  it('leaves a user who has already been through it alone', async () => {
    alreadyOnboarded()
    render(<OnboardingDialog />)

    await waitFor(() => expect(mockCommands.loadPreferences).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('walking the steps', () => {
  it('reaches the key step, with the address a key comes from', async () => {
    firstLaunch()
    render(<OnboardingDialog />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /next/i }))

    expect(screen.getByText(/fal\.ai\/dashboard\/keys/)).toBeInTheDocument()
    // The same validated field Settings uses — not a second, laxer one.
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
  })

  it('records the version when the walkthrough is finished', async () => {
    firstLaunch()
    render(<OnboardingDialog />)
    const user = userEvent.setup()
    await screen.findByRole('dialog')

    for (let step = 1; step < ONBOARDING_STEPS.length; step++) {
      await user.click(screen.getByRole('button', { name: /next/i }))
    }
    await user.click(screen.getByRole('button', { name: /done/i }))

    await waitFor(() => expect(savedVersion()).toBe(ONBOARDING_VERSION))
  })

  it('records the version when it is skipped, so it does not nag next launch', async () => {
    firstLaunch()
    render(<OnboardingDialog />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /skip/i }))

    await waitFor(() => expect(savedVersion()).toBe(ONBOARDING_VERSION))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('adding a step', () => {
  const Extra = () => <p>post-processing effects</p>

  const withExtraStep: readonly OnboardingStep[] = [
    ...ONBOARDING_STEPS,
    {
      id: 'effects',
      version: ONBOARDING_VERSION + 1,
      titleKey: 'onboarding.effects.title',
      descriptionKey: 'onboarding.effects.description',
      Content: Extra,
      canSkip: true,
    },
  ]

  it('is one array entry — the modal walks the longer list unchanged', async () => {
    firstLaunch()
    render(<OnboardingDialog steps={withExtraStep} />)
    const user = userEvent.setup()

    expect(
      await screen.findByText(new RegExp(`of ${withExtraStep.length}`, 'i'))
    ).toBeInTheDocument()

    for (let step = 1; step < withExtraStep.length; step++) {
      await user.click(screen.getByRole('button', { name: /next/i }))
    }

    expect(screen.getByText(/post-processing effects/i)).toBeInTheDocument()
  })

  it('shows an existing user only the step that was added', async () => {
    // Someone who finished the current walkthrough, meeting a newer version.
    alreadyOnboarded(ONBOARDING_VERSION)
    render(<OnboardingDialog steps={withExtraStep} />)

    expect(
      await screen.findByText(/post-processing effects/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/of 1/i)).toBeInTheDocument()
    expect(screen.queryByText(/welcome to ideo/i)).not.toBeInTheDocument()
  })

  it('records the newer version once that step is done', async () => {
    alreadyOnboarded(ONBOARDING_VERSION)
    render(<OnboardingDialog steps={withExtraStep} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /done/i }))

    await waitFor(() => expect(savedVersion()).toBe(ONBOARDING_VERSION + 1))
  })
})

describe('replaying from Settings', () => {
  it('starts from step one however far the stored version has got', async () => {
    alreadyOnboarded()
    render(<OnboardingDialog />)

    await waitFor(() => expect(mockCommands.loadPreferences).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // What the Settings button does.
    useUIStore.getState().startOnboarding(0)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/welcome to ideo/i)).toBeInTheDocument()
    expect(
      screen.getByText(new RegExp(`of ${ONBOARDING_STEPS.length}`))
    ).toBeInTheDocument()
  })
})
