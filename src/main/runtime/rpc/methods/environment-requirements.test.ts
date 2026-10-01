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
