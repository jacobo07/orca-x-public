import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { observeSleepAuthorizationPlan } from '@/lib/observe-sleep-authorization-plan'
import { SleepReclaimAuthorizationSection } from './SleepReclaimAuthorizationSection'

/**
 * Feeds the resource popover's sleep section from live state. Mounted only while
 * the popover is open, so a closed status bar does no per-pane work.
 */
export function SleepReclaimAuthorizationPanel(): React.JSX.Element | null {
  // Why: these are change signals only — the plan reads the store itself. The
  // snapshot is re-polled while the popover is open, which also re-reads inputs
  // that live outside the store (mobile drivers, foreground tabs, the clock).
  const signals = useAppStore(
    useShallow((s) => ({
      memorySnapshot: s.memorySnapshot,
      settings: s.settings,
      activeWorktreeId: s.activeWorktreeId,
      tabsByWorktree: s.tabsByWorktree,
      ptyIdsByTabId: s.ptyIdsByTabId,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey,
      lastTerminalInputAtByPaneKey: s.lastTerminalInputAtByPaneKey
    }))
  )
  const plan = useMemo(() => {
    void signals
    return observeSleepAuthorizationPlan()
  }, [signals])
  return <SleepReclaimAuthorizationSection plan={plan} />
}
