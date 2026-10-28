import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeClient } from '../runtime-client'
import { WAKE_HANDLERS, createWakeHandlers } from './wake'

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

describe('orca wake grant and target removal', () => {
  const GRANT = { deviceId: 'dev-a', targetId: TARGET.targetId, grantedAt: 1 }

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it.each([
    [
      'wake grant add',
      [
        ['device', 'dev-a'],
        ['target', TARGET.targetId]
      ] as [string, string][],
      'host.wake.admin.grantAdd',
      { deviceId: 'dev-a', targetId: TARGET.targetId },
      { grant: GRANT }
    ],
    [
      'wake grant remove',
      [
        ['device', 'dev-a'],
        ['target', TARGET.targetId]
      ] as [string, string][],
      'host.wake.admin.grantRemove',
      { deviceId: 'dev-a', targetId: TARGET.targetId },
      { removed: true }
    ],
    [
      'wake grant list',
      [] as [string, string][],
      'host.wake.admin.grantList',
      null,
      { grants: [GRANT] }
    ],
    [
      'wake target remove',
      [['target', TARGET.targetId]] as [string, string][],
      'host.wake.admin.targetRemove',
      { targetId: TARGET.targetId },
      { removed: true, targetId: TARGET.targetId }
    ]
  ])('%s makes exactly one matching admin call', async (key, flags, method, params, result) => {
    callMock.mockResolvedValue(success(result))
    await WAKE_HANDLERS[key](context(flags, true))
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(method, params)
    expect(JSON.parse(printed()).result).toEqual(result)
  })

  it.each([
    ['wake grant add', [['device', 'dev-a']] as [string, string][]],
    ['wake grant add', [['target', TARGET.targetId]] as [string, string][]],
    ['wake grant remove', [['device', 'dev-a']] as [string, string][]],
    ['wake target remove', [] as [string, string][]]
  ])('%s refuses missing ids before any call', async (key, flags) => {
    await expect(WAKE_HANDLERS[key](context(flags))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('points at where device ids come from when the broker refuses wake_device_unknown', async () => {
    callMock.mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'test',
        ok: false,
        error: {
          code: 'wake_device_unknown',
          message: 'That device is not paired with this host.'
        },
        _meta: { runtimeId: 'broker' }
      })
    )
    const error = await WAKE_HANDLERS['wake grant add'](
      context([
        ['device', 'dev-gone'],
        ['target', TARGET.targetId]
      ])
    ).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ code: 'wake_device_unknown' })
    const message = (error as Error).message
    expect(message).toContain('pairedDeviceId')
    expect(message).toContain('status.get')
    expect(message).toContain('Settings')
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})

describe('orca wake refuses the SSH relay bridge and remote retargeting', () => {
  const VALID_FLAGS: Record<string, [string, string][]> = {
    'wake target add': [['mac', 'aa:bb:cc:dd:ee:ff']],
    'wake target list': [],
    'wake target remove': [['target', TARGET.targetId]],
    'wake grant add': [
      ['device', 'dev-a'],
      ['target', TARGET.targetId]
    ],
    'wake grant remove': [
      ['device', 'dev-a'],
      ['target', TARGET.targetId]
    ],
    'wake grant list': []
  }

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue(success({}))
  })

  it('covers every wake handler', () => {
    expect(Object.keys(createWakeHandlers({})).sort()).toEqual(Object.keys(VALID_FLAGS).sort())
  })

  it.each(Object.keys(VALID_FLAGS))(
    '%s throws remote_invocation_refused with ORCA_CLI_CWD set and makes no runtime call',
    async (key) => {
      const handlers = createWakeHandlers({ ORCA_CLI_CWD: '/home/owner/repo' })
      await expect(handlers[key](context(VALID_FLAGS[key]))).rejects.toMatchObject({
        code: 'remote_invocation_refused'
      })
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(VALID_FLAGS))(
    '%s refuses --environment and --pairing-code instead of retargeting',
    async (key) => {
      const handlers = createWakeHandlers({})
      for (const flag of ['environment', 'pairing-code']) {
        await expect(
          handlers[key](context([...VALID_FLAGS[key], [flag, 'homelab']]))
        ).rejects.toMatchObject({ code: 'remote_invocation_refused' })
      }
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('refuses a runtime client that resolved to a remote pairing', async () => {
    const remoteClient = { call: callMock, isRemote: true } as unknown as RuntimeClient
    const handlers = createWakeHandlers({})
    await expect(
      handlers['wake grant list']({ ...context([]), client: remoteClient })
    ).rejects.toMatchObject({ code: 'remote_invocation_refused' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    ['WSL bridge', '\\\\wsl.localhost\\Ubuntu\\home\\owner\\repo'],
    ['WSL bridge in /mnt/c', 'C:\\Users\\owner\\repo'],
    ['SSH relay', '/home/owner/repo']
  ])(
    'refuses a %s caller without claiming an SSH session it cannot prove (IN-02)',
    async (_caller, cwd) => {
      const refusal = createWakeHandlers({ ORCA_CLI_CWD: cwd })['wake grant list'](context([]))
      await expect(refusal).rejects.toMatchObject({ code: 'remote_invocation_refused' })
      const { message } = (await refusal.catch((error: unknown) => error)) as Error
      expect(message).toContain('remote or bridged shell (SSH relay or WSL)')
      expect(message).not.toContain('not through a remote SSH session')
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('still reaches the runtime with an empty ORCA_CLI_CWD (positive control)', async () => {
    callMock.mockResolvedValue(success({ grants: [] }))
    await createWakeHandlers({ ORCA_CLI_CWD: '' })['wake grant list'](context([]))
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})
