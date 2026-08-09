/**
 * Onboarding — a modal over the main UI, driven entirely by a step array (#32).
 *
 * This component knows how to walk a list, count it, and record how far the
 * list got. It knows nothing about welcomes, keys or projects, which is what
 * makes "adding a step is one array entry" true rather than aspirational: the
 * steps arrive as a prop defaulting to `ONBOARDING_STEPS`, and a test can hand
 * it a longer list and watch it walk one more page with no change here.
 *
 * Main window only. The quick pane is a capture surface, not a place to be
 * introduced to an app.
 *
 * Closing — by any route, including skipping — records the version. Onboarding
 * that reappears on every launch is nagging; Settings has the replay button for
 * anyone who wants it back.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  ONBOARDING_STEPS,
  onboardingVersion,
  needsOnboarding,
  stepsSince,
  type OnboardingStep,
} from '@/lib/onboarding/steps'
import {
  useOnboardingVersion,
  useRecordOnboardingVersion,
} from '@/services/onboarding'
import { useUIStore } from '@/store/ui-store'

export function OnboardingDialog({
  steps = ONBOARDING_STEPS,
}: {
  steps?: readonly OnboardingStep[]
} = {}) {
  const { t } = useTranslation()

  const open = useUIStore(state => state.onboardingOpen)
  const fromVersion = useUIStore(state => state.onboardingFromVersion)
  const setOpen = useUIStore(state => state.setOnboardingOpen)

  const [index, setIndex] = useState(0)
  const visible = stepsSince(steps, fromVersion)

  useOnboardingAutoStart(steps)
  useRecordOnClose(open, steps)

  // A run starts at the top of whatever it was given — including a replay from
  // Settings, which is the same steps over again from step one.
  const runKey = `${fromVersion}:${open}`
  const [startedRun, setStartedRun] = useState(runKey)
  if (startedRun !== runKey) {
    setStartedRun(runKey)
    setIndex(0)
  }

  const step = visible[Math.min(index, visible.length - 1)]

  // Only reachable if a step array yields nothing, which `startOnboarding`
  // never asks for — but a modal with no content is worse than no modal.
  if (step === undefined) return null

  const isLast = index >= visible.length - 1

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t(step.titleKey)}</DialogTitle>
          <DialogDescription>{t(step.descriptionKey)}</DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <step.Content />
        </div>

        <DialogFooter className="sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t('onboarding.progress', {
              current: index + 1,
              total: visible.length,
            })}
          </p>

          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="ghost" onClick={() => setIndex(index - 1)}>
                {t('onboarding.back')}
              </Button>
            )}

            {/* Browsing without a key is allowed (PRD §7), so leaving early is
                a supported answer rather than an escape hatch. */}
            {step.canSkip === true && !isLast && (
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('onboarding.skip')}
              </Button>
            )}

            <Button
              onClick={() => (isLast ? setOpen(false) : setIndex(index + 1))}
            >
              {isLast ? t('onboarding.finish') : t('onboarding.next')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Opens onboarding at launch when the stored version is behind the list.
 *
 * It waits for preferences to load — offering a welcome tour to someone who
 * finished one months ago, for the half-second before their preferences
 * arrive, is exactly the flicker a version check is supposed to prevent.
 */
function useOnboardingAutoStart(steps: readonly OnboardingStep[]) {
  const { version, loaded } = useOnboardingVersion()
  const startOnboarding = useUIStore(state => state.startOnboarding)
  const considered = useRef(false)

  useEffect(() => {
    if (!loaded || considered.current) return
    considered.current = true

    // Only steps newer than the stored version are shown, so an existing user
    // meets the new step alone rather than the whole tour again.
    if (needsOnboarding(steps, version)) startOnboarding(version)
  }, [loaded, version, steps, startOnboarding])
}

/**
 * Records the version once the modal goes, by whatever route it went.
 *
 * Tied to closing rather than to the finish button because Escape, the close
 * cross and "skip" all mean the same thing to the next launch.
 */
function useRecordOnClose(open: boolean, steps: readonly OnboardingStep[]) {
  const record = useRecordOnboardingVersion()
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return
    }

    if (!wasOpen.current) return
    wasOpen.current = false
    record.mutate(onboardingVersion(steps))
  }, [open, steps, record])
}
