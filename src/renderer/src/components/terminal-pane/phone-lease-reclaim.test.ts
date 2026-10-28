import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import {
  askToReclaimTerminalIfPhoneIdle,
  resetPhoneLeaseReclaimForTests
} from './phone-lease-reclaim'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: vi.fn(),
  getRemoteRuntimeTerminalHandle: vi.fn()
}))

const reclaimTerminalIfPhoneIdle = vi.fn()

describe('phone-lease-reclaim', () => {
  beforeEach(() => {
    resetPhoneLeaseReclaimForTests()
    reclaimTerminalIfPhoneIdle.mockReset()
    vi.mocked(callRuntimeRpc).mockReset()
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReset()
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReset().mockReturnValue(null)
    vi.stubGlobal('window', { api: { runtime: { reclaimTerminalIfPhoneIdle } } })
  })

  it('asks the local host through IPC and reports the reclaim', async () => {
    reclaimTerminalIfPhoneIdle.mockResolvedValue({ reclaimed: true })

    await expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined)).resolves.toBe(true)

    expect(reclaimTerminalIfPhoneIdle).toHaveBeenCalledWith('pty-1')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks a remote host through its runtime RPC', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-one')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-one')
    vi.mocked(callRuntimeRpc).mockResolvedValue({ reclaimed: true })

    await expect(askToReclaimTerminalIfPhoneIdle('remote:pty-1', undefined)).resolves.toBe(true)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-one' },
      'terminal.reclaimIfPhoneIdle',
      { terminal: 'terminal-one' },
      { timeoutMs: expect.any(Number) }
    )
    expect(reclaimTerminalIfPhoneIdle).not.toHaveBeenCalled()
  })

  it('sends one request for a burst of keystrokes', async () => {
    let answer!: (value: { reclaimed: boolean }) => void
    reclaimTerminalIfPhoneIdle.mockReturnValue(new Promise((resolve) => (answer = resolve)))

    const first = askToReclaimTerminalIfPhoneIdle('pty-1', undefined)
    expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined)).toBeNull()
    expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined)).toBeNull()
    answer({ reclaimed: true })

    await expect(first).resolves.toBe(true)
    expect(reclaimTerminalIfPhoneIdle).toHaveBeenCalledTimes(1)
  })

  it('waits out the lease the host reports before asking again', async () => {
    reclaimTerminalIfPhoneIdle.mockResolvedValue({ reclaimed: false, retryAfterMs: 60_000 })
    const now = Date.now()

    await expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined, now)).resolves.toBe(false)
    expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined, now + 59_000)).toBeNull()
    reclaimTerminalIfPhoneIdle.mockResolvedValue({ reclaimed: true })
    await expect(askToReclaimTerminalIfPhoneIdle('pty-1', undefined, now + 61_000)).resolves.toBe(
      true
    )
    expect(reclaimTerminalIfPhoneIdle).toHaveBeenCalledTimes(2)
  })

  it('treats an unknown method or a failed transport as not reclaimed and backs off', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-one')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-old-host')
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('method_not_found'))

    await expect(askToReclaimTerminalIfPhoneIdle('remote:pty-1', undefined)).resolves.toBe(false)
    expect(askToReclaimTerminalIfPhoneIdle('remote:pty-1', undefined)).toBeNull()
  })
})
