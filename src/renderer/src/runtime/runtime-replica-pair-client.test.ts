import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../web/web-preload-api-test-harness'

describe('web preload replicaPair block', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../web/web-runtime-client')
  })

  it('answers refused/remote-caller without sending any runtime request', async () => {
    const send = vi.fn(async (method: string) => ({
      id: method,
      ok: true,
      result: { measurement: 'x' },
      _meta: { runtimeId: 'runtime-1' }
    }))
    vi.doMock('../web/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = send
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('../web/web-preload-api')
    installWebPreloadApi()
    const refused = { status: 'refused', reason: 'remote-caller' }

    await expect(globals.window.api.replicaPair.compare({ projectId: 'p1' })).resolves.toEqual(
      refused
    )
    await expect(globals.window.api.replicaPair.relations()).resolves.toEqual(refused)
    expect(send).not.toHaveBeenCalled()

    // Control: a sibling web method does reach the recorded client, so the spy can observe a request.
    await globals.window.api.environment.measureRequirements({ repoId: 'r1' })
    expect(send).toHaveBeenCalledWith(
      'environment.measureRequirements',
      expect.anything(),
      expect.anything()
    )
  })
})
