import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './ui-store'

describe('UIStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      view: 'overview',
      rightSidebarVisible: true,
      commandPaletteOpen: false,
      preferencesOpen: false,
    })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    // #55 — the app lands on the front door, not on the editor.
    expect(state.view).toBe('overview')
    expect(state.rightSidebarVisible).toBe(true)
    expect(state.commandPaletteOpen).toBe(false)
    expect(state.preferencesOpen).toBe(false)
  })

  it('swaps between the overview and the editor', () => {
    const { setView } = useUIStore.getState()

    setView('editor')
    expect(useUIStore.getState().view).toBe('editor')

    setView('overview')
    expect(useUIStore.getState().view).toBe('overview')
  })

  it('toggles preferences dialog', () => {
    const { togglePreferences } = useUIStore.getState()

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(true)

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(false)
  })

  it('toggles command palette', () => {
    const { toggleCommandPalette } = useUIStore.getState()

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(true)

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })
})
