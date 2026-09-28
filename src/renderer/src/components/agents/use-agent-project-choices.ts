import { useMemo } from 'react'

import { useAppStore } from '@/store'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'

import { buildAgentProjectChoices, type AgentProjectChoice } from './agent-project-choices'

/** The canonical project estate with host labels and health exactly as the Terminals sidebar shows them. */
export function useAgentProjectChoices(): readonly AgentProjectChoice[] {
  const projects = useAppStore((s) => s.projects)
  const setups = useAppStore((s) => s.projectHostSetups)
  const { hostOptions } = useSidebarHostScopeOptions()
  return useMemo(() => {
    const hosts = new Map(
      hostOptions.map((host) => [host.id, { label: host.label, health: host.health }] as const)
    )
    return buildAgentProjectChoices(projects, setups, hosts)
  }, [projects, setups, hostOptions])
}
