/**
 * Application menu builder using Tauri's JavaScript API.
 *
 * This module creates native menus from JavaScript, enabling i18n support
 * through react-i18next. Menus are rebuilt when the language changes.
 */
import {
  Menu,
  MenuItem,
  Submenu,
  PredefinedMenuItem,
} from '@tauri-apps/api/menu'
import i18n from '@/i18n/config'
import { useUIStore } from '@/store/ui-store'
import { logger } from '@/lib/logger'
import { checkForUpdates } from '@/lib/updater'

const APP_NAME = 'Ideo'

/**
 * Build and set the application menu with translated labels.
 */
export async function buildAppMenu(): Promise<Menu> {
  const t = i18n.t.bind(i18n)

  try {
    // Build the main application submenu (appears as app name on macOS)
    const appSubmenu = await Submenu.new({
      text: APP_NAME,
      items: [
        await MenuItem.new({
          id: 'about',
          text: t('menu.about', { appName: APP_NAME }),
          action: handleAbout,
        }),
        await MenuItem.new({
          id: 'check-for-updates',
          text: t('menu.checkForUpdates'),
          action: handleCheckForUpdates,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
          id: 'preferences',
          text: t('menu.preferences'),
          accelerator: 'CmdOrCtrl+,',
          action: handleOpenPreferences,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await PredefinedMenuItem.new({
          item: 'Hide',
          text: t('menu.hide', { appName: APP_NAME }),
        }),
        await PredefinedMenuItem.new({
          item: 'HideOthers',
          text: t('menu.hideOthers'),
        }),
        await PredefinedMenuItem.new({
          item: 'ShowAll',
          text: t('menu.showAll'),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await PredefinedMenuItem.new({
          item: 'Quit',
          text: t('menu.quit', { appName: APP_NAME }),
        }),
      ],
    })

    // Build the Edit submenu (also provides the standard macOS accelerators
    // for Undo/Redo/Cut/Copy/Paste/Select All so text inputs work app-wide)
    const editSubmenu = await Submenu.new({
      text: t('menu.edit'),
      items: [
        await PredefinedMenuItem.new({
          item: 'Undo',
          text: t('menu.undo'),
        }),
        await PredefinedMenuItem.new({
          item: 'Redo',
          text: t('menu.redo'),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await PredefinedMenuItem.new({
          item: 'Cut',
          text: t('menu.cut'),
        }),
        await PredefinedMenuItem.new({
          item: 'Copy',
          text: t('menu.copy'),
        }),
        await PredefinedMenuItem.new({
          item: 'Paste',
          text: t('menu.paste'),
        }),
        await PredefinedMenuItem.new({
          item: 'SelectAll',
          text: t('menu.selectAll'),
        }),
      ],
    })

    // Build the View submenu
    const viewSubmenu = await Submenu.new({
      text: t('menu.view'),
      items: [
        await MenuItem.new({
          id: 'show-overview',
          text: t('menu.showOverview'),
          accelerator: 'CmdOrCtrl+1',
          action: handleShowOverview,
        }),
        await MenuItem.new({
          id: 'toggle-right-sidebar',
          text: t('menu.toggleRightSidebar'),
          accelerator: 'CmdOrCtrl+2',
          action: handleToggleRightSidebar,
        }),
      ],
    })

    // Build the complete menu
    const menu = await Menu.new({
      items: [appSubmenu, editSubmenu, viewSubmenu],
    })

    // Set as the application menu
    await menu.setAsAppMenu()

    logger.info('Application menu built successfully')
    return menu
  } catch (error) {
    logger.error('Failed to build application menu', { error })
    throw error
  }
}

/**
 * Set up a listener to rebuild the menu when the language changes.
 * Returns an unsubscribe function for cleanup.
 */
export function setupMenuLanguageListener(): () => void {
  const handler = async () => {
    logger.info('Language changed, rebuilding menu')
    try {
      await buildAppMenu()
    } catch (error) {
      logger.error('Failed to rebuild menu on language change', { error })
    }
  }
  i18n.on('languageChanged', handler)
  return () => i18n.off('languageChanged', handler)
}

// Menu action handlers

function handleAbout(): void {
  logger.info('About menu item clicked')
  alert(
    `${APP_NAME}\n\nVersion: ${__APP_VERSION__}\n\nBuilt with Tauri v2 + React + TypeScript`
  )
}

function handleCheckForUpdates(): void {
  logger.info('Check for Updates menu item clicked')
  void checkForUpdates()
}

function handleOpenPreferences(): void {
  logger.info('Preferences menu item clicked')
  useUIStore.getState().setPreferencesOpen(true)
}

function handleShowOverview(): void {
  logger.info('Show Overview menu item clicked')
  useUIStore.getState().setView('overview')
}

function handleToggleRightSidebar(): void {
  logger.info('Toggle Right Sidebar menu item clicked')
  useUIStore.getState().toggleRightSidebar()
}
