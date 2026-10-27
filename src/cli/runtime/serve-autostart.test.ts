import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { isCommandGroup } from '../args'
import {
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  getServeAutostartStatus,
  getServeAutostartTaskName,
  installServeAutostart,
  removeServeAutostart,
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

const TARGET = {
  command: 'C:\\Program Files\\Orca\\Orca.exe',
  args: ['--serve', '--serve-autostart', '--serve-no-pairing'],
  workingDirectory: 'C:\\Program Files\\Orca'
}
const WIN_ENV = { USERDOMAIN: 'DOM', USERNAME: 'jacobo' }

type CreateSnapshot = { xmlPath: string; bytes: Buffer }

function schtasksDeps(code = 0, env: NodeJS.ProcessEnv = WIN_ENV) {
  const created: CreateSnapshot[] = []
  const fake = fakeDeps(
    'win32',
    (call) => {
      if (call.file === 'schtasks.exe' && call.args[0] === '/Create') {
        const xmlPath = call.args[2]
        created.push({ xmlPath, bytes: readFileSync(xmlPath) })
      }
      return { code, stdout: '', stderr: code === 0 ? '' : 'ERROR: access denied' }
    },
    env
  )
  return { ...fake, created }
}

describe('installServeAutostart', () => {
  it('writes UTF-16LE XML into a fresh temp dir, runs schtasks /Create /XML /F and removes the dir', async () => {
    const { deps, calls, created } = schtasksDeps()
    const result = await installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['schtasks.exe', '/Create', '/XML', created[0].xmlPath, '/TN', 'Orca X', '/F']
    ])
    const { bytes, xmlPath } = created[0]
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
    const xml = bytes.subarray(2).toString('utf16le')
    expect(xml).toContain('<UserId>DOM\\jacobo</UserId>')
    expect(xml).toContain('<Arguments>--serve --serve-autostart --serve-no-pairing</Arguments>')
    expect(existsSync(dirname(xmlPath))).toBe(false)
    expect(result).toEqual({
      installed: true,
      taskName: 'Orca X',
      command: TARGET.command,
      arguments: '--serve --serve-autostart --serve-no-pairing'
    })
  })

  it('overwrites with /F on a second install (idempotent)', async () => {
    const { deps, calls } = schtasksDeps()
    await installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    await installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.args.at(-1) === '/F')).toBe(true)
    expect(calls[0].args[2]).not.toBe(calls[1].args[2])
  })

  it('maps a schtasks failure to autostart_install_failed and still removes the temp dir', async () => {
    const { deps, created } = schtasksDeps(1)
    await expect(
      installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    ).rejects.toMatchObject({
      code: 'autostart_install_failed',
      message: expect.stringContaining('ERROR: access denied')
    })
    expect(existsSync(dirname(created[0].xmlPath))).toBe(false)
  })

  it('appends the autostart serve args after the app-root arg from the default launch target', async () => {
    const { deps, created } = schtasksDeps(0, {
      ...WIN_ENV,
      ORCA_APP_EXECUTABLE: 'C:\\dev\\electron.exe',
      ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1'
    })
    const result = await installServeAutostart({ taskName: 'Orca X' }, deps)
    expect(result.command).toBe('C:\\dev\\electron.exe')
    expect(result.arguments).toMatch(/ --serve --serve-autostart --serve-no-pairing$/)
    expect(result.arguments).not.toMatch(/^--serve/)
    const xml = created[0].bytes.subarray(2).toString('utf16le')
    expect(xml).toContain('<WorkingDirectory>')
  })

  it('falls back to the OS user name when USERDOMAIN is absent', async () => {
    const { deps, created } = schtasksDeps(0, {})
    await installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    const xml = created[0].bytes.subarray(2).toString('utf16le')
    expect(xml).not.toContain('<UserId>undefined')
    expect(xml).toMatch(/<UserId>[^<\\]+<\/UserId>/)
  })

  it.each([['C:\\Orca\\orca.cmd'], ['C:\\Orca\\ORCA.BAT']])(
    'refuses %s with autostart_requires_app_executable',
    async (command) => {
      const { deps, calls } = schtasksDeps()
      await expect(
        installServeAutostart({ taskName: 'Orca X', launchTarget: { ...TARGET, command } }, deps)
      ).rejects.toMatchObject({ code: 'autostart_requires_app_executable' })
      expect(calls).toEqual([])
    }
  )

  it('passes an end boundary through to the task definition', async () => {
    const { deps, created } = schtasksDeps()
    await installServeAutostart(
      { taskName: 'Orca X', launchTarget: TARGET, endBoundary: '2026-10-28T00:00:00' },
      deps
    )
    const xml = created[0].bytes.subarray(2).toString('utf16le')
    expect(xml).toContain('<EndBoundary>2026-10-28T00:00:00</EndBoundary>')
    expect(xml).toContain('<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>')
  })

  it('fails with unsupported_platform off Windows without exec', async () => {
    const { deps, calls } = fakeDeps('linux', { code: 0, stdout: '', stderr: '' })
    await expect(installServeAutostart({ launchTarget: TARGET }, deps)).rejects.toMatchObject({
      code: 'unsupported_platform'
    })
    expect(calls).toEqual([])
  })
})

