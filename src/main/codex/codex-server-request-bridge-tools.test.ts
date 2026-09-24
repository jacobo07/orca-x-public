import { describe, expect, it } from 'vitest'
import { createAgentApprovalAuthority } from '../../shared/agent-approval-authority'
import type { ProviderTurnTool } from '../conversation/provider-turn-tool'
import { createCodexServerRequestBridge } from './codex-server-request-bridge'

function bridgeWith(tools: ProviderTurnTool[] | undefined) {
  return createCodexServerRequestBridge({
    authority: createAgentApprovalAuthority(),
    mintApprovalId: () => 'appr_test',
    ...(tools ? { tools } : {})
  })
}

function tool(invoke: ProviderTurnTool['invoke']): ProviderTurnTool {
  return { name: 'orca_delegate', description: 'd', inputSchema: { type: 'object' }, invoke }
}

const call = (name: string, args: unknown) => ({
  id: 7,
  method: 'item/tool/call',
  params: { threadId: 'th_1', turnId: 'tu_1', callId: 'c_1', tool: name, arguments: args }
})

describe('item/tool/call through the server-request bridge', () => {
  it('runs a declared tool with only the provider’s arguments and answers in Codex’s shape', async () => {
    const received: unknown[] = []
    const bridge = bridgeWith([
      tool(async (args) => {
        received.push(args)
        return { success: true, text: 'Delegated as task task_9' }
      })
    ])

    const outcome = await bridge.handle(call('orca_delegate', { agent: 'agent_b', task: 'x' }))

    expect(received).toEqual([{ agent: 'agent_b', task: 'x' }])
    expect(outcome).toEqual({
      outcome: 'result',
      result: { contentItems: [{ type: 'inputText', text: 'Delegated as task task_9' }], success: true }
    })
  })

  it('refuses a tool this turn did not declare, exactly as before tools existed', async () => {
    const declared = bridgeWith([tool(async () => ({ success: true, text: 'never' }))])
    const none = bridgeWith(undefined)

    const undeclared = await declared.handle(call('shell_exec', { cmd: 'rm -r /' }))
    const withoutTools = await none.handle(call('orca_delegate', {}))

    expect(undeclared).toMatchObject({ outcome: 'error', code: -32601 })
    expect(withoutTools).toMatchObject({ outcome: 'error', code: -32601 })
  })

  it('answers a failing tool as an unsuccessful result, not a crashed peer', async () => {
    const bridge = bridgeWith([
      tool(async () => {
        throw new Error('database is closed')
      })
    ])

    const outcome = await bridge.handle(call('orca_delegate', { agent: 'a', task: 'b' }))

    expect(outcome).toEqual({
      outcome: 'result',
      result: { contentItems: [{ type: 'inputText', text: 'database is closed' }], success: false }
    })
  })
})
