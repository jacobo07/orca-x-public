import { describe, expect, it } from 'vitest'

import { AGENT_PROCESS_METHODS } from '../../shared/agent-process-wire'
import { ProviderUnavailableError } from '../conversation/provider-unavailable'

import {
  checkRemoteCodexAuth,
  resolveSshCodexDriver,
  type ConnectedMux
} from './codex-ssh-conversation-driver'

const TARGET = {
  projectId: 'github:acme/ledger',
  hostId: 'ssh:box' as const,
  setupId: 'setup-1',
  path: '/srv/ledger'
}

function mux(answer: (method: string) => Promise<unknown>, disposed = false): ConnectedMux {
  return {
    request: (method) => answer(method),
    onNotificationByMethod: () => () => {},
    onDispose: () => () => {},
    isDisposed: () => disposed
  }
}

const reject = (error: unknown) => () => Promise.reject(error)

describe('resolveSshCodexDriver', () => {
  it('refuses a host with no live connection, and one whose connection is gone', async () => {
    await expect(resolveSshCodexDriver(TARGET, () => undefined)).resolves.toEqual({
      refusal: 'remote-host-unreachable'
    })
    await expect(
      resolveSshCodexDriver(TARGET, () => mux(async () => ({ streamingStdioVersion: 1 }), true))
    ).resolves.toEqual({ refusal: 'remote-host-unreachable' })
  })

  it('looks the connection up by the ssh target id, not the host id', async () => {
    const asked: string[] = []
    await resolveSshCodexDriver({ ...TARGET, hostId: 'ssh:my%20box' }, (targetId) => {
      asked.push(targetId)
      return undefined
    })
    expect(asked).toEqual(['my box'])
  })

  it('names a relay without the method as too old, by its numeric code', async () => {
    const tooOld = Object.assign(new Error('Method not found: agentProcess.getCapabilities'), {
      code: -32601
    })
    await expect(resolveSshCodexDriver(TARGET, () => mux(reject(tooOld)))).resolves.toEqual({
      refusal: 'remote-relay-unsupported'
    })
  })

  it('reads a probe that timed out as unreachable, never as supported', async () => {
    const timedOut = Object.assign(new Error('timed out'), { code: 'SSH_MUX_REQUEST_TIMEOUT' })
    await expect(resolveSshCodexDriver(TARGET, () => mux(reject(timedOut)))).resolves.toEqual({
      refusal: 'remote-host-unreachable'
    })
  })

  it('refuses a relay reporting an older streaming version', async () => {
    await expect(
      resolveSshCodexDriver(TARGET, () => mux(async () => ({ streamingStdioVersion: 0 })))
    ).resolves.toEqual({ refusal: 'remote-relay-unsupported' })
  })

  it('refuses a project whose directory the host says is gone, and only on that answer', async () => {
    const answering = (stat: () => Promise<unknown>) => () =>
      mux((method) =>
        method === AGENT_PROCESS_METHODS.getCapabilities
          ? Promise.resolve({ streamingStdioVersion: 1 })
          : stat()
      )
    const enoent = new Error("ENOENT: no such file or directory, lstat '/srv/ledger'")
    const eacces = new Error("EACCES: permission denied, lstat '/srv/ledger'")
    await expect(resolveSshCodexDriver(TARGET, answering(reject(enoent)))).resolves.toEqual({
      refusal: 'remote-project-missing'
    })
    await expect(
      resolveSshCodexDriver(
        TARGET,
        answering(async () => ({ type: 'file' }))
      )
    ).resolves.toEqual({ refusal: 'remote-project-missing' })
    // Not an answer about the project: the relay's own directory check still decides later.
    for (const notAnAnswer of [
      reject(eacces),
      async () => ({ type: 'directory' }),
      async () => null
    ]) {
      const resolution = await resolveSshCodexDriver(TARGET, answering(notAnAnswer))
      expect('driver' in resolution).toBe(true)
    }
  })

  it('offers a driver and the host auth check when the relay can run the process', async () => {
    const resolution = await resolveSshCodexDriver(TARGET, () =>
      mux(async () => ({ streamingStdioVersion: 1 }))
    )
    expect('driver' in resolution && typeof resolution.checkAuth).toBe('function')
  })
})

describe('checkRemoteCodexAuth', () => {
  const answering = (run: unknown) =>
    mux(async (method) => (method === AGENT_PROCESS_METHODS.run ? run : { ok: true }))
  const exited = (exitCode: number) => ({
    outcome: 'exited',
    exitCode,
    signal: null,
    finalStdoutSeq: 0,
    finalStderrSeq: 0,
    stderrTail: '',
    reason: 'closed'
  })

  it('reads exit 0 as signed in and exit 1 as signed out, naming the host', async () => {
    await expect(checkRemoteCodexAuth(answering(exited(0)), '/srv', 'box')).resolves.toEqual({
      ready: true
    })
    await expect(checkRemoteCodexAuth(answering(exited(1)), '/srv', 'box')).resolves.toEqual({
      ready: false,
      detail: 'codex on box is not signed in'
    })
  })

  it('names codex missing on the host as its own state, never as a sign-in problem', async () => {
    const answer = checkRemoteCodexAuth(
      answering({ outcome: 'refused', reason: 'command-not-found' }),
      '/srv',
      'box'
    )
    await expect(answer).rejects.toBeInstanceOf(ProviderUnavailableError)
    await expect(answer).rejects.toMatchObject({
      reason: 'not-installed',
      message: 'codex is not installed on box'
    })
  })

  it('throws — never answers "not signed in" — when it could not actually ask', async () => {
    const answer = checkRemoteCodexAuth(
      answering({ outcome: 'refused', reason: 'cwd-missing' }),
      '/srv',
      'box'
    )
    await expect(answer).rejects.toThrow('remote host refused: cwd-missing')
    await expect(answer).rejects.not.toBeInstanceOf(ProviderUnavailableError)
    await expect(checkRemoteCodexAuth(answering(exited(2)), '/srv', 'box')).rejects.toThrow(
      'exited 2'
    )
  })
})
