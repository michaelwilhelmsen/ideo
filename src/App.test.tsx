import { render, screen, within } from '@/test/test-utils'
import { describe, it, expect } from 'vitest'
import App from './App'

// Tauri bindings are mocked globally in src/test/setup.ts

describe('App', () => {
  it('renders the three-stage editor as the main content', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: 'Atlas — hero' })
    ).toBeInTheDocument()
  })

  it('offers the three stages as tabs rather than steps', () => {
    render(<App />)
    const stages = within(screen.getByRole('navigation', { name: /stages/i }))
    // Every stage is reachable directly — there is no "next" (PRD §4.1).
    expect(stages.getByRole('button', { name: /source/i })).toBeEnabled()
    expect(stages.getByRole('button', { name: /style/i })).toBeEnabled()
    expect(stages.getByRole('button', { name: /animate/i })).toBeEnabled()
  })

  it('renders title bar with traffic light buttons', () => {
    render(<App />)
    // Find specifically the window control buttons in the title bar
    const titleBarButtons = screen
      .getAllByRole('button')
      .filter(
        button =>
          button.getAttribute('aria-label')?.includes('window') ||
          button.className.includes('window-control')
      )
    // Should have at least the window control buttons
    expect(titleBarButtons.length).toBeGreaterThan(0)
  })
})
