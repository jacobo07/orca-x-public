import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { observeSleepAuthorizationPlan } from '@/lib/observe-sleep-authorization-plan'
import { sleepAuthorizedAgentPanes } from '@/lib/agent-hibernation-coordinator'
import { observeReclaimAfterSleep } from '@/lib/agent-sleep-observed-reclaim'
import type { SampledRuntimePtyLiveness } from '@/lib/agent-hibernation-planner-snapshot'
import {
  createRuntimePtyLivenessObserver,
  getRuntimeLivenessSampleKey
} from '@/lib/runtime-pty-liveness-observer'
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
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey,
      lastTerminalInputAtByPaneKey: s.lastTerminalInputAtByPaneKey
    }))
  )
  const runtimeLiveness = useRuntimePtyLivenessSample(signals)
  const plan = useMemo(() => {
    void signals
    return observeSleepAuthorizationPlan(runtimeLiveness)
  }, [signals, runtimeLiveness])
  return (
    <SleepReclaimAuthorizationSection
      plan={plan}
      onSleep={sleepAuthorizedAgentPanes}
      onObserve={observeReclaimAfterSleep}
    />
  )
}

/** One liveness sample per showing, and again only when what it describes changes. */
function useRuntimePtyLivenessSample(signals: object): SampledRuntimePtyLiveness | null {
  const [sample, setSample] = useState<SampledRuntimePtyLiveness | null>(null)
  const [observer] = useState(() => createRuntimePtyLivenessObserver(setSample))
  const key = useMemo(() => {
    void signals
    return getRuntimeLivenessSampleKey(useAppStore.getState())
  }, [signals])
  useEffect(() => (key ? observer.request(useAppStore.getState()) : undefined), [observer, key])
  return sample
}
