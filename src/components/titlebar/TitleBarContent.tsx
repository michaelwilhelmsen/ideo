import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'
import { executeCommand, useCommandContext } from '@/lib/commands'
import { LayoutGrid, PanelRight, PanelRightClose, Settings } from 'lucide-react'

/**
 * The way back to the overview (#55).
 *
 * Where the project-list toggle used to be, and deliberately in the same place:
 * this is the one piece of chrome that says the editor is somewhere you went
 * rather than the whole app. Absent on the overview itself, because a front
 * door with a way back to itself is a button that does nothing.
 *
 * Place this after window controls on macOS, or at the start on Windows/Linux.
 */
export function TitleBarLeftActions() {
  const { t } = useTranslation()
  const view = useUIStore(state => state.view)
  const setView = useUIStore(state => state.setView)

  if (view === 'overview') return <div className="flex items-center gap-1" />

  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={() => setView('overview')}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t('titlebar.showOverview')}
        aria-label={t('titlebar.showOverview')}
      >
        <LayoutGrid className="h-3 w-3" />
      </Button>
    </div>
  )
}

/**
 * Right-side toolbar actions (settings, sidebar toggle).
 * Place this before window controls on Windows, or at the end on macOS/Linux.
 */
export function TitleBarRightActions() {
  const { t } = useTranslation()
  const rightSidebarVisible = useUIStore(state => state.rightSidebarVisible)
  const toggleRightSidebar = useUIStore(state => state.toggleRightSidebar)
  const commandContext = useCommandContext()

  const handleOpenPreferences = async () => {
    const result = await executeCommand('open-preferences', commandContext)
    if (!result.success && result.error) {
      commandContext.showToast(result.error, 'error')
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        onClick={handleOpenPreferences}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t('titlebar.settings')}
      >
        <Settings className="h-3 w-3" />
      </Button>

      <Button
        onClick={toggleRightSidebar}
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-foreground/70 hover:text-foreground"
        title={t(
          rightSidebarVisible
            ? 'titlebar.hideRightSidebar'
            : 'titlebar.showRightSidebar'
        )}
      >
        {rightSidebarVisible ? (
          <PanelRightClose className="h-3 w-3" />
        ) : (
          <PanelRight className="h-3 w-3" />
        )}
      </Button>
    </div>
  )
}

interface TitleBarTitleProps {
  title?: string
}

/**
 * Centered title for the title bar.
 * Uses absolute positioning to stay centered regardless of other content.
 */
export function TitleBarTitle({ title = 'Ideo' }: TitleBarTitleProps) {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <span className="text-sm font-medium text-foreground/80">{title}</span>
    </div>
  )
}

/**
 * Combined toolbar content for simple layouts.
 * Use this for Linux or when you want all toolbar items in one fragment.
 *
 * For more control, use TitleBarLeftActions, TitleBarRightActions, and TitleBarTitle separately.
 */
export function TitleBarContent({ title = 'Ideo' }: TitleBarTitleProps) {
  return (
    <>
      <TitleBarLeftActions />
      <TitleBarTitle title={title} />
      <TitleBarRightActions />
    </>
  )
}
