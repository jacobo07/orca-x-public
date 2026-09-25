import { z } from 'zod'

import { isAgentId } from '../../../../shared/agent-identity'
import { isConversationId } from '../../../../shared/conversation-identity'
import { CONVERSATIONS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { ConversationHost } from '../../../conversation/conversation-host'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'

// Durable-agent conversations for paired clients (Workspace on the phone). The desktop renderer
// reaches the same handlers over IPC; these methods reach them through the runtime, so both go
// through one ConversationService and one turn admission. Advertised as `conversations.v1` only
// when the host has wired that service; without it every method answers capability_unsupported.

const ConversationIdParam = z.string().refine(isConversationId, 'Not a conversation id')
const AgentIdParam = z.string().refine(isAgentId, 'Not an agent id')

const ReadParams = z.object({ id: ConversationIdParam })
const GroundingParams = z.object({ agentId: AgentIdParam })
const CreateForAgentParams = z.object({
  agentId: AgentIdParam,
  title: z.string().max(200).nullable().optional()
})
// No `cwd`: where a turn runs is the agent's project's decision, never a remote caller's. Unknown
// keys are stripped, so a client that sends one gets exactly the agent-grounded turn.
const SendTurnParams = z.object({
  id: ConversationIdParam,
  text: z.string().trim().min(1, 'A turn needs text').max(100_000)
})
const SubscribeParams = z.object({
  conversationId: ConversationIdParam,
  subscriptionId: z.string().min(1).max(200).optional()
})
const UnsubscribeParams = z.object({ subscriptionId: z.string().min(1).max(200).optional() })

function requireHost(runtime: RpcContext['runtime']): ConversationHost {
  const host = runtime.getConversationHost()
  if (!host) {
    throw Object.assign(new Error(`This host does not serve ${CONVERSATIONS_RUNTIME_CAPABILITY}`), {
      code: 'capability_unsupported'
    })
  }
  return host
}

export const CONVERSATION_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'conversations.workspace',
    params: null,
    handler: async (_params, { runtime }) => requireHost(runtime).readWorkspace()
  }),
  defineMethod({
    name: 'conversations.read',
    params: ReadParams,
    handler: async (params, { runtime }) => requireHost(runtime).read(params.id)
  }),
  defineMethod({
    name: 'conversations.agentGrounding',
    params: GroundingParams,
    handler: async (params, { runtime }) => requireHost(runtime).agentGrounding(params.agentId)
  }),
  defineMethod({
    name: 'conversations.createForAgent',
    params: CreateForAgentParams,
    handler: async (params, { runtime }) =>
      requireHost(runtime).createForAgent({ agentId: params.agentId, title: params.title ?? null })
  }),
  defineMethod({
    name: 'conversations.sendTurn',
    params: SendTurnParams,
    handler: async (params, { runtime }) =>
      requireHost(runtime).sendTurn({ id: params.id, text: params.text })
  }),
  defineStreamingMethod({
    name: 'conversations.subscribe',
    params: SubscribeParams,
    handler: async (params, { runtime, connectionId, signal }, emit) => {
      const host = requireHost(runtime)
      if (signal?.aborted) {
        return
      }
      const subscriptionId = `conversations:${connectionId ?? 'local'}:${
        params.subscriptionId ?? params.conversationId
      }`
      let closed = false
      let unsubscribe = (): void => {}
      const cleanup = (): void => {
        if (closed) {
          return
        }
        closed = true
        signal?.removeEventListener('abort', handleAbort)
        unsubscribe()
        emit({ type: 'end' })
      }
      function handleAbort(): void {
        runtime.cleanupSubscription(subscriptionId)
      }
      signal?.addEventListener('abort', handleAbort, { once: true })
      runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
      if (signal?.aborted) {
        runtime.cleanupSubscription(subscriptionId)
        return
      }
      unsubscribe = host.subscribeTurnEvents(params.conversationId, (event) => {
        if (!closed) {
          emit({ type: 'event', conversationId: params.conversationId, event })
        }
      })
      // The first frame says the stream is live, so a client never waits on a quiet turn.
      emit({ type: 'ready', conversationId: params.conversationId })
    }
  }),
  defineMethod({
    name: 'conversations.unsubscribe',
    params: UnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      const connection = connectionId ?? 'local'
      if (params.subscriptionId) {
        runtime.cleanupSubscription(`conversations:${connection}:${params.subscriptionId}`)
      } else {
        runtime.cleanupSubscriptionsByPrefix(`conversations:${connection}:`)
      }
      return { unsubscribed: true }
    }
  })
]
