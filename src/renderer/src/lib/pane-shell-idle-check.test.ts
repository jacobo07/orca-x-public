import { describe, expect, it, vi } from 'vitest'
import { checkPaneShellIdle } from './pane-shell-idle-check'
import type { PtyProcessInspection } from '../../../shared/pty-process-inspection'

// A current-generation host: it can vouch for the prompt AND for the line at it.
const idleShell: PtyProcessInspection = {
  foregroundProcess: 'powershell.exe',
  hasChildProcesses: false,
  promptState: 'prompt',
  inputSincePrompt: 'clean'
}

function check(
  inspection: Partial<PtyProcessInspection>,
  getPtyId: () => string | null = () => 'pty-1',
  hasUnsentInput?: () => boolean
) {
  return checkPaneShellIdle({
    getPtyId,
    inspect: vi.fn(async () => ({ ...idleShell, ...inspection })),
    hasUnsentInput
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

  it('refuses a prompt that may still hold a line the user typed and never submitted', async () => {
    await expect(
      check(
        {},
        () => 'pty-1',
        () => true
      )
    ).resolves.toBe('unsent-input')
  })

  it('resumes a prompt the user left empty', async () => {
    await expect(
      check(
        {},
        () => 'pty-1',
        () => false
      )
    ).resolves.toBe('idle')
  })

  it('names the running command first, since that is what the user must deal with', async () => {
    await expect(
      check(
        { promptState: 'running' },
        () => 'pty-1',
        () => true
      )
    ).resolves.toBe('busy')
  })

  it('leaves a shell it could not confirm unconfirmed, never unsent-input', async () => {
    await expect(
      check(
        { promptState: 'unknown' },
        () => 'pty-1',
        () => true
      )
    ).resolves.toBe('unconfirmed')
  })

  // Why these four: the renderer's own flag dies with the renderer, but the shell it protects
  // does not. Only the host saw every byte the user typed, so the host is the authority and the
  // renderer's flag may only ADD safety.
  it('refuses a line the host saw typed, even when this renderer never saw it', async () => {
    // The reload case: the store is empty after a reload, the shell still holds the text.
    await expect(
      check(
        { inputSincePrompt: 'typed' },
        () => 'pty-1',
        () => false
      )
    ).resolves.toBe('unsent-input')
  })

  it('refuses a line this renderer saw typed, even when the host believes it clean', async () => {
    await expect(
      check(
        { inputSincePrompt: 'clean' },
        () => 'pty-1',
        () => true
      )
    ).resolves.toBe('unsent-input')
  })

  it('will not call a prompt idle when no host could vouch for the line at it', async () => {
    // A host old enough to track prompts but not input cannot say the line is empty, and
    // "nobody told me" is not evidence of an empty line.
    await expect(
      check(
        { inputSincePrompt: undefined },
        () => 'pty-1',
        () => false
      )
    ).resolves.toBe('host-outdated')
  })

  it('resumes only when the host itself vouches the line is clean', async () => {
    await expect(
      check(
        { inputSincePrompt: 'clean' },
        () => 'pty-1',
        () => false
      )
    ).resolves.toBe('idle')
  })

  it('cannot confirm a pane with no PTY or one that moved to another PTY during the read', async () => {
    await expect(check({}, () => null)).resolves.toBe('unconfirmed')
    const ids = ['pty-1', 'pty-2']
    await expect(check({}, () => ids.shift() ?? null)).resolves.toBe('unconfirmed')
  })
})
