import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { isCommandGroup } from '../args'
import {
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  getServeAutostartStatus,
  getServeAutostartTaskName,
  type ServeAutostartDeps,
  type ServeAutostartExecResult
} from './serve-autostart'
import { RuntimeClientError } from './types'

type ExecCall = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }

function fakeDeps(
  platform: NodeJS.Platform,
  reply: ServeAutostartExecResult | ((call: ExecCall) => ServeAutostartExecResult),
  env: NodeJS.ProcessEnv = {}
): { deps: ServeAutostartDeps; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const deps: ServeAutostartDeps = {
    platform,
    env,
    exec: vi.fn(async (file, args, options) => {
      const call = { file, args, env: options.env }
      calls.push(call)
      return typeof reply === 'function' ? reply(call) : reply
    })
  }
  return { deps, calls }
}

const RUNNING_TASK_JSON = JSON.stringify({
  State: 4,
  LastTaskResult: 0,
  LastRunTime: '2026-10-27T08:00:00.0000000Z',
  Execute: 'C:\\Program Files\\Orca\\Orca.exe',
  Arguments: '--serve --serve-autostart --serve-no-pairing',
  WorkingDirectory: 'C:\\Program Files\\Orca'
})

describe('getServeAutostartStatus on non-Windows', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`fails with unsupported_platform naming the Linux doc on ${platform}`, async () => {
      const { deps, calls } = fakeDeps(platform, { code: 0, stdout: '', stderr: '' })
      const error = await getServeAutostartStatus({}, deps).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RuntimeClientError)
      expect((error as RuntimeClientError).code).toBe('unsupported_platform')
      expect((error as RuntimeClientError).message).toContain(
        'docs/reference/headless-linux-server.md'
      )
      expect(calls).toEqual([])
    })
  }
})

describe('getServeAutostartStatus on win32', () => {
  it('reports not installed when the lookup prints nothing and exits 0', async () => {
    const { deps } = fakeDeps('win32', { code: 0, stdout: '', stderr: '' })
    await expect(getServeAutostartStatus({ taskName: 'Orca X' }, deps)).resolves.toEqual({
      installed: false,
      taskName: 'Orca X'
    })
  })

  it('maps a running task with its action', async () => {
    const { deps } = fakeDeps('win32', { code: 0, stdout: `${RUNNING_TASK_JSON}\r\n`, stderr: '' })
    await expect(getServeAutostartStatus({ taskName: 'Orca X' }, deps)).resolves.toEqual({
      installed: true,
      taskName: 'Orca X',
      state: 'running',
      lastTaskResult: 0,
      lastRunTime: '2026-10-27T08:00:00.0000000Z',
      command: 'C:\\Program Files\\Orca\\Orca.exe',
      arguments: '--serve --serve-autostart --serve-no-pairing',
      workingDirectory: 'C:\\Program Files\\Orca'
    })
  })

  it.each([
    [0, 'unknown'],
    [1, 'disabled'],
    [2, 'queued'],
    [3, 'ready'],
    [4, 'running'],
    [9, 'unknown']
  ])('maps Task Scheduler State %i to %s', async (stateValue, expected) => {
    const stdout = JSON.stringify({ ...JSON.parse(RUNNING_TASK_JSON), State: stateValue })
    const { deps } = fakeDeps('win32', { code: 0, stdout, stderr: '' })
    const status = await getServeAutostartStatus({ taskName: 'Orca X' }, deps)
    expect(status).toMatchObject({ installed: true, state: expected })
  })

  it('reads a never-run task as lastRunTime null', async () => {
    const stdout = JSON.stringify({ ...JSON.parse(RUNNING_TASK_JSON), LastRunTime: null })
    const { deps } = fakeDeps('win32', { code: 0, stdout, stderr: '' })
    const status = await getServeAutostartStatus({ taskName: 'Orca X' }, deps)
    expect(status).toMatchObject({ installed: true, lastRunTime: null })
  })

  it.each([['not json'], ['[]'], ['{"State":"Running"}'], ['42']])(
    'throws autostart_status_unreadable for stdout %s (never reports not installed)',
    async (stdout) => {
      const { deps } = fakeDeps('win32', { code: 0, stdout, stderr: '' })
      await expect(getServeAutostartStatus({ taskName: 'Orca X' }, deps)).rejects.toMatchObject({
        code: 'autostart_status_unreadable'
      })
    }
  )

  it('throws autostart_status_unreadable when the lookup itself fails', async () => {
    const { deps } = fakeDeps('win32', { code: 3, stdout: '', stderr: 'Access is denied.' })
    await expect(getServeAutostartStatus({ taskName: 'Orca X' }, deps)).rejects.toMatchObject({
      code: 'autostart_status_unreadable',
      message: expect.stringContaining('Access is denied.')
    })
  })

  it('passes the task name only through the environment, with a constant -Command', async () => {
    const hostile = `Orca'; Remove-Item C:\\ -Recurse; '`
    const { deps, calls } = fakeDeps('win32', { code: 0, stdout: '', stderr: '' }, { PATH: 'p' })
    await getServeAutostartStatus({ taskName: hostile }, deps)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.file).toBe('powershell.exe')
    expect(call.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      SERVE_AUTOSTART_STATUS_SCRIPT
    ])
    expect(call.args.join(' ')).not.toContain(hostile)
    expect(SERVE_AUTOSTART_STATUS_SCRIPT).not.toContain('Orca')
    expect(call.env[SERVE_AUTOSTART_TASK_NAME_ENV]).toBe(hostile)
    expect(call.env.PATH).toBe('p')
  })
})

describe('getServeAutostartTaskName', () => {
  it('suffixes the sanitized user so two Windows users get distinct tasks', () => {
    expect(getServeAutostartTaskName('jacobo')).toBe('Orca Host Service (jacobo)')
    expect(getServeAutostartTaskName('Ana María Gómez')).toBe('Orca Host Service (AnaMaraGmez)')
    expect(getServeAutostartTaskName('')).toBe('Orca Host Service (user)')
  })
})

describe('serve autostart help routing', () => {
  it('treats serve autostart as a group while serve stays a command', () => {
    expect(isCommandGroup(['serve', 'autostart'])).toBe(true)
    expect(isCommandGroup(['serve'])).toBe(false)
  })
})

// Why: a fake exec proves the parser, not that Get-ScheduledTask answers this way on a real (possibly Spanish) Windows.
describe.skipIf(process.platform !== 'win32')('live Task Scheduler read (read-only)', () => {
  it('reads an absent nonce as not installed and a built-in task as installed', async () => {
    const nonce = `Orca Absent ${randomUUID()}`
    await expect(getServeAutostartStatus({ taskName: nonce })).resolves.toEqual({
      installed: false,
      taskName: nonce
    })
    const builtIn = await getServeAutostartStatus({
      taskName: 'ScheduledDefrag',
      taskPath: '\\Microsoft\\Windows\\Defrag\\'
    })
    console.log(`[live-positive-control] ${JSON.stringify(builtIn)}`)
    expect(builtIn).toMatchObject({ installed: true, taskName: 'ScheduledDefrag' })
  }, 60_000)
})
