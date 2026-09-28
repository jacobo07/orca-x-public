import { useState } from 'react'
import { FolderPlus, Plus, SquareTerminal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import { openProjectInWorkbench, type OpenProjectInWorkbenchOutcome } from '@/lib/open-project-in-workbench'
import { useAppStore } from '@/store'
import type { WorkspaceAgentRow } from '../../../../shared/cognitive-workspace-projection'
import type { AgentProjectChoice, AgentProjectHost } from '../agents/agent-project-choices'

import { projectWorkspaceProjects, type WorkspaceOrphanGroup } from './workspace-projects-projection'
import { WorkspaceAgentButton } from './workspace-roster-rows'

/** Only outcomes that leave the user here need words; the opened ones navigate away. */
function openOutcomeNotice(outcome: OpenProjectInWorkbenchOutcome, host: string): string | null {
  switch (outcome) {
    case 'no-workspace':
      return translate('workspace.projects.noWorkspace', 'No workspace on {{host}} yet.', { host })
    case 'workspace-lookup-failed':
      return translate('workspace.projects.lookupFailed', '{{host}} could not be asked for its workspaces.', { host })
    case 'activation-refused':
      return translate('workspace.projects.refused', 'Orca could not open that workspace.')
    case 'opened':
    case 'opened-with-terminal':
    case 'opened-in-other-window':
      return null
  }
}

function orphanHeading(key: WorkspaceOrphanGroup['key']): string {
  if (key === 'none') {
    return translate('workspace.projects.noProject', 'No project')
  }
  if (key === 'unknown') {
    return translate('workspace.projects.unknown', 'Project unknown')
  }
  return translate('workspace.projects.unavailable', 'Project no longer available')
}

/**
 * The canonical project estate — the one Terminals shows — with the agents that belong to each.
 * A context projection, not a second project manager: adding a project goes through Orca's own
 * add flow, and opening one goes through the launcher's own action on the chosen host.
 */
export function WorkspaceProjectsSection({
  choices,
  agents,
  activeAgentId,
  onOpenAgent,
  onNewAgentHere
}: {
  choices: readonly AgentProjectChoice[]
  agents: readonly WorkspaceAgentRow[]
  activeAgentId: string | null
  onOpenAgent: (agentId: string) => void
  onNewAgentHere: (projectId: string) => void
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const [notices, setNotices] = useState<Record<string, string>>({})
  const { projects, orphans } = projectWorkspaceProjects(choices, agents)

  const open = async (projectId: string, host: AgentProjectHost): Promise<void> => {
    const notice = openOutcomeNotice(await openProjectInWorkbench(host.repoId), host.label)
    setNotices((current) => {
      const next = { ...current }
      if (notice) {
        next[projectId] = notice
      } else {
        delete next[projectId]
      }
      return next
    })
  }

  return (
    <section className="flex flex-col gap-3" data-testid="workspace-projects">
      {projects.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-2" data-testid="workspace-projects-empty">
          <p className="text-xs text-muted-foreground">
            {translate('workspace.projects.empty', 'Orca has no projects yet.')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => openModal('add-repo')}>
            <FolderPlus className="size-3.5" />
            {translate('workspace.projects.add', 'Add project')}
          </Button>
        </div>
      ) : null}
      {projects.map(({ choice, agents: rows }) => (
        <div key={choice.projectId} data-testid="workspace-project" data-project-id={choice.projectId}>
          <div className="flex items-center gap-1 px-2">
            <RepoBadgeLabel name={choice.displayName} color={choice.badgeColor} className="min-w-0 flex-1 text-xs font-medium" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => onNewAgentHere(choice.projectId)}
              aria-label={translate('workspace.projects.newAgent', 'New agent in {{project}}', { project: choice.displayName })}
              data-testid="workspace-project-new-agent"
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 px-2 pt-1">
            {choice.hosts.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                {translate('agents.project.notSetUp', 'Not set up on any host')}
              </span>
            ) : null}
            {choice.hosts.map((host) => (
              <button
                key={host.id}
                type="button"
                onClick={() => void open(choice.projectId, host)}
                className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title={translate('workspace.projects.openOn', 'Open in Terminals on {{host}}', { host: host.label })}
                data-testid="workspace-project-open"
                data-host-id={host.id}
              >
                <SquareTerminal className="size-3" />
                {host.label}
              </button>
            ))}
          </div>
          {notices[choice.projectId] ? (
            <p role="status" className="px-2 pt-1 text-[11px] text-muted-foreground">
              {notices[choice.projectId]}
            </p>
          ) : null}
          <ul className="flex flex-col gap-0.5 pt-1">
            {rows.map((row) => (
              <li key={row.agent.id}>
                <WorkspaceAgentButton row={row} active={row.agent.id === activeAgentId} onOpen={onOpenAgent} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {orphans.map((group) => (
        <div key={group.key} data-testid="workspace-project-group" data-group-key={group.key}>
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{orphanHeading(group.key)}</h2>
          <ul className="flex flex-col gap-0.5">
            {group.agents.map((row) => (
              <li key={row.agent.id}>
                <WorkspaceAgentButton row={row} active={row.agent.id === activeAgentId} onOpen={onOpenAgent} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
