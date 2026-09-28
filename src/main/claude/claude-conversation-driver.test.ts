import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { ConversationService } from '../conversation/conversation-service'
import { runConversationTurn, type ProviderTurnRequest } from '../conversation/conversation-turn-runner'
import {
  buildClaudeTurnArgs,
  createClaudeConversationDriver,
  type ClaudeProcess,
  type SpawnClaudeProcess
} from './claude-conversation-driver'
import type { ClaudeQuotaObservation } from './claude-stream-mapping'

// Trimmed from a REAL capture: Claude Code 2.1.281, `claude -p "Reply with exactly: ok"
// --output-format stream-json --verbose --setting-sources project --permission-mode plan`,
// 2026-09-24. Only fields the driver reads are kept; values are as observed.
const CAPTURED_OK = [
  '{"type":"system","subtype":"init","session_id":"3eea3814-1c89-44fb-a846-765f364826a1","model":"claude-opus-5-5[1m]","permissionMode":"plan"}',
  '{"type":"assistant","message":{"id":"msg_probe","role":"assistant","content":[{"type":"text","text":"ok"}]},"session_id":"3eea3814-1c89-44fb-a846-765f364826a1"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790532000,"rateLimitType":"seven_day","utilization":0.99},"session_id":"3eea3814-1c89-44fb-a846-765f364826a1"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"3eea3814-1c89-44fb-a846-765f364826a1","total_cost_usd":0.9265016}'
]

function fakeSpawn(
  lines: string[],
  options: { exitCode?: number; stderr?: string; hang?: boolean } = {}
): { spawn: SpawnClaudeProcess; calls: { command: string; args: string[]; cwd: string }[]; killed: () => boolean } {
  const calls: { command: string; args: string[]; cwd: string }[] = []
  let killed = false
  const spawn: SpawnClaudeProcess = (command, args, cwd) => {
    calls.push({ command, args, cwd })
    let release: () => void = () => {}
    const stopped = new Promise<void>((resolve) => (release = resolve))
    const process: ClaudeProcess = {
      pid: 4242,
      lines: (async function* () {
        yield* lines
        if (options.hang) {
          await stopped
        }
      })(),
      stderrTail: () => options.stderr ?? '',
      exited: (async () => {
        if (options.hang) {
          await stopped
        }
        return options.exitCode ?? 0
      })(),
      kill: async () => {
        killed = true
        release()
      }
    }
    return process
  }
  return { spawn, calls, killed: () => killed }
}

function request(overrides: Partial<ProviderTurnRequest> = {}): {
  request: ProviderTurnRequest
  events: AgentTurnEvent[]
} {
  const events: AgentTurnEvent[] = []
  return {
    events,
    request: {
      resumeSessionId: null,
      cwd: '/work/api',
      text: 'Reply with exactly: ok',
      developerInstructions: null,
      turnId: 'turn-1',
      onEvent: (event) => events.push(event),
      ...overrides
    }
  }
}

