import React, { useState } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import {
  ThemeProviderContext,
  type Theme,
  type ThemeProviderState,
} from '@/lib/theme-context'

/**
 * A client that caches the way the real one does.
 *
 * `staleTime` is copied from `lib/query-client.ts` rather than left at zero,
 * and the difference is not cosmetic: at zero, every query refetches the moment
 * anything mounts an observer, so a view that forgets to invalidate what it
 * changed still looks correct under test and is wrong in the app. That is
 * exactly how the overview came to show a card built before the work on it
 * existed. Retries are still off — a failure should be one call and a
 * assertion, not four seconds of backoff.
 */
const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 1000 * 60 * 5,
      },
      mutations: {
        retry: false,
      },
    },
  })

interface AllTheProvidersProps {
  children: React.ReactNode
}

/**
 * Mock ThemeProvider for tests that doesn't depend on Tauri or localStorage
 */
function MockThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light')

  const value: ThemeProviderState = {
    theme,
    setTheme,
  }

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

const AllTheProviders = ({ children }: AllTheProvidersProps) => {
  const queryClient = createTestQueryClient()

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MockThemeProvider>{children}</MockThemeProvider>
      </I18nextProvider>
    </QueryClientProvider>
  )
}

const customRender = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllTheProviders, ...options })

export * from '@testing-library/react'
export { customRender as render }
