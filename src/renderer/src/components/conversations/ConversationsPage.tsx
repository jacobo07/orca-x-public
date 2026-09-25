import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@/store'
import {
  projectWorkspaceAgents,
  projectWorkspaceThreads,
  type WorkspaceThreadRow
} from '../../../../shared/cognitive-workspace-projection'
import type { ConnectedApplicationView } from '../../../../shared/connected-application'
import type { ConversationSummary } from '../../../../shared/conversation-summary'
import type { ConversationRecord } from '../../../../shared/conversation-types'
import { resolveDefaultProjectId } from '../agents/default-agent-project'
import { NewAgentDialog } from '../agents/NewAgentDialog'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'

import { AgentChatHeader } from './AgentChatHeader'
import { AgentContextRail } from './AgentContextRail'
import { AgentFederationCards } from './AgentFederationCards'
import { conversationsInScope, latestConversationForAgent } from './agent-chat-scope'
import { CognitiveWorkspaceLayout } from './CognitiveWorkspaceLayout'
import { ConnectedApplicationsCard } from './ConnectedApplicationsCard'
import { ConnectedApplicationSurface } from './ConnectedApplicationSurface'
import { CognitiveWorkspaceRoster, type WorkspaceRosterTab } from './CognitiveWorkspaceRoster'
import { ConversationComposer } from './ConversationComposer'
import { ConversationNotice } from './ConversationNotice'
import {
  applyConversationLiveEvent,
  applyConversationTurnOutcome,
  beginConversationTurn,
  EMPTY_CONVERSATION_LIVE_STATE,
  noticeForAgentCreateRefusal,
  type ConversationLiveState
} from './conversation-live-state'
import { conversationToNativeChatSession } from './conversation-native-chat-session'
import { useAgentGrounding } from './use-agent-grounding'
import { useWorkspaceAgents } from './use-workspace-agents'

/**
 * The Cognitive Workspace: roster | chat | context, over ONE conversation stack.
 *
 * `conversationAgentScope` null is Brainstorming; an agent id is a chat with that agent — same
 * list, stream, composer and main-process owner. Rows come from the shared projection, grounding
 * from the turn runner's own resolver, and the chat stays the dominant column.
 *
 * "New thread" makes a DRAFT, not a record: the record is minted, and the user's message made
 * durable, on the first send — so browsing never piles up empty conversations.
 */
