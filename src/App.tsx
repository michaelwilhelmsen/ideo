import { useEffect } from 'react'
import { initializeCommandSystem } from './lib/commands'
import { buildAppMenu, setupMenuLanguageListener } from './lib/menu'
import { initializeLanguage } from './i18n/language-init'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import { commands } from './lib/tauri-bindings'
import './App.css'
import { MainWindow } from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useSquareCornersEffect } from './hooks/useSquareCornersEffect'

function App() {
  useSquareCornersEffect()

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('🚀 Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // Initialize language based on saved preference or system locale
    const initLanguageAndMenu = async () => {
      try {
        // Load preferences to get saved language
        const result = await commands.loadPreferences()
        const savedLanguage =
          result.status === 'ok' ? result.data.language : null

        // Initialize language (will use system locale if no preference)
        await initializeLanguage(savedLanguage)

        // Build the application menu with the initialized language
        await buildAppMenu()
        logger.debug('Application menu built')
        setupMenuLanguageListener()
      } catch (error) {
        logger.warn('Failed to initialize language or menu', { error })
      }
    }

    initLanguageAndMenu()

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
