import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useWorkspaceRunningSessions } from '../conversations/use-workspace-running-sessions'
import { HostSectionHeaderMenu } from '../sidebar/HostSectionHeaderMenu'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import { WorkspaceFrame } from '../workspace-frame/WorkspaceFrame'
import {
  agentStateLabel,
  failureLabel,
  hostKindLabel,
  reachabilityLabel,
  reachabilityTone,
  setupStateLabel
} from './workstation-labels'
import { buildWorkstation, type WorkstationNode } from './workstation-projection'
import { WorkstationSummaryPanel } from './WorkstationSummaryPanel'

/** Workspace › Workstation (docs/reference/workspace-workstation.md): a projection, owns no state. */
export default function WorkstationPage(): React.JSX.Element {
  const { hostOptions } = useSidebarHostScopeOptions()
  const setups = useAppStore((s) => s.projectHostSetups)
  const projects = useAppStore((s) => s.projects)
  const sessions = useWorkspaceRunningSessions()
  const { nodes, summary } = useMemo(
    () => buildWorkstation({ hosts: hostOptions, setups, projects, sessions }),
    [hostOptions, setups, projects, sessions]
  )
  const hasRemoteHost = nodes.some((node) => node.host !== null && node.host.kind !== 'local')

  return (
    <WorkspaceFrame
      context={<WorkstationSummaryPanel summary={summary} />}
      testId="workstation-page"
    >
      <div className="scrollbar-sleek flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-6 md:px-8">
        <header>
          <h1 className="text-2xl font-semibold">
            {translate('workspaceNav.workstation', 'Workstation')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {translate(
              'workstation.page.subtitle',
              'Every host Orca knows, what Orca has observed about it, and what runs there.'
            )}
          </p>
        </header>
        <ul
          className="flex flex-col gap-3"
          aria-label={translate('workstation.page.hosts', 'Hosts')}
        >
          {nodes.map((node) => (
            <HostCard key={node.hostId} node={node} />
          ))}
        </ul>
        {hasRemoteHost ? null : <NoRemoteHosts />}
      </div>
    </WorkspaceFrame>
  )
}

function HostCard({ node }: { node: WorkstationNode }): React.JSX.Element {
  const failure = failureLabel(node)
  const vouches = node.reachability === 'this-machine' || node.reachability === 'reachable'
  return (
    <li
      data-workstation-host={node.hostId}
      data-workstation-reachability={node.reachability}
      className="rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-sm font-semibold">{node.label}</h2>
          {/* Why no registry `detail`: it is only an untranslated kind word. This machine's badge
              already names its kind. */}
          {node.reachability === 'this-machine' ? null : (
            <p data-workstation-kind="" className="break-words text-xs text-muted-foreground">
              {hostKindLabel(node)}
            </p>
          )}
        </div>
        <span
          data-workstation-reachability-label=""
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            aria-hidden
            className={cn('inline-block size-2 rounded-full', reachabilityTone(node.reachability))}
          />
          {reachabilityLabel(node.reachability)}
        </span>
        {node.host ? (
          <HostSectionHeaderMenu
            alwaysVisible
            row={{
              type: 'host-header',
              key: node.hostId,
              hostId: node.hostId,
              kind: node.host.kind,
              label: node.host.label,
              detail: node.host.detail,
              health: node.host.health,
              compatibility: node.host.compatibility,
              connectionStatus: node.host.connectionStatus,
              collapsed: false,
              count: node.projects.length
            }}
          />
        ) : null}
      </div>
      {failure ? (
        <p data-workstation-failure="" className="mt-2 text-xs text-[var(--status-error)]">
          {failure}
        </p>
      ) : null}

      <section className="mt-3" data-workstation-section="projects">
        <h3 className="text-xs font-medium text-muted-foreground">
          {translate('workstation.projects.title', 'Projects')}
        </h3>
        {node.projects.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {translate('workstation.projects.none', 'No projects set up on this host.')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {node.projects.map((project) => (
              <li
                key={project.setupId}
                data-workstation-project={project.projectId}
                className="flex items-baseline gap-3 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="break-words">{project.name}</span>
                  <span className="block break-all font-mono text-[11px] text-muted-foreground">
                    {project.path}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {setupStateLabel(project.setupState)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-3" data-workstation-section="agents">
        <h3 className="text-xs font-medium text-muted-foreground">
          {translate('workstation.agents.title', 'Agents')}
        </h3>
        {node.agents.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {vouches
              ? translate('workstation.agents.none', 'No agents running.')
              : translate(
                  'workstation.agents.noneSeen',
                  'None that Orca can see while the host is not connected.'
                )}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {node.agents.map((agent) => (
              <li
                key={agent.paneKey}
                data-workstation-agent={agent.paneKey}
                data-workstation-agent-state={agent.state}
                className="flex items-baseline gap-3 text-sm"
              >
                <span className="min-w-0 flex-1 break-words">
                  {agent.title}
                  {agent.projectName ? (
                    <span className="text-xs text-muted-foreground"> · {agent.projectName}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agentStateLabel(agent.state)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </li>
  )
}

function NoRemoteHosts(): React.JSX.Element {
  const open = (pane: 'ssh' | 'servers'): void => {
    const state = useAppStore.getState()
    state.openSettingsTarget(
      pane === 'ssh'
        ? { pane: 'ssh', repoId: null, sectionId: 'ssh' }
        : { pane: 'servers', repoId: null }
    )
    state.openSettingsPage()
  }
  return (
    <div
      data-workstation-empty="no-remote-hosts"
      className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      <p className="mr-1">{translate('workstation.empty.noRemote', 'Only this machine so far.')}</p>
      <Button variant="outline" size="sm" onClick={() => open('ssh')}>
        {translate('workstation.empty.addSsh', 'Add an SSH host')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => open('servers')}>
        {translate('workstation.empty.pairServer', 'Pair an Orca server')}
      </Button>
    </div>
  )
}