describe('claude conversation driver', () => {
  it('maps the captured stream into the neutral turn and reports the session and quota', async () => {
    const { spawn, calls } = fakeSpawn(CAPTURED_OK)
    const quotas: ClaudeQuotaObservation[] = []
    const driver = createClaudeConversationDriver({ spawnProcess: spawn, observeQuota: (q) => quotas.push(q) })
    const { request: turn, events } = request()

    const result = await driver.runTurn(turn)

    expect(driver.provider).toBe('claude')
    expect(calls[0]).toMatchObject({ command: 'claude', cwd: '/work/api' })
    expect(result.providerSessionId).toBe('3eea3814-1c89-44fb-a846-765f364826a1')
    expect(events).toEqual([
      { kind: 'turn-started', turnId: 'turn-1' },
      {
        kind: 'message-completed',
        turnId: 'turn-1',
        itemId: 'msg_probe',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }]
      },
      { kind: 'provider-status', status: 'quota-allowed_warning', detail: 'seven_day' },
      { kind: 'turn-completed', turnId: 'turn-1' }
    ])
    expect(quotas).toEqual([
      { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.99, resetsAtMs: 1790532000000 }
    ])
  })

  it('runs read-only, without the user’s global settings, layering the role and resuming its own session', () => {
    const { request: turn } = request({ developerInstructions: 'You review code.', resumeSessionId: 'sess-7' })

    const args = buildClaudeTurnArgs(turn)

    expect(args.slice(0, 2)).toEqual(['-p', 'Reply with exactly: ok'])
    expect(args).toEqual(
      expect.arrayContaining(['--setting-sources', 'project', '--permission-mode', 'plan'])
    )
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You review code.')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-7')
    expect(buildClaudeTurnArgs(request().request)).not.toContain('--resume')
    expect(buildClaudeTurnArgs(request().request)).not.toContain('--append-system-prompt')
  })

  it('ends the turn as failed when Claude reports an error result', async () => {
    const { spawn } = fakeSpawn([
      CAPTURED_OK[0],
      '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached","session_id":"s"}'
    ])
    const { request: turn, events } = request()

    await createClaudeConversationDriver({ spawnProcess: spawn }).runTurn(turn)

    expect(events.at(-1)).toEqual({
      kind: 'turn-ended',
      turnId: 'turn-1',
      state: 'failed',
      reason: 'Claude AI usage limit reached'
    })
  })

  it('names why a process that exited without a result did not finish', async () => {
    const { spawn } = fakeSpawn([CAPTURED_OK[0]], { exitCode: 1, stderr: 'Invalid API key' })
    const { request: turn, events } = request()

    await createClaudeConversationDriver({ spawnProcess: spawn }).runTurn(turn)

    expect(events.at(-1)).toEqual({
      kind: 'turn-ended',
      turnId: 'turn-1',
      state: 'failed',
      reason: 'claude exited 1 without a result: Invalid API key'
    })
  })

  it('stops a hung process at its deadline and says so', async () => {
    const { spawn, killed } = fakeSpawn([CAPTURED_OK[0]], { hang: true })
    const { request: turn, events } = request()

    await createClaudeConversationDriver({ spawnProcess: spawn, timeoutMs: 20 }).runTurn(turn)

    expect(killed()).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'turn-ended', reason: 'claude did not finish within 20 ms and was stopped' })
  })

  // Inverted by the MCP bridge: offered tools are served to Claude for the turn, and only then.
  it('serves offered tools over MCP for exactly the turn, pre-allowing only those tools', async () => {
    const invoked: unknown[] = []
    let url = ''
    let listed: unknown = null
    let called: unknown = null
    const spawn: SpawnClaudeProcess = (_command, args) => {
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
        mcpServers: { orca: { url: string; headers: { Authorization: string } } }
      }
      url = config.mcpServers.orca.url
      const headers = { 'content-type': 'application/json', authorization: config.mcpServers.orca.headers.Authorization }
      const rpc = async (method: string, params: unknown) =>
        (await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as {
          result: unknown
        }
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__orca__orca_delegate')
      return {
        pid: 1,
        lines: (async function* () {
          listed = (await rpc('tools/list', {})).result
          called = (await rpc('tools/call', { name: 'orca_delegate', arguments: { agent: 'b', task: 't' } })).result
          yield* CAPTURED_OK
        })(),
        stderrTail: () => '',
        exited: Promise.resolve(0),
        kill: async () => {}
      }
    }
    const { request: turn } = request({
      tools: [
        {
          name: 'orca_delegate',
          description: 'delegate',
          inputSchema: { type: 'object' },
          invoke: async (args) => {
            invoked.push(args)
            return { success: true, text: 'Delegated as task_9' }
          }
        }
      ]
    })

    await createClaudeConversationDriver({ spawnProcess: spawn }).runTurn(turn)

    expect(listed).toEqual({ tools: [{ name: 'orca_delegate', description: 'delegate', inputSchema: { type: 'object' } }] })
    expect(called).toEqual({ content: [{ type: 'text', text: 'Delegated as task_9' }], isError: false })
    expect(invoked).toEqual([{ agent: 'b', task: 't' }])
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('keeps every MCP server the user configured out of a turn, and adds none when no tool is offered', () => {
    const args = buildClaudeTurnArgs(request().request)

    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
  })

  it('gives a turn with Orca tools only the read tools, since plan mode refuses the served tool', () => {
    const args = buildClaudeTurnArgs(request().request, { config: '{}', toolNames: ['orca_delegate'] })

    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__orca__orca_delegate')
    expect(args).not.toContain('plan')
  })
})

describe('claude conversation driver through the turn runner', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-claude-driver-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('persists the reply and records the session under provider claude', async () => {
    const service = new ConversationService(() => join(root, 'conversations'))
    const conversation = await service.create({})
    const { spawn } = fakeSpawn(CAPTURED_OK)

    const outcome = await runConversationTurn(
      {
        service,
        driver: createClaudeConversationDriver({ spawnProcess: spawn }),
        resolveProjectLocation: () => ({ outcome: 'no-project' }),
        fallbackCwd: () => root,
        checkAuth: async () => ({ ready: true }),
        mintTurnId: () => 'turn-1',
        mintItemId: () => 'item-1',
        emit: () => {}
      },
      { conversationId: conversation.id, text: 'Reply with exactly: ok', cwd: null }
    )

    expect(outcome).toMatchObject({ outcome: 'completed', turnId: 'turn-1' })
    const loaded = await service.read(conversation.id)
    if (loaded.outcome !== 'loaded') {
      throw new Error(loaded.outcome)
    }
    expect(loaded.record.messages.at(-1)).toMatchObject({ role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] })
    expect(loaded.record.provenance).toEqual([
      expect.objectContaining({ agent: 'claude', providerSessionId: '3eea3814-1c89-44fb-a846-765f364826a1' })
    ])
  })
})
