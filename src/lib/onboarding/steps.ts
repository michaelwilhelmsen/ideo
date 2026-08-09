/**
 * Onboarding as a declarative list (PRD §7, #32).
 *
 * Two decisions live here and nowhere else.
 *
 * **A step is one array entry.** The modal walks whatever list it is handed and
 * knows nothing about which steps exist, so adding one is an entry in
 * `ONBOARDING_STEPS` — no routing, no branching, no new component wiring.
 *
 * **Completion is a version integer, not a boolean.** Each step carries the
 * onboarding version that introduced it, and the stored number says how far a
 * user has been walked. A step added later has a higher version than the number
 * on disk, so existing users are re-prompted with *only* the new step, while a
 * first-time user gets the lot. A boolean could not express either.
 */

import type { ComponentType } from 'react'
import { ApiKeyStep } from '@/components/onboarding/steps/ApiKeyStep'
import { FirstProjectStep } from '@/components/onboarding/steps/FirstProjectStep'
import { WelcomeStep } from '@/components/onboarding/steps/WelcomeStep'

export interface OnboardingStep {
  /** Stable id — used as a React key and to target a step directly. */
  readonly id: string
  /** The onboarding version that introduced this step. Never renumbered. */
  readonly version: number
  readonly titleKey: string
  readonly descriptionKey: string
  /** The body of the step. Rendered inside the modal's frame. */
  readonly Content: ComponentType
  /**
   * Whether the step may be passed over. Browsing without a key is allowed
   * (PRD §7), so every step here is skippable — the flag exists so a future
   * step that genuinely blocks can say so.
   */
  readonly canSkip?: boolean
}

/** What the modal shows first, and the only step that is pure welcome. */
export const ONBOARDING_STEP_WELCOME = 'welcome'
/** Key entry. Targeted by name when something else needs a key right now. */
export const ONBOARDING_STEP_API_KEY = 'apiKey'
export const ONBOARDING_STEP_FIRST_PROJECT = 'firstProject'

/** Where a fal.ai key is obtained. Shown, and opened, from the key step. */
export const FAL_KEYS_URL = 'https://fal.ai/dashboard/keys'

/**
 * The version a completed run of `steps` records.
 *
 * Derived rather than declared: a constant maintained beside the list is a
 * constant that will one day disagree with it, and the disagreement would be
 * invisible — either a new step never prompts, or every user is re-prompted.
 */
export function onboardingVersion(
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): number {
  return steps.reduce((highest, step) => Math.max(highest, step.version), 0)
}

/**
 * The steps a user on `storedVersion` has not been walked through yet.
 *
 * `0` — never onboarded, and what a preferences file written before this
 * feature existed reads as — yields everything. Replaying from Settings passes
 * `0` for the same reason.
 */
export function stepsSince(
  steps: readonly OnboardingStep[],
  storedVersion: number
): readonly OnboardingStep[] {
  return steps.filter(step => step.version > storedVersion)
}

/** Whether onboarding should open at launch for a user on `storedVersion`. */
export function needsOnboarding(
  steps: readonly OnboardingStep[],
  storedVersion: number
): boolean {
  return stepsSince(steps, storedVersion).length > 0
}

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
