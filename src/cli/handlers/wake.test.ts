import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { WAKE_HANDLERS } from './wake'

const TARGET = {
  targetId: 'wt_0123456789ab',
  mac: 'aa:bb:cc:dd:ee:ff',
  broadcast: '255.255.255.255',
  port: 9,
  label: 'desk',
  createdAt: 1
}

const callMock = vi.fn()
const client = { call: callMock } as unknown as RuntimeClient
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

function context(flags: [string, string | boolean][], json = false): HandlerContext {
  return { client, cwd: process.cwd(), flags: new Map(flags), json, rawArgs: [] }
}

function success(result: unknown) {
  return { id: 'test', ok: true, result, _meta: { runtimeId: 'broker' } }
}

function printed(): string {
  return logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
}

describe('orca wake target add and list', () => {
  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('makes exactly one targetAdd call and prints the new target id', async () => {
    callMock.mockResolvedValue(success({ target: TARGET }))
    await WAKE_HANDLERS['wake target add'](
      context([
        ['mac', 'aa:bb:cc:dd:ee:ff'],
        ['label', 'desk']
      ])
    )
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('host.wake.admin.targetAdd', {
      mac: 'aa:bb:cc:dd:ee:ff',
      label: 'desk'
    })
    expect(printed()).toContain(TARGET.targetId)
  })

  it('prints one hint recommending the subnet-directed broadcast when --broadcast is omitted', async () => {
    callMock.mockResolvedValue(success({ target: TARGET }))
    await WAKE_HANDLERS['wake target add'](context([['mac', 'aa:bb:cc:dd:ee:ff']]))
    const hints = errorSpy.mock.calls.map((args) => args.join(' '))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatch(/subnet/i)
    expect(hints[0]).toContain('--broadcast')
  })

  it('prints no hint when --broadcast is given and passes broadcast and port through', async () => {
    callMock.mockResolvedValue(success({ target: { ...TARGET, broadcast: '192.168.1.255' } }))
    await WAKE_HANDLERS['wake target add'](
      context([
        ['mac', 'AA-BB-CC-DD-EE-FF'],
        ['broadcast', '192.168.1.255'],
        ['port', '7']
      ])
    )
    expect(errorSpy).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledWith('host.wake.admin.targetAdd', {
      mac: 'aa:bb:cc:dd:ee:ff',
      broadcast: '192.168.1.255',
      port: 7
    })
  })

  it.each([
    ['a missing --mac', [] as [string, string][]],
    ['a 5-octet --mac', [['mac', 'aa:bb:cc:dd:ee']] as [string, string][]],
    [
      'a hostname --broadcast',
      [
        ['mac', 'aa:bb:cc:dd:ee:ff'],
        ['broadcast', 'example.com']
      ] as [string, string][]
    ],
    [
      'port 0',
      [
        ['mac', 'aa:bb:cc:dd:ee:ff'],
        ['port', '0']
      ] as [string, string][]
    ],
    [
      'a 65-character --label',
      [
        ['mac', 'aa:bb:cc:dd:ee:ff'],
        ['label', 'x'.repeat(65)]
      ] as [string, string][]
    ]
  ])('fails fast on %s without calling the runtime', async (_label, flags) => {
    await expect(WAKE_HANDLERS['wake target add'](context(flags))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('lists targets as JSON with one targetList call', async () => {
    callMock.mockResolvedValue(success({ targets: [TARGET] }))
    await WAKE_HANDLERS['wake target list'](context([], true))
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('host.wake.admin.targetList', null)
    expect(JSON.parse(printed()).result).toEqual({ targets: [TARGET] })
  })

  it('names the fix when no runtime is reachable', async () => {
    callMock.mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'no runtime'))
    await expect(WAKE_HANDLERS['wake target list'](context([]))).rejects.toThrow(
      'orca serve --wake-broker'
    )
  })
})
