import { House, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import logo from '../../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { WorkspaceActivityRailSection } from '@/components/activity-rail/WorkspaceActivityRailSection'
import { isMac } from '@/app-shell/app-window-chrome'
import { GlobalNavRow } from './GlobalNavRow'

/**
 * The application's global navigation: one component, the window's left edge, every route.
 *
 * Collapsed is the person's choice (`globalNavCollapsed`), never the route's — a route that changes
 * this column is the defect it exists to prevent. It also owns the top-left window chrome (macOS
 * traffic lights, the app mark), because it is what sits there now.
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
  const appName = translate('auto.App.5096cbbc86', 'Orca')
  const homeLabel = translate('globalNav.home', 'Home')
  const settingsLabel = translate('menu.settings', 'Settings')
  const toggleLabel = collapsed
    ? translate('globalNav.expand', 'Expand navigation')
    : translate('globalNav.collapse', 'Collapse navigation')

  return (
    <nav
      data-global-nav=""
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
          {!trafficLights ? <img src={logo} alt="" aria-hidden className="size-4 shrink-0" /> : null}
          {!collapsed && showAppName ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="truncate text-[13px] font-semibold">{appName}</span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void updateSettings({ showTitlebarAppName: false })}>
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
          <NavEntry
            collapsed={collapsed}
            id="home"
            icon={<House size={collapsed ? 18 : 16} />}
            label={homeLabel}
            active={activeView === 'terminal'}
            onSelect={() => setActiveView('terminal')}
          />
          <WorkspaceActivityRailSection layout={collapsed ? 'icon' : 'row'} />
        </div>

        <div
          className={cn(
            'flex shrink-0 flex-col gap-0.5 border-t border-sidebar-border py-2',
            collapsed ? 'items-center' : 'px-2'
          )}
        >
          <NavEntry
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
          <NavEntry
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

function NavEntry({
  collapsed,
  id,
  icon,
  label,
  active,
  onSelect,
  structural = false
}: {
  collapsed: boolean
  id: string
  icon: React.ReactNode
  label: string
  active: boolean
  onSelect: () => void
  /** Chrome control, not a destination: excluded from the destination list the shell gate compares. */
  structural?: boolean
}): React.JSX.Element {
  const dataAttributes: Record<string, string> = structural
    ? { 'data-global-nav-control': id }
    : { 'data-global-nav-item': id }
  if (!collapsed) {
    return (
      <GlobalNavRow
        icon={icon}
        label={label}
        active={active}
        onSelect={onSelect}
        dataAttributes={dataAttributes}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...dataAttributes}
          aria-current={active ? 'page' : undefined}
          aria-label={label}
          onClick={onSelect}
          className={cn(
            'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
        >
          {icon}
          {active ? (
            <div className="absolute top-[25%] right-0 bottom-[25%] w-[2px] rounded-l bg-foreground" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
