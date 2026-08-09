/**
 * The onboarding step registry — the one place a step is added (#32).
 *
 * It lives beside the step components rather than in `@/lib/onboarding`
 * because every entry names one: `lib/` holds the types and the version
 * arithmetic, this holds the wiring, and the dependency points from
 * `components/` into `lib/` the way the architecture guide says it should.
 *
 * Adding a step is one entry here, at a version one higher than the current
 * `ONBOARDING_VERSION`. Nothing else changes — the modal walks whatever it is
 * handed, and existing users are re-prompted with only the new step.
 */

import {
  onboardingVersion,
  ONBOARDING_STEP_API_KEY,
  ONBOARDING_STEP_FIRST_PROJECT,
  ONBOARDING_STEP_WELCOME,
  type OnboardingStep,
} from '@/lib/onboarding/steps'
import { ApiKeyStep } from './ApiKeyStep'
import { FirstProjectStep } from './FirstProjectStep'
import { WelcomeStep } from './WelcomeStep'

/** The list itself — the whole feature's surface for adding a step. */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: ONBOARDING_STEP_WELCOME,
    version: 1,
    titleKey: 'onboarding.welcome.title',
    descriptionKey: 'onboarding.welcome.description',
    Content: WelcomeStep,
    canSkip: true,
  },
  {
    id: ONBOARDING_STEP_API_KEY,
    version: 1,
    titleKey: 'onboarding.apiKey.title',
    descriptionKey: 'onboarding.apiKey.description',
    Content: ApiKeyStep,
    canSkip: true,
  },
  {
    id: ONBOARDING_STEP_FIRST_PROJECT,
    version: 1,
    titleKey: 'onboarding.firstProject.title',
    descriptionKey: 'onboarding.firstProject.description',
    Content: FirstProjectStep,
    canSkip: true,
  },
]

/** The version a completed run of the real list records. */
export const ONBOARDING_VERSION = onboardingVersion(ONBOARDING_STEPS)
