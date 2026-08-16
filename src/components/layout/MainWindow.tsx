import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { RightSideBar } from './RightSideBar'
import { MainWindowContent } from './MainWindowContent'
import { Overview } from '@/components/overview/Overview'
import { Canvas } from '@/components/editor/Canvas'
import { NodeSidebar } from '@/components/editor/NodeSidebar'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { OnboardingDialog } from '@/components/onboarding/OnboardingDialog'
import { Toaster } from 'sonner'
import { useTheme } from '@/hooks/use-theme'
import { useUIStore } from '@/store/ui-store'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { useJobResults } from '@/services/jobs'
import { useProjectLibrary } from '@/services/projects'
import { cn } from '@/lib/utils'

/**
 * Layout sizing configuration for the editor's resizable panels.
 * All values are percentages of total width.
 *
 * One sidebar since #55: the project list is gone, and the overview it was
 * replaced by has no sidebars at all — it is a whole view rather than a panel
 * beside one.
 */
const LAYOUT = {
  rightSidebar: { default: 20, min: 15, max: 40 },
  main: { min: 30 },
} as const

// Main content default is calculated to ensure totals sum to 100%
const MAIN_CONTENT_DEFAULT = 100 - LAYOUT.rightSidebar.default

export function MainWindow() {
  const { theme } = useTheme()
  const view = useUIStore(state => state.view)
  const rightSidebarVisible = useUIStore(state => state.rightSidebarVisible)

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()

  // Keep the editor and the project folders on disk in agreement (#23):
  // loads the library, opens something, and writes edits back.
  useProjectLibrary()

  // Collect generations that finished while nobody was watching — including
  // during a previous run of the app (#24). Paid for either way.
  useJobResults()

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden rounded-[var(--app-corner-radius)] bg-background">
      <TitleBar />

      {/* The two views are mutually exclusive (#55): the sidebar belongs to
          the editor, not to the front door, and a window showing both would be
          a third layout nobody drew. */}
      <div className="flex flex-1 overflow-hidden">
        {view === 'overview' ? (
          <Overview />
        ) : (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel
              defaultSize={MAIN_CONTENT_DEFAULT}
              minSize={LAYOUT.main.min}
            >
              <MainWindowContent>
                <Canvas />
              </MainWindowContent>
            </ResizablePanel>

            <ResizableHandle className={cn(!rightSidebarVisible && 'hidden')} />

            <ResizablePanel
              defaultSize={LAYOUT.rightSidebar.default}
              minSize={LAYOUT.rightSidebar.min}
              maxSize={LAYOUT.rightSidebar.max}
              className={cn(!rightSidebarVisible && 'hidden')}
            >
              <RightSideBar className="overflow-y-auto">
                <NodeSidebar />
              </RightSideBar>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>

      {/* Global UI Components (hidden until triggered) */}
      <CommandPalette />
      <PreferencesDialog />
      {/* First launch, or a step added since the last one (#32). Main window
          only — the quick pane is no place to meet an app for the first time. */}
      <OnboardingDialog />
      <Toaster
        position="bottom-right"
        theme={
          theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
        }
        className="toaster group"
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
    </div>
  )
}