describe('removeServeAutostart', () => {
  it('reports not_installed without calling schtasks when the task is absent', async () => {
    const { deps, calls } = fakeDeps('win32', { code: 0, stdout: '', stderr: '' })
    await expect(removeServeAutostart({ taskName: 'Orca X' }, deps)).resolves.toEqual({
      removed: false,
      taskName: 'Orca X',
      reason: 'not_installed'
    })
    expect(calls.map((call) => call.file)).toEqual(['powershell.exe'])
  })

  it('deletes an installed task with schtasks /Delete /TN /F', async () => {
    const { deps, calls } = fakeDeps('win32', (call) =>
      call.file === 'powershell.exe'
        ? { code: 0, stdout: RUNNING_TASK_JSON, stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    )
    await expect(removeServeAutostart({ taskName: 'Orca X' }, deps)).resolves.toEqual({
      removed: true,
      taskName: 'Orca X'
    })
    expect(calls.map((call) => [call.file, ...call.args]).at(-1)).toEqual([
      'schtasks.exe',
      '/Delete',
      '/TN',
      'Orca X',
      '/F'
    ])
  })

  it('maps a delete failure to autostart_remove_failed', async () => {
    const { deps } = fakeDeps('win32', (call) =>
      call.file === 'powershell.exe'
        ? { code: 0, stdout: RUNNING_TASK_JSON, stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: denied' }
    )
    await expect(removeServeAutostart({ taskName: 'Orca X' }, deps)).rejects.toMatchObject({
      code: 'autostart_remove_failed',
      message: expect.stringContaining('ERROR: denied')
    })
  })
})

describe('remote invocation through the SSH relay bridge (T-17-09)', () => {
  const remoteEnv = { ...WIN_ENV, ORCA_CLI_CWD: '/home/remote/repo' }

  it('refuses install and remove before any exec', async () => {
    const { deps, calls } = schtasksDeps(0, remoteEnv)
    await expect(
      installServeAutostart({ taskName: 'Orca X', launchTarget: TARGET }, deps)
    ).rejects.toMatchObject({ code: 'remote_invocation_refused' })
    await expect(removeServeAutostart({ taskName: 'Orca X' }, deps)).rejects.toMatchObject({
      code: 'remote_invocation_refused'
    })
    expect(calls).toEqual([])
  })

  it('still allows status', async () => {
    const { deps } = fakeDeps('win32', { code: 0, stdout: '', stderr: '' }, remoteEnv)
    await expect(getServeAutostartStatus({ taskName: 'Orca X' }, deps)).resolves.toEqual({
      installed: false,
      taskName: 'Orca X'
    })
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
