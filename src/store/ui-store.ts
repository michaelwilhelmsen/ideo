import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

/** The panes the preferences modal can open on. */
export type PreferencePane = 'general' | 'apiKey' | 'appearance' | 'advanced'

interface UIState {
  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  commandPaletteOpen: boolean
  preferencesOpen: boolean
  /** Which pane the preferences modal shows. */
  preferencesPane: PreferencePane
  /** The onboarding modal (#32). Main window only — never the quick pane. */
  onboardingOpen: boolean
  /**
   * The onboarding version the open run started from. Steps newer than this
   * are the ones shown, so `0` means "from the top" — a first launch, or a
   * replay from Settings.
   */
  onboardingFromVersion: number
  newProjectOpen: boolean
  lastQuickPaneEntry: string | null

  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  toggleRightSidebar: () => void
  setRightSidebarVisible: (visible: boolean) => void
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
  /** Opens preferences on a named pane — how other features point at a setting. */
  openPreferencesPane: (pane: PreferencePane) => void
  setPreferencesPane: (pane: PreferencePane) => void
  startOnboarding: (fromVersion: number) => void
  setOnboardingOpen: (open: boolean) => void
  setNewProjectOpen: (open: boolean) => void
  setLastQuickPaneEntry: (text: string) => void
  setSquareCorners: (enabled: boolean) => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
      preferencesPane: 'general',
      onboardingOpen: false,
      onboardingFromVersion: 0,
      newProjectOpen: false,
      lastQuickPaneEntry: null,

      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          { leftSidebarVisible: visible },
          undefined,
          'setLeftSidebarVisible'
        ),

      toggleRightSidebar: () =>
        set(
          state => ({ rightSidebarVisible: !state.rightSidebarVisible }),
          undefined,
          'toggleRightSidebar'
        ),

      setRightSidebarVisible: visible =>
        set(
          { rightSidebarVisible: visible },
          undefined,
          'setRightSidebarVisible'
        ),

      toggleCommandPalette: () =>
        set(
          state => ({ commandPaletteOpen: !state.commandPaletteOpen }),
          undefined,
          'toggleCommandPalette'
        ),

      setCommandPaletteOpen: open =>
        set({ commandPaletteOpen: open }, undefined, 'setCommandPaletteOpen'),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

      openPreferencesPane: pane =>
        set(
          { preferencesOpen: true, preferencesPane: pane },
          undefined,
          'openPreferencesPane'
        ),

      setPreferencesPane: pane =>
        set({ preferencesPane: pane }, undefined, 'setPreferencesPane'),

      startOnboarding: fromVersion =>
        set(
          { onboardingOpen: true, onboardingFromVersion: fromVersion },
          undefined,
          'startOnboarding'
        ),

      setOnboardingOpen: open =>
        set({ onboardingOpen: open }, undefined, 'setOnboardingOpen'),

      setNewProjectOpen: open =>
        set({ newProjectOpen: open }, undefined, 'setNewProjectOpen'),

      setLastQuickPaneEntry: text =>
        set({ lastQuickPaneEntry: text }, undefined, 'setLastQuickPaneEntry'),

      setSquareCorners: (enabled: boolean) => {
        document.documentElement.classList.toggle('square-corners', enabled)
      },
    }),
    {
      name: 'ui-store',
    }
  )
)
