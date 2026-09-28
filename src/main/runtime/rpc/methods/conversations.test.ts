import { describe, expect, it, vi } from 'vitest'

import type { ConversationHost } from '../../../conversation/conversation-host'
import type { RpcContext } from '../core'
import { CONVERSATION_METHODS } from './conversations'

function method(name: string) {
  const found = CONVERSATION_METHODS.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`${name} not registered`)
  }
  return found as unknown as {
    params: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } | null
    handler: (params: unknown, ctx: RpcContext, emit?: (value: unknown) => void) => Promise<unknown>
  }
}

function hostStub(): ConversationHost & { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn()
  return {
    readWorkspace: vi.fn(async () => ({ agents: [], threads: [] })),
    read: vi.fn(async () => ({ outcome: 'absent' }) as never),
    agentGrounding: vi.fn(async () => ({ outcome: 'agent-missing' }) as never),
    createForAgent: vi.fn(async () => ({ outcome: 'agent-missing' }) as never),
    sendTurn: vi.fn(async () => ({ outcome: 'completed' }) as never),
    subscribeTurnEvents: vi.fn(() => stop),
    stop
  }
}

function ctx(host: ConversationHost | null): RpcContext {
  return {
    runtime: {
      getConversationHost: () => host,
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn(),
      cleanupSubscriptionsByPrefix: vi.fn()
    } as unknown as RpcContext['runtime'],
    connectionId: 'conn-1',
    clientKind: 'mobile'
  }
}

const NAMES = [
  'conversations.workspace',
  'conversations.read',
  'conversations.agentGrounding',
  'conversations.createForAgent',
  'conversations.sendTurn',
  'conversations.subscribe',
  'conversations.unsubscribe'
]

describe('conversations.* runtime methods', () => {
  it('registers exactly the Workspace method set', () => {
    expect(CONVERSATION_METHODS.map((entry) => entry.name).sort()).toEqual([...NAMES].sort())
  })

  it('answers capability_unsupported on a host that has not wired conversations (fails closed)', async () => {
    const args: Record<string, unknown> = {
      'conversations.workspace': undefined,
      'conversations.read': { id: 'conv_1' },
      'conversations.agentGrounding': { agentId: 'agent_a' },
      'conversations.createForAgent': { agentId: 'agent_a' },
      'conversations.sendTurn': { id: 'conv_1', text: 'hi' },
      'conversations.subscribe': { conversationId: 'conv_1' }
    }
    for (const [name, params] of Object.entries(args)) {
      await expect(
        method(name).handler(params, ctx(null), () => {}),
        name
      ).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
    }
  })

  it('delegates to the host, and a turn carries no caller-chosen cwd', async () => {
    const host = hostStub()
    const parsed = method('conversations.sendTurn').params!.safeParse({
      id: 'conv_1',
      text: '  hello  ',
      cwd: '/etc'
    })
    expect(parsed.success).toBe(true)
    // The schema strips cwd; the handler forwards only id and text.
    await method('conversations.sendTurn').handler(parsed.data, ctx(host))
    expect(host.sendTurn).toHaveBeenCalledWith({ id: 'conv_1', text: 'hello' })

    await method('conversations.workspace').handler(undefined, ctx(host))
    expect(host.readWorkspace).toHaveBeenCalledTimes(1)
  })

  it('refuses a value that is not an Orca id before any handler runs', () => {
    expect(method('conversations.read').params!.safeParse({ id: '../etc/passwd' }).success).toBe(
      false
    )
    expect(method('conversations.agentGrounding').params!.safeParse({ agentId: 'x' }).success).toBe(
      false
    )
    expect(
      method('conversations.sendTurn').params!.safeParse({ id: 'conv_1', text: '   ' }).success
    ).toBe(false)
    // Control: well-formed ids pass.
    expect(method('conversations.read').params!.safeParse({ id: 'conv_1' }).success).toBe(true)
  })

  it('streams ready then the conversation events, and cleans up with an end frame', async () => {
    const host = hostStub()
    const context = ctx(host)
    const frames: unknown[] = []

    await method('conversations.subscribe').handler(
      { conversationId: 'conv_1' },
      context,
      (frame) => frames.push(frame)
    )

    expect(frames).toEqual([{ type: 'ready', conversationId: 'conv_1' }])
    const listener = (host.subscribeTurnEvents as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (
      event: unknown
    ) => void
    listener({ type: 'turn-started' })
    expect(frames.at(-1)).toEqual({
      type: 'event',
      conversationId: 'conv_1',
      event: { type: 'turn-started' }
    })

    const register = context.runtime.registerSubscriptionCleanup as unknown as ReturnType<
      typeof vi.fn
    >
    const [subscriptionId, cleanup, connectionId] = register.mock.calls[0]!
    expect(subscriptionId).toBe('conversations:conn-1:conv_1')
    expect(connectionId).toBe('conn-1')
    ;(cleanup as () => void)()
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(frames.at(-1)).toEqual({ type: 'end' })
  })
})

describe('mobile aperture', () => {
  it('allowlists every conversations method for mobile-scope devices', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile('src/main/runtime/runtime-rpc.ts', 'utf8')
    for (const name of NAMES) {
      expect(source, name).toContain(`'${name}',`)
    }
  })
})
