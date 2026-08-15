import { LayoutGrid, PanelRight, Settings } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import type { AppCommand } from './types'

export const navigationCommands: AppCommand[] = [
  /**
   * Back to the front door (#55).
   *
   * What used to be here was a pair of commands for showing and hiding the
   * project list. The list is gone: projects are now managed on the overview,
   * and the way to another project is to go there rather than to reveal a panel
   * beside the one you are in.
   */
  {
    id: 'show-overview',
    labelKey: 'commands.showOverview.label',
    descriptionKey: 'commands.showOverview.description',
    icon: LayoutGrid,
    group: 'navigation',
    shortcut: '⌘+1',
    keywords: ['overview', 'projects', 'library', 'home', 'back'],

    execute: () => {
      useUIStore.getState().setView('overview')
    },

    isAvailable: () => useUIStore.getState().view !== 'overview',
  },

  {
    id: 'show-right-sidebar',
    labelKey: 'commands.showRightSidebar.label',
    descriptionKey: 'commands.showRightSidebar.description',
    icon: PanelRight,
    group: 'navigation',
    shortcut: '⌘+2',
    keywords: ['sidebar', 'right', 'panel', 'show'],

    execute: () => {
      useUIStore.getState().setRightSidebarVisible(true)
    },

    isAvailable: () => !useUIStore.getState().rightSidebarVisible,
  },

  {
    id: 'hide-right-sidebar',
    labelKey: 'commands.hideRightSidebar.label',
    descriptionKey: 'commands.hideRightSidebar.description',
    icon: PanelRight,
    group: 'navigation',
    shortcut: '⌘+2',
    keywords: ['sidebar', 'right', 'panel', 'hide'],

    execute: () => {
      useUIStore.getState().setRightSidebarVisible(false)
    },

    isAvailable: () => useUIStore.getState().rightSidebarVisible,
  },

  {
    id: 'open-preferences',
    labelKey: 'commands.openPreferences.label',
    descriptionKey: 'commands.openPreferences.description',
    icon: Settings,
    group: 'settings',
    shortcut: '⌘+,',
    keywords: ['preferences', 'settings', 'config', 'options'],

    execute: context => {
      context.openPreferences()
    },
  },
]
