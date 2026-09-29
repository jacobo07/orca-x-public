// Tracer proof: a capture over the real RpcDispatcher (default method list, so registration in
// index.ts is exercised) publishes a file that a fresh runtime reads back over RPC.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isBacklogItemId } from '../../../../shared/backlog-identity'
import { createBacklogHost } from '../../../backlog/backlog-host'
import { BacklogService } from '../../../backlog/backlog-service'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function dispatcherOn(root: string): RpcDispatcher {
  const runtime = new OrcaRuntimeService()
  runtime.setBacklogHost(createBacklogHost(new BacklogService(() => root)))
  return new RpcDispatcher({ runtime })
}

async function resultOf(dispatcher: RpcDispatcher, method: string, params: unknown) {
  const response = await dispatcher.dispatch(request(method, params))
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.message}`)
  }
  return response.result as { outcome: string; record?: Record<string, unknown> & { id: string } }
}

describe('backlog runtime RPC round trip', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-backlog-rpc-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('captures over RPC and a fresh runtime reads the same record back', async () => {
    const captured = await resultOf(dispatcherOn(root), 'backlog.capture', {
      text: 'Ship the intent ledger',
      kind: 'engineering',
      revision: 99,
      id: 'bli_forged',
      events: []
    })

    expect(captured.outcome).toBe('published')
    const record = captured.record!
    expect(isBacklogItemId(record.id)).toBe(true)
    expect(record.id).not.toBe('bli_forged')
    expect(record.revision).toBe(1)
    expect(record.projectRefs).toEqual([])
    expect((record.events as { type: string }[]).map((event) => event.type)).toEqual(['created'])
    expect(existsSync(join(root, 'items', `${record.id}.json`))).toBe(true)

    const loaded = await resultOf(dispatcherOn(root), 'backlog.get', { id: record.id })
    expect(loaded).toEqual({ outcome: 'loaded', record })
  })

  it('answers absent for a well-formed id that was never captured', async () => {
    const loaded = await resultOf(dispatcherOn(root), 'backlog.get', {
      id: 'bli_00000000-0000-4000-8000-000000000000'
    })
    expect(loaded).toEqual({ outcome: 'absent' })
  })
})
