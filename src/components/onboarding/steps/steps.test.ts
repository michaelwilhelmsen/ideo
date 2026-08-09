/**
 * What is true of the *shipped* list, as opposed to the version arithmetic
 * over any list — that lives in `lib/onboarding/steps.test.ts` (#32).
 */

import { describe, expect, it } from 'vitest'
import { onboardingVersion } from '@/lib/onboarding/steps'
import { ONBOARDING_STEPS, ONBOARDING_VERSION } from './index'

describe('the shipped onboarding registry', () => {
  it('records the version its own steps derive', () => {
    expect(ONBOARDING_VERSION).toBe(onboardingVersion(ONBOARDING_STEPS))
    expect(ONBOARDING_VERSION).toBeGreaterThan(0)
  })

  it('has unique ids and versions that only ever go up', () => {
    const ids = ONBOARDING_STEPS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)

    const versions = ONBOARDING_STEPS.map(s => s.version)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
  })
})
