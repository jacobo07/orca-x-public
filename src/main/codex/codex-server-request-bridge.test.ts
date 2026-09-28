import { describe, expect, it, vi } from 'vitest'

import {
  createAgentApprovalAuthority,
  type AgentApprovalRequest
} from '../../shared/agent-approval-authority'
import { createCodexServerRequestBridge } from './codex-server-request-bridge'
import {
  CODEX_SCHEMA_SERVER_REQUESTS,
  classifyCodexServerRequest
} from './codex-server-request-classification'

function bridgeWith(
  decider?: (request: AgentApprovalRequest) => Promise<{ decision: 'approved' | 'denied' } & Record<string, unknown>>
) {
  const observed: unknown[] = []
  const bridge = createCodexServerRequestBridge({
    authority: createAgentApprovalAuthority(
      decider as Parameters<typeof createAgentApprovalAuthority>[0]
    ),
    mintApprovalId: () => 'appr_fixed',
    observe: (observation) => observed.push(observation)
  })
  return { bridge, observed }
}

describe('codex server request bridge', () => {
  it('refuses every approval when no authority can decide', async () => {
    // The W2 state: nothing in the product can present a request to a user yet, so every one of
    // these must be declined rather than waved through.
    const { bridge } = bridgeWith()

    const outcome = await bridge.handle({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf /' }
    })

    expect(outcome).toEqual({ outcome: 'result', result: { decision: 'decline' } })
  })

  it('CONTROL: an authority that approves is rendered as an acceptance', async () => {
    // Without this, a bridge hardcoded to decline would satisfy every refusal case above.
    const { bridge } = bridgeWith(async () => ({ decision: 'approved', decidedBy: 'user' }))

    const outcome = await bridge.handle({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' }
    })

    expect(outcome).toEqual({ outcome: 'result', result: { decision: 'accept' } })
  })

  it('speaks the legacy vocabulary on the legacy method', async () => {
    // `decline` is not a word execCommandApproval understands; it answers in ReviewDecision.
    const { bridge } = bridgeWith()

    await expect(bridge.handle({ id: 2, method: 'execCommandApproval', params: {} })).resolves.toEqual(
      { outcome: 'result', result: { decision: 'denied' } }
    )
  })

  it('refuses a tool CALL rather than answering it', async () => {
    // item/tool/call asks the client to execute something. A result here is an execution.
    const { bridge, observed } = bridgeWith(async () => ({ decision: 'approved', decidedBy: 'user' }))

    const outcome = await bridge.handle({ id: 3, method: 'item/tool/call', params: { name: 'bash' } })

    expect(outcome).toMatchObject({ outcome: 'error', code: -32601 })
    expect(observed).toContainEqual({
      event: 'refused',
      method: 'item/tool/call',
      reason: 'orca does not implement item/tool/call'
    })
  })

  it('refuses a method the installed schema never declared', async () => {
    const { bridge } = bridgeWith(async () => ({ decision: 'approved', decidedBy: 'user' }))

    await expect(
      bridge.handle({ id: 4, method: 'item/somethingNew/requestApproval', params: {} })
    ).resolves.toMatchObject({ outcome: 'error', code: -32601 })
  })

  it('refuses the two methods whose wire has no way to say yes or no', async () => {
    // permissions answers with a granted profile and requestUserInput with answers. Approving
    // either would mean inventing a grant nobody chose.
    const { bridge } = bridgeWith(async () => ({ decision: 'approved', decidedBy: 'user' }))

    for (const method of ['item/permissions/requestApproval', 'item/tool/requestUserInput']) {
      const outcome = await bridge.handle({ id: 5, method, params: {} })
      expect(outcome, method).toMatchObject({ outcome: 'error' })
    }
  })

  it('denies when the decider throws, and records that nobody decided', async () => {
    const { bridge, observed } = bridgeWith(async () => {
      throw new Error('surface gone')
    })

    await expect(
      bridge.handle({ id: 6, method: 'item/fileChange/requestApproval', params: {} })
    ).resolves.toEqual({ outcome: 'result', result: { decision: 'decline' } })
    expect(observed).toContainEqual(
      expect.objectContaining({ event: 'approval-resolved', approved: false })
    )
  })

  it('never lets an observer failure change the answer', async () => {
    const bridge = createCodexServerRequestBridge({
      authority: createAgentApprovalAuthority(),
      mintApprovalId: () => 'appr_fixed',
      observe: () => {
        throw new Error('observer exploded')
      }
    })

    await expect(
      bridge.handle({ id: 7, method: 'item/fileChange/requestApproval', params: {} })
    ).resolves.toEqual({ outcome: 'result', result: { decision: 'decline' } })
  })

  it('classifies every request the frozen schema inventory names', async () => {
    // A floor on the population: an inventory that silently emptied would satisfy a loop over it.
    expect(CODEX_SCHEMA_SERVER_REQUESTS.length).toBe(11)
    for (const method of CODEX_SCHEMA_SERVER_REQUESTS) {
      expect(classifyCodexServerRequest(method).handling, method).not.toBe('unknown')
    }
  })

  it('reports the approval before it is decided, not only after', async () => {
    const order: string[] = []
    const bridge = createCodexServerRequestBridge({
      authority: createAgentApprovalAuthority(async () => {
        order.push('decided')
        return { decision: 'denied', decidedBy: 'user', reason: 'no' }
      }),
      mintApprovalId: () => 'appr_fixed',
      observe: (observation) => order.push(observation.event)
    })

    await bridge.handle({ id: 8, method: 'item/commandExecution/requestApproval', params: {} })

    expect(order).toEqual(['approval-requested', 'decided', 'approval-resolved'])
  })
})

describe('codex server request inventory', () => {
  it('matches the installed binary, when one is present', async () => {
    // Governs the APERTURE: a Codex release adding a twelfth server request must be a visible
    // decision, not a silent arrival in the unknown branch. Skipped rather than failed where no
    // schema has been generated, so CI without Codex does not report a drift it cannot see.
    const { existsSync, readFileSync } = await import('node:fs')
    const schemaPath = process.env.CODEX_SERVER_REQUEST_SCHEMA
    if (!schemaPath || !existsSync(schemaPath)) {
      vi.stubEnv('CODEX_SCHEMA_DRIFT_CHECK', 'skipped')
      return
    }
    const parsed = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      oneOf?: { properties?: { method?: { enum?: string[] } } }[]
    }
    const live = (parsed.oneOf ?? [])
      .map((variant) => variant.properties?.method?.enum?.[0])
      .filter((name): name is string => Boolean(name))

    expect(live.length).toBeGreaterThan(0)
    expect([...live].sort()).toEqual([...CODEX_SCHEMA_SERVER_REQUESTS].sort())
  })
})
