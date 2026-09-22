import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ConversationSummary } from '../../../../shared/conversation-summary'
import type { ConversationRecord } from '../../../../shared/conversation-types'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'

import { AgentChatHeader } from './AgentChatHeader'
import { conversationsInScope, latestConversationForAgent } from './agent-chat-scope'
import { ConversationList } from './ConversationList'
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
import { useScopedAgent } from './use-scoped-agent'

/**
 * Brainstorming AND Direct Agent Chat: a durable Orca conversation with no terminal anywhere.
 *
 * One surface, two scopes. `conversationAgentScope` null is Brainstorming; an agent id is a chat
 * with that agent — same list, same stream, same composer, same main-process owner. The only
 * differences are which conversations are listed, which create is called on first send, and a
 * header saying who you are talking to. An agent-shaped copy of this page would be a second chat
 * stack that drifts from the first.
 *
 * "New chat" makes a DRAFT, not a record. The record is minted and the user's message is made
 * durable on the first send, before the provider is asked anything — which keeps empty
 * conversations from piling up every time someone clicks the button or browses an agent, and keeps
 * a typed sentence from being the one thing with no record of having existed.
 *
 * There is no Stop control. `turn/interrupt` exists on the wire and Orca has no call site for it,
 * so the button would do nothing; the gap is named rather than mimed.
 *
 * The composer's hint is rendered as visible text bound by aria-describedby rather than as an
 * input attribute, because that kind of hint disappears exactly when someone starts typing and is
 * skipped by several screen readers.
 */
export default function ConversationsPage(): React.JSX.Element {
  const agentScope = useAppStore((s) => s.conversationAgentScope)
  const openAgentsPage = useAppStore((s) => s.openAgentsPage)
  const scopedAgent = useScopedAgent(agentScope)
  const [summaries, setSummaries] = useState<readonly ConversationSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftActive, setDraftActive] = useState(true)
  const [record, setRecord] = useState<ConversationRecord | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [live, setLive] = useState<ConversationLiveState>(EMPTY_CONVERSATION_LIVE_STATE)
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const openLatestPendingRef = useRef(false)
  activeIdRef.current = activeId

  const refreshList = useCallback(async () => {
    const rows = await window.api.conversations.list()
    setSummaries(rows)
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
    // Each non-loaded outcome keeps its own words: "corrupt" and "not here" are different things
    // to tell someone, and neither may render as an empty conversation.
    setReadError(
      result.outcome === 'unreadable'
        ? result.reason
        : result.outcome === 'schema-too-new'
          ? `schema version ${result.storedVersion}`
          : 'absent'
    )
  }, [])

  // Entering a scope starts from a clean draft and a fresh list, then opens the agent's latest
  // conversation once that list has arrived — never from the previous scope's rows.
  useEffect(() => {
    setDraftActive(true)
    setActiveId(null)
    setLive(EMPTY_CONVERSATION_LIVE_STATE)
    setDraft('')
    setListLoading(true)
    openLatestPendingRef.current = agentScope !== null
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
    // One subscription for the surface, not one per conversation: the payload names which
    // conversation it belongs to, and a per-row listener would scale with history.
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
    if (!openLatestPendingRef.current || agentScope === null || listLoading) {
      return
    }
    openLatestPendingRef.current = false
    const latest = latestConversationForAgent(summaries, agentScope)
    if (latest !== null) {
      openConversation(latest)
    }
  }, [agentScope, listLoading, summaries, openConversation])

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
          // Nothing was minted; the draft is left in the composer rather than thrown away.
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
    // Re-read rather than patching in place: the record on disk is the truth, and a locally
    // assembled history would drift from it the first time a write was refused.
    await loadRecord(conversationId)
    await refreshList()
    composerRef.current?.focus()
  }, [activeId, agentScope, draft, live.turnState, loadRecord, refreshList])

  const visibleSummaries = useMemo(
    () => conversationsInScope(summaries, agentScope),
    [summaries, agentScope]
  )

  const session = useMemo(
    () => conversationToNativeChatSession({ record, live, loading: recordLoading, readError }),
    [record, live, recordLoading, readError]
  )

  const working = live.turnState === 'working'

  return (
    <div
      className="flex h-full min-h-0 w-full"
      data-testid="conversations-page"
      data-conversation-scope={agentScope === null ? 'brainstorming' : 'agent'}
    >
      <ConversationList
        summaries={visibleSummaries}
        activeId={activeId}
        draftActive={draftActive}
        loading={listLoading}
        onSelect={openConversation}
        onNewChat={startDraft}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {scopedAgent !== null ? (
          <AgentChatHeader lookup={scopedAgent} onBack={openAgentsPage} />
        ) : null}

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

        <form
          className="border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <label className="sr-only" htmlFor="conversation-composer">
            {translate('conversations.composerLabel', 'Message')}
          </label>
          <p id="conversation-composer-hint" className="mb-1 text-xs text-muted-foreground">
            {translate('conversations.composerHint', 'Enter sends. Shift+Enter starts a new line.')}
          </p>
          <Textarea
            id="conversation-composer"
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby="conversation-composer-hint"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={3}
            data-testid="conversation-composer"
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="submit"
              disabled={working || draft.trim().length === 0}
              data-testid="conversation-send"
            >
              {working
                ? translate('conversations.sending', 'Working…')
                : translate('conversations.send', 'Send')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
