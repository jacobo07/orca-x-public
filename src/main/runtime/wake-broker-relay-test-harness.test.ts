import * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type * as WakeBrokerHostModule from './wake-broker-host'
import { startWakeBroker, wakeBrokerHost } from './wake-broker-host'
import { startRelayWakeHarness } from './wake-broker-relay-test-harness'

const seen = vi.hoisted(() => ({ brokerEnabledAtThrow: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) }
})

// Why doctored, not stubbed: the real broker enables first, so setup throws while holding every resource.
vi.mock('./wake-broker-host', async (importOriginal) => {
  const actual = await importOriginal<typeof WakeBrokerHostModule>()
  return {
    ...actual,
    startWakeBroker: vi.fn((userDataPath: string) => {
      const started = actual.startWakeBroker(userDataPath)
      seen.brokerEnabledAtThrow = actual.wakeBrokerHost.current() !== null
      return { ...started, targetCount: 0 } as ReturnType<typeof actual.startWakeBroker>
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relay wake harness setup failure (review WR-03)', () => {
  it('stops the server, disables the broker and removes the temp dir when setup throws midway', async () => {
    const stop = vi.spyOn(OrcaRuntimeRpcServer.prototype, 'stop')
    await expect(
      startRelayWakeHarness({ port: 9, devices: [{ name: 'phone-a', grant: true }] })
    ).rejects.toThrow('wake broker did not start with one target')

    // Station controls: setup reached the temp dir and a really enabled broker before it threw.
    const userDataPath = vi.mocked(fs.mkdtempSync).mock.results[0]?.value as string
    expect(userDataPath).toContain('orca-wake-relay-')
    expect(vi.mocked(startWakeBroker)).toHaveBeenCalledTimes(1)
    expect(seen.brokerEnabledAtThrow).toBe(true)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(wakeBrokerHost.current()).toBeNull()
    expect(wakeBrokerHost.authority()).toBeNull()
    expect(fs.existsSync(userDataPath)).toBe(false)
  })
})
