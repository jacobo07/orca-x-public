import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { normalizeServeModeArgv, readServeObserveOnlyArg } from '../startup/serve-mode-argv'
import { DeviceRegistry } from './device-registry'
import {
  formatObserveOnlyRefusalLine,
  OBSERVE_ONLY_REFUSED_CODE,
  OBSERVE_ONLY_RPC_METHOD_ALLOWLIST,
  observeOnlyMode
} from './observe-only-mode'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest, withCurrentOrchestrationContract } from './runtime-rpc-test-harness'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type Reply = Record<string, unknown>

function pairedServer(runtime: OrcaRuntimeService): {
  server: OrcaRuntimeRpcServer
  send: (message: Record<string, unknown>) => Promise<Reply>
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-observe-only-'))
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const device = server['deviceRegistry']!.addDevice('home-pc', 'runtime')
  const send = async (message: Record<string, unknown>): Promise<Reply> => {
    const replies: Reply[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify(withCurrentOrchestrationContract(message)),
      (response) => replies.push(JSON.parse(response) as Reply),
      () => {},
      undefined,
      undefined,
      device.token
    )
    return replies[0]!
  }
  return { server, send }
}

function counts(db: OrchestrationDb): Record<string, number> {
  const sqlite = db['db']
  const count = (table: string): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return {
    receipts: count('mutation_receipts'),
    attachments: count('remote_dispatch_attachments'),
    messages: count('messages')
  }
}

afterEach(() => {
  observeOnlyMode.disable()
})

describe('orca serve --observe-only', () => {
  it('refuses a paired mutation before any receipt or effect', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const { server, send } = pairedServer(runtime)
    observeOnlyMode.enable()
    try {
      db.insertMessage({ from: 'worker', to: 'coordinator', subject: 'kept' })
      const before = counts(db)

      const reset = await send({
        id: 'reset',
        method: 'orchestration.reset',
        orchestrationRequestId: 'observe-only-reset',
        params: { messages: true }
      })
      const attach = await send({
        id: 'attach',
        method: 'orchestration.federationAttachStart',
        orchestrationRequestId: 'observe-only-attach',
        params: { dispatchId: 'ctx_x', taskId: 'task_x', taskSpec: 'x', worktree: 'new-top-level' }
      })

      for (const reply of [reset, attach]) {
        expect(reply).toMatchObject({ ok: false, error: { code: OBSERVE_ONLY_REFUSED_CODE } })
      }
      expect(counts(db)).toEqual(before)
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('refuses terminal creation and git push without reaching the runtime', async () => {
    const createMobileSessionTerminal = vi.fn()
    const pushRuntimeGit = vi.fn()
    const runtime = {
      getRuntimeId: () => 'observe-only-runtime',
      createMobileSessionTerminal,
      pushRuntimeGit
    } as unknown as OrcaRuntimeService
    const { server, send } = pairedServer(runtime)
    observeOnlyMode.enable()

    const create = await send({
      id: 'create',
      method: 'session.tabs.createTerminal',
      params: { worktree: 'id:wt-1' }
    })
    const push = await send({ id: 'push', method: 'git.push', params: { worktree: 'id:wt-1' } })
    const unknown = await send({ id: 'unknown', method: 'some.futureMethod' })

    for (const reply of [create, push, unknown]) {
      expect(reply).toMatchObject({ ok: false, error: { code: OBSERVE_ONLY_REFUSED_CODE } })
    }
    expect(createMobileSessionTerminal).not.toHaveBeenCalled()
    expect(pushRuntimeGit).not.toHaveBeenCalled()
    await server.stop()
  })

  it('lets every allowlisted read through to the dispatcher', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const { server, send } = pairedServer(runtime)
    observeOnlyMode.enable()
    try {
      for (const method of OBSERVE_ONLY_RPC_METHOD_ALLOWLIST) {
        const reply = await send({ id: `read-${method}`, method, params: {} })
        // Why not ok:true for each: some reads fail on an empty runtime; what matters is that the
        // refusal did not answer them.
        expect((reply.error as { code?: string } | undefined)?.code).not.toBe(
          OBSERVE_ONLY_REFUSED_CODE
        )
      }
      const status = await send({ id: 'status', method: 'status.get' })
      expect(status).toMatchObject({ ok: true })
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('stops advertising worker federation only while observe-only', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.getStatus().capabilities).toContain(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)
    observeOnlyMode.enable()
    expect(runtime.getStatus().capabilities).not.toContain(
      ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
    )
  })

  it('leaves the local caller (this host) unaffected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-observe-only-local-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    observeOnlyMode.enable()
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const response = await sendRequest(
        metadata!.transports[0]!.endpoint,
        withCurrentOrchestrationContract({
          id: 'local-reset',
          authToken: metadata!.authToken,
          method: 'orchestration.reset',
          orchestrationRequestId: 'local-reset-request',
          params: { messages: true }
        })
      )
      expect(response).toMatchObject({ ok: true })
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('serves paired mutations normally when the flag is off', async () => {
    const pushRuntimeGit = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      getRuntimeId: () => 'normal-runtime',
      pushRuntimeGit
    } as unknown as OrcaRuntimeService
    const { server, send } = pairedServer(runtime)

    const push = await send({ id: 'push', method: 'git.push', params: { worktree: 'id:wt-1' } })

    expect(push).toMatchObject({ ok: true })
    expect(pushRuntimeGit).toHaveBeenCalledTimes(1)
    await server.stop()
  })

  it('logs the method name only, printable and bounded', () => {
    expect(formatObserveOnlyRefusalLine('git.push')).toBe(
      '[serve] observe-only refused method git.push'
    )
    const line = formatObserveOnlyRefusalLine(`x\u001b[31m${'y'.repeat(500)}`)
    expect(line).not.toContain('\u001b')
    expect(line.length).toBeLessThan(160)
  })

  it('refuses a valued flag instead of starting an open server', () => {
    expect(() => readServeObserveOnlyArg(['/AppRun', '--serve', '--observe-only=true'])).toThrow(
      'takes no value'
    )
    expect(() => readServeObserveOnlyArg(['/AppRun', '--serve', '--serve-observe-only=1'])).toThrow(
      'takes no value'
    )
    expect(readServeObserveOnlyArg(['/AppRun', '--serve', '--serve-observe-only'])).toBe(true)
    expect(readServeObserveOnlyArg(['/AppRun', '--serve'])).toBe(false)
  })

  it('translates the CLI flag for the main process', () => {
    expect(
      normalizeServeModeArgv(['/AppRun', 'serve', '--observe-only', '--port', '6768'])
    ).toEqual(['/AppRun', '--serve', '--serve-observe-only', '--serve-port', '6768'])
  })
})