export default function ConversationsPage(): React.JSX.Element {
  const agentScope = useAppStore((s) => s.conversationAgentScope)
  const openAgentChat = useAppStore((s) => s.openAgentChat)
  const openConversationsPage = useAppStore((s) => s.openConversationsPage)
  const projects = useAppStore((s) => s.projects)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const roster = useWorkspaceAgents(agentScope)
  const [summaries, setSummaries] = useState<readonly ConversationSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftActive, setDraftActive] = useState(true)
  const [record, setRecord] = useState<ConversationRecord | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [live, setLive] = useState<ConversationLiveState>(EMPTY_CONVERSATION_LIVE_STATE)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<WorkspaceRosterTab>(agentScope === null ? 'threads' : 'agents')
  // null follows the layout's default (inline when wide); a click records a person's choice.
  const [railPreference, setRailPreference] = useState<boolean | null>(null)
  const [narrowPane, setNarrowPane] = useState<'roster' | 'chat'>('chat')
  const [groundingRevision, setGroundingRevision] = useState(0)
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  const [openApp, setOpenApp] = useState<ConnectedApplicationView | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const openLatestPendingRef = useRef(false)
  // A thread picked from another scope: opened once that scope's list arrives, instead of latest.
  const pendingThreadRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const grounding = useAgentGrounding(agentScope, groundingRevision)

  const refreshList = useCallback(async () => {
    setSummaries(await window.api.conversations.list())
    setListLoading(false)
  }, [])

  const loadRecord = useCallback(async (id: string) => {
    setRecordLoading(true)
    const result = await window.api.conversations.read({ id })
    setRecordLoading(false)
    if (result.outcome === 'loaded') {
      setRecord(result.record)
      setReadError(null)
      return
    }
    setRecord(null)
    // "Corrupt" and "not here" are different things to say; neither renders as an empty chat.
    setReadError(
      result.outcome === 'unreadable'
        ? result.reason
        : result.outcome === 'schema-too-new'
          ? `schema version ${result.storedVersion}`
          : 'absent'
    )
  }, [])

  useEffect(() => {
    setDraftActive(true)
    setActiveId(null)
    setLive(EMPTY_CONVERSATION_LIVE_STATE)
    setDraft('')
    setOpenApp(null)
    setListLoading(true)
    openLatestPendingRef.current = agentScope !== null || pendingThreadRef.current !== null
    void refreshList()
  }, [agentScope, refreshList])

  useEffect(() => {
    if (activeId === null) {
      setRecord(null)
      setReadError(null)
      return
    }
    void loadRecord(activeId)
  }, [activeId, loadRecord])

  useEffect(() => {
    // One subscription for the surface; the payload names its conversation.
    return window.api.conversations.onTurnEvent((payload) => {
      if (payload.conversationId !== activeIdRef.current) {
        return
      }
      setLive((current) => applyConversationLiveEvent(current, payload.event))
    })
  }, [])

  const openConversation = useCallback((id: string) => {
    setDraftActive(false)
    setActiveId(id)
    setLive(EMPTY_CONVERSATION_LIVE_STATE)
  }, [])

  useEffect(() => {
    if (!openLatestPendingRef.current || listLoading) {
      return
    }
    openLatestPendingRef.current = false
    const pending = pendingThreadRef.current
    pendingThreadRef.current = null
    const target =
      pending ?? (agentScope === null ? null : latestConversationForAgent(summaries, agentScope))
    if (target !== null) {
      openConversation(target)
    }
  }, [agentScope, listLoading, summaries, openConversation])

  const openThread = useCallback(
    (row: WorkspaceThreadRow) => {
      // A thread opens in its owner's scope. Unreadable rows and missing-agent threads have no
      // scope to move to, so they open where the user is (a send there is refused, not rerouted).
      const owner =
        row.outcome !== 'ok'
          ? agentScope
          : row.agent === null
            ? null
            : row.agent.kind === 'agent'
              ? row.agent.agentId
              : agentScope
      if (owner === agentScope) {
        openConversation(row.id)
        return
      }
      pendingThreadRef.current = row.id
      if (owner === null) {
        openConversationsPage()
      } else {
        openAgentChat(owner)
      }
    },
    [agentScope, openAgentChat, openConversation, openConversationsPage]
  )

  const startDraft = useCallback(() => {
    setDraftActive(true)
    setActiveId(null)
    setRecord(null)
    setReadError(null)
    setLive(EMPTY_CONVERSATION_LIVE_STATE)
    setDraft('')
    composerRef.current?.focus()
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || live.turnState === 'working') {
      return
    }
    let conversationId = activeId
    if (conversationId === null) {
      // The draft becomes real here, and only here.
      if (agentScope !== null) {
        const created = await window.api.conversations.createForAgent({
          agentId: agentScope,
          title: text.slice(0, 60)
        })
        if (created.outcome !== 'created') {
          // Nothing was minted; the draft stays in the composer.
          setLive((current) => ({ ...current, notice: noticeForAgentCreateRefusal(created) }))
          return
        }
        conversationId = created.record.id
      } else {
        conversationId = (await window.api.conversations.create({ title: text.slice(0, 60) })).id
      }
      setActiveId(conversationId)
      setDraftActive(false)
    }
    setDraft('')
    setLive((current) => beginConversationTurn(current))
    const outcome = await window.api.conversations.sendTurn({ id: conversationId, text, cwd: '' })
    setLive((current) => applyConversationTurnOutcome(current, outcome))
    // Re-read: the record on disk is the truth, not a locally assembled history.
    await loadRecord(conversationId)
    await refreshList()
    setGroundingRevision((value) => value + 1)
    composerRef.current?.focus()
  }, [activeId, agentScope, draft, live.turnState, loadRecord, refreshList])

  const agentRows = useMemo(
    () => projectWorkspaceAgents(roster.agents, projects, summaries),
    [roster.agents, projects, summaries]
  )
  const allThreads = useMemo(
    () => projectWorkspaceThreads(summaries, roster.agents, projects),
    [summaries, roster.agents, projects]
  )
  const recentThreads = useMemo(
    () =>
      projectWorkspaceThreads(conversationsInScope(summaries, agentScope), roster.agents, projects),
    [summaries, agentScope, roster.agents, projects]
  )
  const session = useMemo(
    () => conversationToNativeChatSession({ record, live, loading: recordLoading, readError }),
    [record, live, recordLoading, readError]
  )
  const scopedRow = agentRows.find((row) => row.agent.id === agentScope) ?? null
  const working = live.turnState === 'working'

  return (
    <CognitiveWorkspaceLayout
      testAttributes={{
        'data-testid': 'conversations-page',
        'data-conversation-scope': agentScope === null ? 'brainstorming' : 'agent'
      }}
      railOpen={railPreference}
      narrowPane={narrowPane}
      onShowRoster={() => setNarrowPane('roster')}
      roster={(mode) => (
        <CognitiveWorkspaceRoster
          fullWidth={mode === 'narrow'}
          tab={tab}
          onTabChange={setTab}
          agentsLoad={roster.load}
          agents={agentRows}
          recentThreads={recentThreads}
          allThreads={allThreads}
          threadsLoading={listLoading}
          activeAgentId={agentScope}
          activeThreadId={activeId}
          draftActive={draftActive}
          onOpenAgent={(agentId) => {
            setNarrowPane('chat')
            openAgentChat(agentId)
          }}
          onOpenThread={(row) => {
            setNarrowPane('chat')
            openThread(row)
          }}
          onNewThread={() => {
            setNarrowPane('chat')
            startDraft()
          }}
          onNewAgent={() => setNewAgentOpen(true)}
        />
      )}
      rail={
        agentScope === null ? null : (
          <AgentContextRail
            row={scopedRow}
            grounding={grounding}
            turns={record?.turns ?? []}
            liveTurnState={working ? 'working' : 'idle'}
          >
            {scopedRow?.project.kind === 'project' ? (
              <ConnectedApplicationsCard
                projectId={scopedRow.project.projectId}
                onOpen={setOpenApp}
              />
            ) : null}
            <AgentFederationCards agentId={scopedRow?.agent.id ?? null} />
          </AgentContextRail>
        )
      }
      chat={(mode) => (
        <>
          {roster.scoped !== null ? (
            <AgentChatHeader
              lookup={roster.scoped}
              project={scopedRow?.project ?? null}
              grounding={grounding}
              onBack={() => {
                // Back leaves the agent for the roster's Agents list — the directory it came from.
                setTab('agents')
                setNarrowPane('roster')
                openConversationsPage()
              }}
              compact={mode !== 'wide'}
              railOpen={railPreference ?? mode === 'wide'}
              onToggleRail={() => setRailPreference(!(railPreference ?? mode === 'wide'))}
            />
          ) : null}
          {openApp !== null ? (
            <ConnectedApplicationSurface application={openApp} onBack={() => setOpenApp(null)} />
          ) : null}
          {/* Hidden, not unmounted, while an app is open: the thread, scroll and draft come back as left. */}
          <div className={openApp !== null ? 'hidden' : 'contents'}>
            <div className="min-h-0 flex-1">
              <NativeChatMessageList
                session={session}
                isWorking={working}
                expandSignal={false}
                fontScale={1}
              />
            </div>
            {live.status !== null ? (
              <p
                role="status"
                aria-live="polite"
                data-testid="conversation-provider-status"
                className="px-4 pb-1 text-xs text-muted-foreground"
              >
                {live.status}
              </p>
            ) : null}
            {live.notice !== null ? <ConversationNotice notice={live.notice} /> : null}
            <ConversationComposer
              composerRef={composerRef}
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              working={working}
              recipient={roster.scoped?.status === 'found' ? roster.scoped.agent.name : null}
            />
          </div>
        </>
      )}
    >
      <NewAgentDialog
        open={newAgentOpen}
        projects={projects}
        defaultProjectId={resolveDefaultProjectId(activeRepoId, projects)}
        onOpenChange={setNewAgentOpen}
        onCreated={(agent) => {
          void roster.refresh()
          openAgentChat(agent.id)
        }}
      />
    </CognitiveWorkspaceLayout>
  )
}
