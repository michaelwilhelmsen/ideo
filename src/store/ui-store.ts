import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

/** The panes the preferences modal can open on. */
export type PreferencePane = 'general' | 'apiKey' | 'appearance' | 'advanced'

/**
 * Which of the two things the window is showing (#55).
 *
 * A discriminant rather than a boolean pair, because the two are mutually
 * exclusive by design: the overview is the front door and the editor is where
 * work happens, and the sidebar belongs to one of them. A window that could be
 * in both states, or neither, would be a third layout nobody drew.
 */
export type AppView = 'overview' | 'editor'

interface UIState {
  view: AppView
  /**
   * The editor's parameters panel. Scoped to the editor view — the overview has
   * no sidebars at all, which is why there is no longer a left one to pair it
   * with.
   */
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

  /** Swaps the whole window. Opening a project is a `useOpenProject` away. */
  setView: (view: AppView) => void
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
      // #55 — the app lands on the overview, not on whatever was open last.
      view: 'overview',
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
      preferencesPane: 'general',
      onboardingOpen: false,
      onboardingFromVersion: 0,
      newProjectOpen: false,
      lastQuickPaneEntry: null,

      setView: view => set({ view }, undefined, 'setView'),

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
