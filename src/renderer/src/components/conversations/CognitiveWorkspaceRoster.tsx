import { History, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  WorkspaceAgentRow,
  WorkspaceThreadRow
} from '../../../../shared/cognitive-workspace-projection'
import type { AgentProjectChoice } from '../agents/agent-project-choices'

import { RunningSessionsSection } from './RunningSessionsSection'
import { WorkspaceAgentButton, WorkspaceThreadButton } from './workspace-roster-rows'
import type { WorkspaceRunningSession } from './workspace-running-sessions'
import { WorkspaceExitButton } from './WorkspaceExitButton'
import { WorkspaceProjectsSection } from './WorkspaceProjectsSection'

export type WorkspaceRosterTab = 'agents' | 'threads' | 'projects'

export type WorkspaceAgentsLoad =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed'; reason: string }

/**
 * The Cognitive Workspace's left column: who you can talk to, what you have talked about, and the
 * project estate they work in. Agent and thread rows come from the shared projection, projects from
 * the canonical estate the Terminals view reads; this component only lays them out. "Recent
 * threads" under Agents are the open agent's threads, or Brainstorming's when no agent is open, so
 * the list beside a chat is always that chat's own history.
 */
export function CognitiveWorkspaceRoster({
  fullWidth,
  tab,
  onTabChange,
  agentsLoad,
  agents,
  projectChoices,
  runningSessions,
  recentThreads,
  allThreads,
  threadsLoading,
  activeAgentId,
  activeThreadId,
  draftActive,
  onOpenAgent,
  onOpenThread,
  onNewThread,
  onNewAgent,
  onNewAgentHere
}: {
  fullWidth: boolean
  tab: WorkspaceRosterTab
  onTabChange: (tab: WorkspaceRosterTab) => void
  agentsLoad: WorkspaceAgentsLoad
  agents: readonly WorkspaceAgentRow[]
  projectChoices: readonly AgentProjectChoice[]
  runningSessions: readonly WorkspaceRunningSession[]
  recentThreads: readonly WorkspaceThreadRow[]
  allThreads: readonly WorkspaceThreadRow[]
  threadsLoading: boolean
  activeAgentId: string | null
  activeThreadId: string | null
  draftActive: boolean
  onOpenAgent: (agentId: string) => void
  onOpenThread: (row: WorkspaceThreadRow) => void
  onNewThread: () => void
  onNewAgent: () => void
  onNewAgentHere: (projectId: string) => void
}): React.JSX.Element {
  const openResumeCenter = useAppStore((s) => s.openResumeCenter)
  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col bg-background',
        fullWidth ? 'w-full' : 'w-64 border-r border-border'
      )}
      aria-label={translate('workspace.roster.label', 'Cognitive Workspace')}
      data-testid="workspace-roster"
    >
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
        <WorkspaceExitButton />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">
            {translate('workspace.title', 'Cognitive Workspace')}
          </h1>
          <p className="text-xs text-muted-foreground">
            {translate('workspace.subtitle', 'Agents, conversations and execution.')}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={openResumeCenter}
            aria-label={translate('resumeCenter.title', 'Resume Center')}
            data-testid="workspace-open-resume-center"
          >
            <History className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onNewAgent}
            aria-label={translate('agents.new', 'New agent')}
            data-testid="workspace-new-agent"
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as WorkspaceRosterTab)}>
        <TabsList variant="line" className="w-full justify-start border-b border-border px-3">
          <TabsTrigger value="agents" data-testid="workspace-tab-agents">
            {translate('workspace.tab.agents', 'Agents')}
          </TabsTrigger>
          <TabsTrigger value="threads" data-testid="workspace-tab-threads">
            {translate('workspace.tab.threads', 'Threads')}
          </TabsTrigger>
          <TabsTrigger value="projects" data-testid="workspace-tab-projects">
            {translate('workspace.tab.projects', 'Projects')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* A plain scroller, not ScrollArea: its viewport sizes content to max-content, which let
          long thread titles push rows past the column edge instead of truncating. */}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex flex-col gap-4 p-2">
          {tab === 'agents' ? (
            <>
              <RunningSessionsSection sessions={runningSessions} />
              <h2 className="-mb-3 px-2 text-xs font-medium text-muted-foreground">
                {translate('workspace.yourAgents', 'Your agents')}
              </h2>
              <AgentsSection
                load={agentsLoad}
                agents={agents}
                activeAgentId={activeAgentId}
                onOpenAgent={onOpenAgent}
              />
              <ThreadsSection
                heading={translate('workspace.recentThreads', 'Recent threads')}
                rows={recentThreads}
                loading={threadsLoading}
                activeThreadId={activeThreadId}
                draftActive={draftActive}
                onOpenThread={onOpenThread}
                onNewThread={onNewThread}
              />
            </>
          ) : null}
          {tab === 'threads' ? (
            <ThreadsSection
              heading={null}
              rows={allThreads}
              loading={threadsLoading}
              activeThreadId={activeThreadId}
              draftActive={draftActive}
              onOpenThread={onOpenThread}
              onNewThread={onNewThread}
            />
          ) : null}
          {tab === 'projects' ? (
            <>
              {/* Only a failure or a pending read: "no agents" is not news on a projects list. */}
              {agentsLoad.status === 'ready' ? null : (
                <AgentsLoadNotice load={agentsLoad} empty={false} />
              )}
              <WorkspaceProjectsSection
                choices={projectChoices}
                agents={agents}
                activeAgentId={activeAgentId}
                onOpenAgent={onOpenAgent}
                onNewAgentHere={onNewAgentHere}
              />
            </>
          ) : null}
        </div>
      </div>
    </aside>
  )
}

