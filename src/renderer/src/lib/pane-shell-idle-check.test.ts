import { describe, expect, it, vi } from 'vitest'
import { checkPaneShellIdle } from './pane-shell-idle-check'
import type { PtyProcessInspection } from '../../../shared/pty-process-inspection'

const idleShell: PtyProcessInspection = {
  foregroundProcess: 'powershell.exe',
  hasChildProcesses: false,
  promptState: 'prompt'
}

function check(
  inspection: Partial<PtyProcessInspection>,
  getPtyId: () => string | null = () => 'pty-1'
) {
  return checkPaneShellIdle({
    getPtyId,
    inspect: vi.fn(async () => ({ ...idleShell, ...inspection }))
  })
}

describe('checkPaneShellIdle', () => {
  it('accepts only a shell at its prompt with nothing in front of it', async () => {
    await expect(check({})).resolves.toBe('idle')
  })

  it('calls a command the shell reported starting busy, though no child is visible', async () => {
    // A dev server under Windows PowerShell: the process half still names the shell.
    await expect(check({ promptState: 'running' })).resolves.toBe('busy')
  })

  it('calls a child process busy whatever the markers say', async () => {
    await expect(check({ hasChildProcesses: true, foregroundProcess: 'codex' })).resolves.toBe(
      'busy'
    )
  })

  it('names a host that predates marker tracking, apart from one that saw no marker yet', async () => {
    await expect(check({ promptState: undefined })).resolves.toBe('host-outdated')
    await expect(check({ promptState: 'unknown' })).resolves.toBe('unconfirmed')
  })

  it('names a markerless shell', async () => {
    await expect(check({ promptState: 'unsupported' })).resolves.toBe('unsupported')
  })

  it('cannot confirm an unavailable or failed inspection', async () => {
    await expect(check({ unavailable: true })).resolves.toBe('unconfirmed')
    await expect(
      checkPaneShellIdle({
        getPtyId: () => 'pty-1',
        inspect: async () => {
          throw new Error('terminal_gone')
        }
      })
    ).resolves.toBe('unconfirmed')
  })

  it('cannot confirm a pane with no PTY or one that moved to another PTY during the read', async () => {
    await expect(check({}, () => null)).resolves.toBe('unconfirmed')
    const ids = ['pty-1', 'pty-2']
    await expect(check({}, () => ids.shift() ?? null)).resolves.toBe('unconfirmed')
  })
})
