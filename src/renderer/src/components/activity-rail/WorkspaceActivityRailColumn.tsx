import React from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolveSidePanelDockGeometry } from '@/components/right-sidebar/side-panel-dock-geometry'
import { LeftNavProjectsSwitch } from '@/components/right-sidebar/left-nav-projects-switch'
import { WorkspaceActivityRailSection } from './WorkspaceActivityRailSection'

/**
 * The activity rail on views that unmount the side panel.
 *
 * The rail normally rides inside the side panel's icon strip, which is correct while the panel is
 * there. But full-page surfaces — Tasks, Automations, Workspace, Skills, Artifacts, Mobile — own the
 * whole content area and unmount that panel, and the rail was going with it. Every destination the
 * rail offers is one of those views, so using the rail removed the rail: you could get to a surface
 * and had no way back through the control you arrived by.
 *
 * That is the same contract the collapsed panel already states in its own comment — a strip that
 * disappears takes the way back with it. This renders the strip alone so navigation survives its own
 * use. Mutually exclusive with the panel's copy: exactly one of the two is on screen.
 */
export function WorkspaceActivityRailColumn(): React.JSX.Element | null {
  const sidePanelDock = useAppStore((s) => s.sidePanelDock)
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const geometry = resolveSidePanelDockGeometry(sidePanelDock)

  // Only the leading side strip carries application navigation; a top bar or a right-docked gutter
  // says something different about scope, exactly as the panel's own copy of this reasons.
  if (!geometry.activityBarLeads || activityBarPosition !== 'side') {
    return null
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-border',
        geometry.activityBarBorderClass,
        geometry.appliesWindowControlsInset && 'side-activity-bar-windows-inset'
      )}
    >
      <TooltipProvider delayDuration={400}>
        <WorkspaceActivityRailSection />
        <LeftNavProjectsSwitch />
      </TooltipProvider>
    </div>
  )
}