function AgentsLoadNotice({ load, empty }: { load: WorkspaceAgentsLoad; empty: boolean }) {
  if (load.status === 'loading') {
    return (
      <p className="px-2 text-xs text-muted-foreground" role="status">
        {translate('agents.loading', 'Loading agents…')}
      </p>
    )
  }
  if (load.status === 'failed') {
    // "Could not read" is not "you have none": the second invites a duplicate agent.
    return (
      <p
        className="px-2 text-xs text-destructive"
        role="alert"
        data-testid="workspace-agents-error"
      >
        {translate('agents.readFailed', 'Could not read your agents.')} {load.reason}
      </p>
    )
  }
  return empty ? (
    <p className="px-2 text-xs text-muted-foreground" data-testid="workspace-agents-empty">
      {translate('agents.empty', 'You have no agents yet.')}
    </p>
  ) : null
}

function AgentsSection({
  load,
  agents,
  activeAgentId,
  onOpenAgent
}: {
  load: WorkspaceAgentsLoad
  agents: readonly WorkspaceAgentRow[]
  activeAgentId: string | null
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  return (
    <section>
      <AgentsLoadNotice load={load} empty={agents.length === 0} />
      <ul className="flex flex-col gap-0.5" data-testid="workspace-agents">
        {agents.map((row) => (
          <li key={row.agent.id}>
            <WorkspaceAgentButton
              row={row}
              active={row.agent.id === activeAgentId}
              onOpen={onOpenAgent}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ThreadsSection({
  heading,
  rows,
  loading,
  activeThreadId,
  draftActive,
  onOpenThread,
  onNewThread
}: {
  heading: string | null
  rows: readonly WorkspaceThreadRow[]
  loading: boolean
  activeThreadId: string | null
  draftActive: boolean
  onOpenThread: (row: WorkspaceThreadRow) => void
  onNewThread: () => void
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      {heading !== null ? (
        <h2 className="px-2 text-xs font-medium text-muted-foreground">{heading}</h2>
      ) : null}
      <ul className="flex flex-col gap-0.5" data-testid="conversations-list">
        {rows.map((row) => (
          <li key={row.id}>
            <WorkspaceThreadButton
              row={row}
              active={row.id === activeThreadId}
              onOpen={onOpenThread}
            />
          </li>
        ))}
      </ul>
      {!loading && rows.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {translate('conversations.empty', 'No conversations yet.')}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="mt-1 justify-center"
        onClick={onNewThread}
        aria-current={draftActive ? 'true' : undefined}
        data-testid="conversations-new-chat"
      >
        <Plus className="size-4" />
        {translate('workspace.newThread', 'New thread')}
      </Button>
    </section>
  )
}
