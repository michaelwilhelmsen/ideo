/**
 * Auto-update against the signed release manifest published with each GitHub
 * release.
 *
 * Two entry points, differing only in how loud they are:
 * - `scheduleStartupUpdateCheck()` runs once shortly after launch and says
 *   nothing unless there is actually an update. A user who opened the app to
 *   do something else should not be told that nothing has changed.
 * - `checkForUpdates()` is the menu / command-palette route, where silence
 *   would read as a broken button, so it reports every outcome.
 */
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { logger } from './logger'

/**
 * Wait before the automatic check so the update request never competes with
 * the work of actually opening the window.
 */
const STARTUP_DELAY_MS = 5000

/** Guards against the menu item and the startup timer overlapping. */
let inFlight = false

/**
 * Download and install an update, then offer to relaunch.
 *
 * Progress is reported into a single toast that is replaced in place, rather
 * than one toast per event.
 */
async function downloadAndInstall(update: Update): Promise<void> {
  const t = i18n.t.bind(i18n)
  const toastId = toast.loading(t('updater.downloading'))

  let contentLength = 0
  let downloaded = 0

  try {
    await update.downloadAndInstall(event => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength ?? 0
          break
        case 'Progress':
          downloaded += event.data.chunkLength
          // A server that omits Content-Length leaves us no percentage to
          // show, so keep the indeterminate message rather than inventing one.
          if (contentLength > 0) {
            const percent = Math.min(
              100,
              Math.round((downloaded / contentLength) * 100)
            )
            toast.loading(t('updater.downloadingPercent', { percent }), {
              id: toastId,
            })
          }
          break
        case 'Finished':
          toast.loading(t('updater.installing'), { id: toastId })
          break
      }
    })

    logger.info('Update installed', { version: update.version })

    toast.success(t('updater.installed', { version: update.version }), {
      id: toastId,
      duration: 0,
      action: {
        label: t('updater.restart'),
        onClick: () => {
          relaunch().catch(error => {
            logger.error('Failed to relaunch after update', { error })
          })
        },
      },
    })
  } catch (error) {
    logger.error('Failed to install update', { error })
    toast.error(t('updater.failed'), { id: toastId })
  }
}

/**
 * Check for an update and, if one exists, offer it.
 *
 * @param silent - Suppress the "already up to date" and failure messages.
 *   Used by the startup check, where neither is worth interrupting for.
 */
export async function checkForUpdates(silent = false): Promise<void> {
  const t = i18n.t.bind(i18n)

  if (inFlight) {
    logger.debug('Update check already in progress, skipping')
    return
  }
  inFlight = true

  try {
    logger.debug('Checking for updates', { silent })
    const update = await check()

    if (!update) {
      logger.info('No update available')
      if (!silent) {
        toast.info(t('updater.upToDate'))
      }
      return
    }

    logger.info('Update available', {
      version: update.version,
      current: update.currentVersion,
    })

    toast(t('updater.available', { version: update.version }), {
      duration: 0,
      action: {
        label: t('updater.install'),
        onClick: () => {
          void downloadAndInstall(update)
        },
      },
    })
  } catch (error) {
    // Offline, GitHub unreachable, or a dev build with no release to compare
    // against. None of those are the user's problem on a startup check.
    logger.warn('Update check failed', { error })
    if (!silent) {
      toast.error(t('updater.checkFailed'))
    }
  } finally {
    inFlight = false
  }
}

/**
 * Run one silent update check shortly after launch.
 *
 * @returns A cleanup function that cancels the pending check.
 */
export function scheduleStartupUpdateCheck(): () => void {
  const timer = setTimeout(() => {
    void checkForUpdates(true)
  }, STARTUP_DELAY_MS)

  return () => clearTimeout(timer)
}
