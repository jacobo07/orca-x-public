import { describe, expect, it } from 'vitest'
import {
  SERVE_AUTOSTART_STATUS_SCRIPT,
  SERVE_AUTOSTART_TASK_NAME_ENV,
  SERVE_AUTOSTART_TASK_PATH_ENV
} from '../../shared/serve-autostart-status'
import {
  AUTOSTART_STATUS_MAX_AGE_MS,
  createHostAutostartProbe,
  defaultHostAutostartProbeDeps,
  type HostAutostartExecResult
} from './host-autostart-probe'

const T = 1_760_000_000_000
const TASK = 'Orca Host Service (probe-test)'

type Call = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }

function deferred(): {
  promise: Promise<HostAutostartExecResult>
  resolve: (result: HostAutostartExecResult) => void
  reject: (error: Error) => void
} {
  let resolve!: (result: HostAutostartExecResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<HostAutostartExecResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(platform: NodeJS.Platform, reply?: HostAutostartExecResult | Error) {
  const calls: Call[] = []
  const pending: ReturnType<typeof deferred>[] = []
  let clock = T
  const probe = createHostAutostartProbe({
    platform,
    env: { SystemRoot: 'C:\\Windows' },
    taskName: TASK,
    now: () => clock,
    exec: (file, args, options) => {
      calls.push({ file, args, env: options.env })
      if (reply instanceof Error) {
        return Promise.reject(reply)
      }
      if (reply) {
        return Promise.resolve(reply)
      }
      const next = deferred()
      pending.push(next)
      return next.promise
    }
  })
  return {
    probe,
    calls,
    pending,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock
  }
}

function taskJson(state: number): string {
  return JSON.stringify({ State: state, LastTaskResult: 0, LastRunTime: null, Execute: 'Orca.exe' })
}

describe('host autostart probe on win32', () => {
  it('answers pending first and starts exactly one constant-script exec with the task name in env', () => {
    const { probe, calls } = harness('win32')
    expect(probe.read()).toEqual({
      value: 'unknown',
      reason: 'autostart_status_pending',
      evidence: null
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0].args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      SERVE_AUTOSTART_STATUS_SCRIPT
    ])
    expect(calls[0].args.join(' ')).not.toContain(TASK)
    expect(calls[0].env[SERVE_AUTOSTART_TASK_NAME_ENV]).toBe(TASK)
    expect(calls[0].env[SERVE_AUTOSTART_TASK_PATH_ENV]).toBe('\\')
    expect(calls[0].env.SystemRoot).toBe('C:\\Windows')
  })

  it.each([
    [
      'empty stdout',
      { code: 0, stdout: '  \n', stderr: '' },
      'not-configured',
      'logon_task_absent'
    ],
    ['ready', { code: 0, stdout: taskJson(3), stderr: '' }, 'supported', 'logon_task_installed'],
    ['running', { code: 0, stdout: taskJson(4), stderr: '' }, 'supported', 'logon_task_installed'],
    ['queued', { code: 0, stdout: taskJson(2), stderr: '' }, 'supported', 'logon_task_installed'],
    [
      'disabled',
      { code: 0, stdout: taskJson(1), stderr: '' },
      'not-configured',
      'logon_task_disabled'
    ],
    [
      'state unknown',
      { code: 0, stdout: taskJson(0), stderr: '' },
      'unknown',
      'logon_task_state_unknown'
    ],
    [
      'state out of range',
      { code: 0, stdout: taskJson(9), stderr: '' },
      'unknown',
      'logon_task_state_unknown'
    ],
    [
      'non-zero exit',
      { code: 3, stdout: '', stderr: 'Access denied' },
      'unknown',
      'autostart_status_unreadable'
    ],
    [
      'unparseable stdout',
      { code: 0, stdout: 'not json', stderr: '' },
      'unknown',
      'autostart_status_unreadable'
    ],
    [
      'a non-record',
      { code: 0, stdout: '[1]', stderr: '' },
      'unknown',
      'autostart_status_unreadable'
    ]
  ] as const)('maps %s to %s %s', async (_label, reply, value, reason) => {
    const { probe, now } = harness('win32', reply)
    probe.read()
    await probe.settled()
    const answer = probe.read()
    expect(answer).toMatchObject({ value, reason })
    if (answer.value === 'unknown') {
      expect(answer.evidence).toBeNull()
    } else {
      expect(answer.evidence).toEqual({ kind: 'os-probe', observedAt: now() })
    }
  })

  it('maps a rejected exec to unknown autostart_status_unreadable', async () => {
    const { probe } = harness('win32', new Error('spawn EPERM'))
    probe.read()
    await probe.settled()
    expect(probe.read()).toEqual({
      value: 'unknown',
      reason: 'autostart_status_unreadable',
      evidence: null
    })
  })

  it('stamps evidence at the exec completion time, not the request time', async () => {
    const { probe, pending, advance } = harness('win32')
    probe.read()
    advance(1234)
    pending[0].resolve({ code: 0, stdout: '', stderr: '' })
    await probe.settled()
    expect(probe.read()).toMatchObject({ evidence: { kind: 'os-probe', observedAt: T + 1234 } })
  })

  it('runs one exec for ten reads inside the max age and none while one is in flight', async () => {
    const { probe, calls, pending, advance } = harness('win32')
    for (let i = 0; i < 5; i += 1) {
      probe.read()
    }
    expect(calls).toHaveLength(1)
    pending[0].resolve({ code: 0, stdout: taskJson(3), stderr: '' })
    await probe.settled()
    for (let i = 0; i < 10; i += 1) {
      advance(1000)
      expect(probe.read()).toMatchObject({ value: 'supported' })
    }
    expect(calls).toHaveLength(1)
    expect(AUTOSTART_STATUS_MAX_AGE_MS).toBe(300_000)
  })

  it('refreshes once after the max age and serves the cached value meantime', async () => {
    const { probe, calls, pending, advance } = harness('win32')
    probe.read()
    pending[0].resolve({ code: 0, stdout: taskJson(3), stderr: '' })
    await probe.settled()
    advance(AUTOSTART_STATUS_MAX_AGE_MS)
    expect(probe.read()).toMatchObject({ value: 'supported', reason: 'logon_task_installed' })
    expect(probe.read()).toMatchObject({ value: 'supported' })
    expect(calls).toHaveLength(2)
    pending[1].resolve({ code: 0, stdout: taskJson(1), stderr: '' })
    await probe.settled()
    expect(probe.read()).toMatchObject({ value: 'not-configured', reason: 'logon_task_disabled' })
    expect(calls).toHaveLength(2)
  })
})

describe('host autostart probe off win32', () => {
  it('reports darwin as not-supported without an exec', () => {
    const { probe, calls, now } = harness('darwin')
    expect(probe.read()).toEqual({
      value: 'not-supported',
      reason: 'autostart_not_shipped_for_platform',
      evidence: { kind: 'host-announced', observedAt: now() }
    })
    expect(calls).toHaveLength(0)
  })

  it.each(['linux', 'freebsd'] as const)('reports %s as unknown without an exec', (platform) => {
    const { probe, calls } = harness(platform)
    expect(probe.read()).toEqual({
      value: 'unknown',
      reason: 'autostart_not_observable_on_platform',
      evidence: null
    })
    expect(calls).toHaveLength(0)
  })
})

// Plane: the real Windows Task Scheduler, read-only (Get-ScheduledTask). No task is created, run or deleted.
describe.runIf(process.platform === 'win32' && process.env.ORCA_LIVE_AUTOSTART_PROBE === '1')(
  'host autostart probe live read',
  () => {
    it('reads a nonce task name as not-configured logon_task_absent', async () => {
      const nonce = `Orca Probe Nonce ${process.pid}-${Date.now()}`
      const probe = createHostAutostartProbe({
        ...defaultHostAutostartProbeDeps(),
        taskName: nonce
      })
      probe.read()
      await probe.settled()
      const answer = probe.read()
      console.log(`[live] nonce task -> ${JSON.stringify(answer)}`)
      expect(answer).toMatchObject({ value: 'not-configured', reason: 'logon_task_absent' })
    }, 60_000)

    it('reads the built-in ScheduledDefrag task as a non-unknown os-probe value', async () => {
      const probe = createHostAutostartProbe({
        ...defaultHostAutostartProbeDeps(),
        taskName: 'ScheduledDefrag',
        taskPath: '\\Microsoft\\Windows\\Defrag\\'
      })
      probe.read()
      await probe.settled()
      const answer = probe.read()
      console.log(`[live] ScheduledDefrag -> ${JSON.stringify(answer)}`)
      expect(answer.value).not.toBe('unknown')
      expect(answer.evidence?.kind).toBe('os-probe')
    }, 60_000)
  }
)
