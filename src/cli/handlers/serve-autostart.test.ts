import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { SERVE_AUTOSTART_HANDLERS, formatServeAutostartStatus } from './serve-autostart'

const runtime = vi.hoisted(() => ({
  getServeAutostartStatus: vi.fn(),
  installServeAutostart: vi.fn(),
  removeServeAutostart: vi.fn()
}))
vi.mock('../runtime/serve-autostart', () => runtime)

function ctx(json: boolean): HandlerContext {
  return { flags: new Map(), cwd: 'C:\\', json } as unknown as HandlerContext
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('serve autostart handlers', () => {
  it('prints the status record under --json', async () => {
    runtime.getServeAutostartStatus.mockResolvedValue({ installed: false, taskName: 'Orca X' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await SERVE_AUTOSTART_HANDLERS['serve autostart status'](ctx(true))
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      ok: true,
      result: { installed: false, taskName: 'Orca X' }
    })
  })

  it('routes install and remove to the runtime operations', async () => {
    runtime.installServeAutostart.mockResolvedValue({
      installed: true,
      taskName: 'Orca X',
      command: 'C:\\Orca\\Orca.exe',
      arguments: '--serve --serve-autostart --serve-no-pairing'
    })
    runtime.removeServeAutostart.mockResolvedValue({
      removed: false,
      taskName: 'Orca X',
      reason: 'not_installed'
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await SERVE_AUTOSTART_HANDLERS['serve autostart install'](ctx(false))
    await SERVE_AUTOSTART_HANDLERS['serve autostart remove'](ctx(false))
    expect(String(log.mock.calls[0][0])).toContain(
      'Runs at logon: C:\\Orca\\Orca.exe --serve --serve-autostart --serve-no-pairing'
    )
    expect(String(log.mock.calls[1][0])).toContain('is not installed')
  })

  it('propagates a refusal instead of printing a result', async () => {
    runtime.installServeAutostart.mockRejectedValue(
      new RuntimeClientError('remote_invocation_refused', 'refused')
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      SERVE_AUTOSTART_HANDLERS['serve autostart install'](ctx(true))
    ).rejects.toMatchObject({ code: 'remote_invocation_refused' })
    expect(log).not.toHaveBeenCalled()
  })

  it('renders an unrecorded field as such rather than guessing', () => {
    expect(
      formatServeAutostartStatus({
        installed: true,
        taskName: 'Orca X',
        state: 'ready',
        lastTaskResult: null,
        lastRunTime: null,
        command: null,
        arguments: null,
        workingDirectory: null
      })
    ).toContain('Last result: not recorded')
  })
})
