/**
 * The version arithmetic behind "a new step re-prompts existing users" (#32).
 *
 * These are the claims a boolean could not make, so they are checked on the
 * numbers rather than through the modal.
 */

import { describe, expect, it } from 'vitest'
import {
  needsOnboarding,
  onboardingVersion,
  stepsSince,
  type OnboardingStep,
} from './steps'

const Nothing = () => null

function step(id: string, version: number): OnboardingStep {
  return {
    id,
    version,
    titleKey: `onboarding.${id}.title`,
    descriptionKey: `onboarding.${id}.description`,
    Content: Nothing,
    canSkip: true,
  }
}

const V1 = [step('welcome', 1), step('key', 1)] as const

describe('onboarding versions', () => {
  it('derives the version from the steps rather than a hand-kept constant', () => {
    expect(onboardingVersion(V1)).toBe(1)
    expect(onboardingVersion([...V1, step('later', 2)])).toBe(2)
  })

  it('walks a first-time user through everything', () => {
    expect(needsOnboarding(V1, 0)).toBe(true)
    expect(stepsSince(V1, 0).map(s => s.id)).toEqual(['welcome', 'key'])
  })

  it('leaves an up-to-date user alone', () => {
    expect(needsOnboarding(V1, 1)).toBe(false)
    expect(stepsSince(V1, 1)).toEqual([])
  })

  it('shows an existing user only the step that was added', () => {
    const withNewStep = [...V1, step('effects', 2)]

    expect(needsOnboarding(withNewStep, 1)).toBe(true)
    expect(stepsSince(withNewStep, 1).map(s => s.id)).toEqual(['effects'])
    // ...while someone who has never seen any of it still gets all three.
    expect(stepsSince(withNewStep, 0)).toHaveLength(3)
  })

  it('replays from the top when asked to start from zero', () => {
    expect(stepsSince(V1, 0)).toHaveLength(V1.length)
  })

  it('does not re-prompt on a version above the list, however it got there', () => {
    expect(needsOnboarding(V1, 99)).toBe(false)
  })
})
