import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { ENVIRONMENT_REQUIREMENTS_METHODS } from './environment-requirements'
import type { OrcaRuntimeService } from '../../orca-runtime'

const REQUEST = { id: 'req_1', authToken: 't', method: 'environment.measureRequirements' }

function dispatcherFor(measure: ReturnType<typeof vi.fn>) {
  return new RpcDispatcher({
    runtime: {
      getRuntimeId: () => 'runtime-1',
      measureEnvironmentRequirements: measure
    } as unknown as OrcaRuntimeService
  })
}

describe('environment.measureRequirements', () => {
  it('is registered, declares no launch effect and is not on the mobile allowlist', () => {
    const registered = ALL_RPC_METHODS.filter((m) => m.name === 'environment.measureRequirements')
    expect(registered).toHaveLength(1)
    expect(ENVIRONMENT_REQUIREMENTS_METHODS[0].effect).toBeUndefined()
    const source = readFileSync(join(__dirname, '..', '..', 'runtime-rpc.ts'), 'utf8')
    const allowlist = source.match(/const MOBILE_RPC_METHOD_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
    // Station control: the allowlist was found and is populated.
    expect(allowlist?.[1]).toContain("'status.get'")
    expect(allowlist?.[1]).not.toContain('environment.measureRequirements')
  })

  it('delegates the repo selector to the runtime and returns its measurement', async () => {
    const measure = vi.fn().mockResolvedValue({ contract: 'absent' })
    const response = await dispatcherFor(measure).dispatch({
      ...REQUEST,
      params: { repo: 'id:r1' }
    })
    expect(measure).toHaveBeenCalledWith('id:r1')
    expect(response).toMatchObject({ ok: true, result: { contract: 'absent' } })
  })

  it('rejects a missing selector without measuring', async () => {
    const measure = vi.fn()
    const response = await dispatcherFor(measure).dispatch({ ...REQUEST, params: { repo: '  ' } })
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(measure).not.toHaveBeenCalled()
  })

  it('an old host without the method answers method_not_found', async () => {
    const measure = vi.fn()
    const methods = ALL_RPC_METHODS.filter((m) => m.name !== 'environment.measureRequirements')
    expect(methods.length).toBe(ALL_RPC_METHODS.length - 1)
    const response = await new RpcDispatcher({
      runtime: { getRuntimeId: () => 'r' } as unknown as OrcaRuntimeService,
      methods
    }).dispatch({ ...REQUEST, params: { repo: 'id:r1' } })
    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(measure).not.toHaveBeenCalled()
  })
})

const PREPARE_REQUEST = { id: 'req_2', authToken: 't', method: 'environment.runPrepareStep' }
const PREPARE_PARAMS = {
  repo: 'id:r1',
  requirementId: 'shim',
  approvedContentHash: 'a'.repeat(64),
  approvedHostKey: 'local@0123456789abcdef'
}

function prepareDispatcher(run: ReturnType<typeof vi.fn>) {
  return new RpcDispatcher({
    runtime: {
      getRuntimeId: () => 'runtime-1',
      runEnvironmentPrepareStep: run
    } as unknown as OrcaRuntimeService
  })
}

describe('environment.runPrepareStep', () => {
  it('is registered once, declares the launch effect and is not on the mobile allowlist', () => {
    const registered = ALL_RPC_METHODS.filter((m) => m.name === 'environment.runPrepareStep')
    expect(registered).toHaveLength(1)
    expect((registered[0] as { effect?: string }).effect).toBe('launch')
    const source = readFileSync(join(__dirname, '..', '..', 'runtime-rpc.ts'), 'utf8')
    const allowlist = source.match(/const MOBILE_RPC_METHOD_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
    expect(allowlist?.[1]).toContain("'status.get'")
    expect(allowlist?.[1]).not.toContain('environment.runPrepareStep')
  })

  it('hands the runtime a requirement id and a hash, with the runtime-rpc origin', async () => {
    const run = vi.fn().mockResolvedValue({ status: 'refused', reason: 'approval-missing' })
    const response = await prepareDispatcher(run).dispatch({
      ...PREPARE_REQUEST,
      params: PREPARE_PARAMS
    })
    expect(run).toHaveBeenCalledWith({
      repoSelector: 'id:r1',
      requirementId: 'shim',
      approvedContentHash: PREPARE_PARAMS.approvedContentHash,
      approvedHostKey: PREPARE_PARAMS.approvedHostKey,
      origin: 'runtime-rpc'
    })
    expect(response).toMatchObject({ ok: true, result: { status: 'refused' } })
  })

  it('rejects command text and malformed hashes without running anything', async () => {
    const cases = [
      { ...PREPARE_PARAMS, command: 'rm -rf /' },
      { ...PREPARE_PARAMS, approvedContentHash: 'A'.repeat(64) },
      { ...PREPARE_PARAMS, approvedContentHash: 'a'.repeat(63) },
      { ...PREPARE_PARAMS, requirementId: '' },
      { ...PREPARE_PARAMS, approvedHostKey: '' },
      { ...PREPARE_PARAMS, repo: '  ' }
    ]
    for (const params of cases) {
      const run = vi.fn()
      const response = await prepareDispatcher(run).dispatch({ ...PREPARE_REQUEST, params })
      expect(response, JSON.stringify(params)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('an old host without the method answers method_not_found', async () => {
    const run = vi.fn()
    const methods = ALL_RPC_METHODS.filter((m) => m.name !== 'environment.runPrepareStep')
    expect(methods.length).toBe(ALL_RPC_METHODS.length - 1)
    const response = await new RpcDispatcher({
      runtime: { getRuntimeId: () => 'r' } as unknown as OrcaRuntimeService,
      methods
    }).dispatch({ ...PREPARE_REQUEST, params: PREPARE_PARAMS })
    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(run).not.toHaveBeenCalled()
  })
})
