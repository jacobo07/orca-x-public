import { describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { DesktopRelayService, DesktopRelayServiceOptions } from './desktop-relay-service'
import { createHostRelayOwner, type HostRelayStartDeps } from './host-relay-startup'

function makeFakeService() {
  return {
    start: vi.fn(),
    ensureLive: vi.fn(),
    createPairingRelay: vi.fn(async () => ({ relay: 'relay', binding: 'binding' })),
    onDeviceRevokeQueued: vi.fn(),
    demandStateChanged: vi.fn(),
    getEndpoints: vi.fn(async () => ({ endpoints: [] })),
    provisionRelay: vi.fn(async () => ({ installed: true }))
  }
}

function makeDeps(overrides: Partial<HostRelayStartDeps> = {}) {
  const setMobileRelayPairingProvider = vi.fn()
  const runtimeRpc = { setMobileRelayPairingProvider } as unknown as OrcaRuntimeRpcServer
  const deps: HostRelayStartDeps = {
    cloudAuth: {
      configured: true,
      config: { apiBaseUrl: 'https://cloud.test' } as OrcaCloudAuthConfig
    },
    userDataPath: '/profile',
    appVersion: '9.9.9',
    runtimeRpc,
    onStatus: vi.fn(),
    onResume: vi.fn(),
    warn: vi.fn(),
    ...overrides
  }
  return { deps, setMobileRelayPairingProvider }
}

describe('createHostRelayOwner', () => {
  it('reports cloud_auth_not_configured and constructs nothing without cloud config', () => {
    const createService = vi.fn()
    const { deps } = makeDeps({
      cloudAuth: { configured: false, setupMessage: 'not configured' },
      createService
    })

    const result = createHostRelayOwner().start(deps)

    expect(result.service).toBeNull()
    expect(result.getReadiness()).toEqual({
      state: 'unavailable',
      reason: 'cloud_auth_not_configured'
    })
    expect(createService).not.toHaveBeenCalled()
    expect(deps.onResume).not.toHaveBeenCalled()
  })

  it('maps constructor failures to named reasons and never reports a status', () => {
    const notReady = makeDeps({
      createService: () => {
        throw new Error('mobile_runtime_not_ready')
      }
    })
    const other = makeDeps({
      createService: () => {
        throw new Error('boom')
      }
    })

    const notReadyResult = createHostRelayOwner().start(notReady.deps)
    const otherResult = createHostRelayOwner().start(other.deps)

    expect(notReadyResult.getReadiness()).toEqual({
      state: 'unavailable',
      reason: 'mobile_runtime_not_ready'
    })
    expect(otherResult.getReadiness()).toEqual({
      state: 'unavailable',
      reason: 'relay_startup_failed'
    })
    expect(notReady.deps.warn).toHaveBeenCalledTimes(1)
    expect(notReady.deps.warn).toHaveBeenCalledWith(
      '[relay] Host relay startup unavailable:',
      'mobile_runtime_not_ready'
    )
    expect(other.deps.warn).toHaveBeenCalledTimes(1)
    expect(notReady.setMobileRelayPairingProvider).not.toHaveBeenCalled()
    expect(notReady.deps.onResume).not.toHaveBeenCalled()
  })

  it('wires the pairing provider, starts the service and re-arms it on resume', async () => {
    const service = makeFakeService()
    const createService = vi.fn(
      (_options: DesktopRelayServiceOptions) => service as unknown as DesktopRelayService
    )
    const { deps, setMobileRelayPairingProvider } = makeDeps({ createService })

    const result = createHostRelayOwner().start(deps)

    expect(result.service).toBe(service)
    const options = createService.mock.calls[0]![0] as DesktopRelayServiceOptions
    expect(options).toMatchObject({ userDataPath: '/profile', appVersion: '9.9.9' })
    expect(options.runtimeRpc).toBe(deps.runtimeRpc)
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(setMobileRelayPairingProvider).toHaveBeenCalledTimes(1)
    const provider = setMobileRelayPairingProvider.mock.calls[0]![0]
    await provider.createPairingRelay('device-1')
    expect(service.createPairingRelay).toHaveBeenCalledWith('device-1')
    provider.onDeviceRevokeQueued('item')
    expect(service.onDeviceRevokeQueued).toHaveBeenCalledWith('item')
    provider.onDemandStateChanged()
    expect(service.demandStateChanged).toHaveBeenCalledTimes(1)
    await provider.getEndpoints('ctx', 'params')
    expect(service.getEndpoints).toHaveBeenCalledWith('ctx', 'params')
    await provider.provisionRelay('ctx', 'params')
    expect(service.provisionRelay).toHaveBeenCalledWith('ctx', 'params')

    expect(deps.onResume).toHaveBeenCalledTimes(1)
    const listener = vi.mocked(deps.onResume).mock.calls[0]![0]
    listener()
    expect(service.ensureLive).toHaveBeenCalledTimes(1)
  })

  it('reports only a status the broker emitted, null before the first emission', () => {
    const service = makeFakeService()
    const createService = vi.fn(
      (_options: DesktopRelayServiceOptions) => service as unknown as DesktopRelayService
    )
    const { deps } = makeDeps({ createService })

    const result = createHostRelayOwner().start(deps)

    expect(result.getReadiness()).toEqual({ state: 'started', status: null })
    const options = createService.mock.calls[0]![0] as DesktopRelayServiceOptions
    options.onStatus('standby')
    expect(result.getReadiness()).toEqual({ state: 'started', status: 'standby' })
    expect(deps.onStatus).toHaveBeenCalledWith('standby')
  })

  it('returns the first result on a second start and constructs nothing more', () => {
    const service = makeFakeService()
    const createService = vi.fn(
      (_options: DesktopRelayServiceOptions) => service as unknown as DesktopRelayService
    )
    const { deps } = makeDeps({ createService })
    const owner = createHostRelayOwner()

    const first = owner.start(deps)
    const second = owner.start(deps)

    expect(second).toBe(first)
    expect(createService).toHaveBeenCalledTimes(1)
    expect(deps.onResume).toHaveBeenCalledTimes(1)
  })
})
