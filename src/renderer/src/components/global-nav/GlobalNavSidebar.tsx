import { House, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import logo from '../../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { WorkspaceActivityRailSection } from '@/components/activity-rail/WorkspaceActivityRailSection'
import { isMac } from '@/app-shell/app-window-chrome'
import { GlobalNavEntry } from './global-nav-entry'
import { ResumeCenterNavEntries } from './ResumeCenterNavEntries'

/**
 * The application's global navigation: one component, the window's left edge, every route.
 *
 * Collapsed is the person's choice (`globalNavCollapsed`), never the route's — a route that changes
 * this column is the defect it exists to prevent. It also owns the top-left window chrome (macOS
 * traffic lights, the app mark), because it is what sits there now.
 *
 * One route swaps the destinations, by Owner decision (2026-10-02): Resume Center shows its own set
 * with Back. The column itself — width, collapse, header, Settings — is the same.
 */
export function GlobalNavSidebar(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.globalNavCollapsed)
  const toggleCollapsed = useAppStore((s) => s.toggleGlobalNavCollapsed)
  const isFullScreen = useAppStore((s) => s.isFullScreen)
  const showAppName = useAppStore((s) => s.settings?.showTitlebarAppName !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const displayName = useAppStore((s) => s.orcaProfileAuthStatus?.cloud?.displayName?.trim())
  const trafficLights = isMac && !isFullScreen
  const resumeCenter = activeView === 'resumeCenter'
  const appName = translate('auto.App.5096cbbc86', 'Orca')
  const homeLabel = translate('globalNav.home', 'Home')
  const settingsLabel = translate('menu.settings', 'Settings')
  const toggleLabel = collapsed
    ? translate('globalNav.expand', 'Expand navigation')
    : translate('globalNav.collapse', 'Collapse navigation')

  return (
    <nav
      data-global-nav=""
      data-global-nav-variant={resumeCenter ? 'resume-center' : 'global'}
      data-global-nav-collapsed={collapsed ? 'true' : 'false'}
      aria-label={translate('globalNav.label', 'Orca navigation')}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        // Why 80px collapsed on macOS: the native traffic lights live in this column's header.
        collapsed ? (trafficLights ? 'w-20' : 'w-[52px]') : 'w-[208px]'
      )}
    >
      <TooltipProvider delayDuration={400}>
        <div
          className="flex h-[36px] min-h-[36px] shrink-0 items-center gap-2 px-3 [-webkit-app-region:drag]"
          data-global-nav-header=""
        >
          {trafficLights ? <div className="titlebar-traffic-light-pad -ml-3" /> : null}
          {!trafficLights ? (
            <img src={logo} alt="" aria-hidden className="size-4 shrink-0" />
          ) : null}
          {!collapsed && showAppName ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="truncate text-[13px] font-semibold">{appName}</span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => void updateSettings({ showTitlebarAppName: false })}
                >
                  {translate('auto.App.e81217c1b7', 'Hide App Name')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ) : null}
        </div>

        <div
          className={cn(
            'scrollbar-sleek flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-2',
            collapsed ? 'items-center' : 'px-2'
          )}
        >
          {resumeCenter ? (
            <ResumeCenterNavEntries collapsed={collapsed} />
          ) : (
            <>
              <GlobalNavEntry
                collapsed={collapsed}
                id="home"
                icon={<House size={collapsed ? 18 : 16} />}
                label={homeLabel}
                active={activeView === 'terminal'}
                onSelect={() => setActiveView('terminal')}
              />
              <WorkspaceActivityRailSection layout={collapsed ? 'icon' : 'row'} />
            </>
          )}
        </div>

        <div
          className={cn(
            'flex shrink-0 flex-col gap-0.5 border-t border-sidebar-border py-2',
            collapsed ? 'items-center' : 'px-2'
          )}
        >
          <GlobalNavEntry
            collapsed={collapsed}
            id="settings"
            icon={<Settings size={collapsed ? 18 : 16} />}
            label={settingsLabel}
            active={activeView === 'settings'}
            onSelect={openSettingsPage}
          />
          {displayName && !collapsed ? (
            <div
              className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted-foreground"
              data-global-nav-user=""
            >
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-medium text-sidebar-accent-foreground"
              >
                {displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate">{displayName}</span>
            </div>
          ) : null}
          <GlobalNavEntry
            collapsed={collapsed}
            id="toggle"
            icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={16} />}
            label={toggleLabel}
            active={false}
            onSelect={toggleCollapsed}
            structural
          />
        </div>
      </TooltipProvider>
    </nav>
  )
}
