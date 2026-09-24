import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  WorkspaceAgentRow,
  WorkspaceThreadRow
} from '../../../../shared/cognitive-workspace-projection'

import {
  projectRefLabel,
  WorkspaceAgentButton,
  WorkspaceThreadButton
} from './workspace-roster-rows'

export type WorkspaceRosterTab = 'agents' | 'threads' | 'projects'

export type WorkspaceAgentsLoad =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed'; reason: string }

/**
 * The Cognitive Workspace's left column: who you can talk to, what you have talked about, and which
 * project each belongs to. Every row comes from the shared projection; this component only lays
 * it out. "Recent threads" under Agents are the open agent's threads, or Brainstorming's when no
 * agent is open, so the list beside a chat is always that chat's own history.
 */
export function CognitiveWorkspaceRoster({
  fullWidth,
  tab,
  onTabChange,
  agentsLoad,
  agents,
  recentThreads,
  allThreads,
  threadsLoading,
  activeAgentId,
  activeThreadId,
  draftActive,
  onOpenAgent,
  onOpenThread,
  onNewThread,
  onNewAgent
}: {
  fullWidth: boolean
  tab: WorkspaceRosterTab
  onTabChange: (tab: WorkspaceRosterTab) => void
  agentsLoad: WorkspaceAgentsLoad
  agents: readonly WorkspaceAgentRow[]
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
}): React.JSX.Element {
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
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            {translate('workspace.title', 'Cognitive Workspace')}
          </h1>
          <p className="text-xs text-muted-foreground">
            {translate('workspace.subtitle', 'Agents, conversations and execution.')}
          </p>
        </div>
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
            <ProjectsSection
              load={agentsLoad}
              agents={agents}
              activeAgentId={activeAgentId}
              onOpenAgent={onOpenAgent}
            />
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

/** Agents grouped by the project that owns them, in roster order; "no project" and
 *  "project unavailable" keep their own headings rather than being folded together. */
function ProjectsSection({
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
  const groups = new Map<string, { label: string; rows: WorkspaceAgentRow[] }>()
  for (const row of agents) {
    const key =
      row.project.kind === 'project' || row.project.kind === 'unresolved'
        ? `${row.project.kind}:${row.project.projectId}`
        : row.project.kind
    const existing = groups.get(key)
    if (existing) {
      existing.rows.push(row)
    } else {
      groups.set(key, { label: projectRefLabel(row.project), rows: [row] })
    }
  }
  return (
    <section className="flex flex-col gap-3" data-testid="workspace-projects">
      <AgentsLoadNotice load={load} empty={agents.length === 0} />
      {[...groups.entries()].map(([key, group]) => (
        <div key={key} data-testid="workspace-project-group" data-group-key={key}>
          <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h2>
          <ul className="flex flex-col gap-0.5">
            {group.rows.map((row) => (
              <li key={row.agent.id}>
                <WorkspaceAgentButton
                  row={row}
                  active={row.agent.id === activeAgentId}
                  onOpen={onOpenAgent}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
