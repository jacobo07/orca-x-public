import { describe, expect, it } from 'vitest'
import { resolveCommandProfileStartup } from './terminal-launch-profile-resolution'
import type { TerminalLaunchProfile } from './terminal-launch-profiles'

const CONTEXT = {
  workspaceFolder: 'C:/Users/dev/projects/orca-x',
  workspaceFolderBasename: 'orca-x'
} as const

function commandProfile(
  overrides: Partial<Extract<TerminalLaunchProfile, { kind: 'command' }>> = {}
): Extract<TerminalLaunchProfile, { kind: 'command' }> {
  return {
    kind: 'command',
    id: 'command:sample',
    label: 'Sample',
    command: 'echo hello',
    ...overrides
  }
}

describe('command profile resolution', () => {
  it('passes a token-free command through unchanged', () => {
    const result = resolveCommandProfileStartup(commandProfile(), CONTEXT)

    expect(result).toEqual({ ok: true, startup: { command: 'echo hello' } })
  })

  it('expands the workspace tokens a remote profile needs', () => {
    const result = resolveCommandProfileStartup(
      commandProfile({ command: 'ssh host /home/me/bin/shell.sh ${workspaceFolderBasename}' }),
      CONTEXT
    )

    expect(result).toEqual({
      ok: true,
      startup: { command: 'ssh host /home/me/bin/shell.sh orca-x' }
    })
  })

  it('carries environment through, expanding tokens in values', () => {
    const result = resolveCommandProfileStartup(
      commandProfile({ env: { SLOT: 'slot2', WS: '${workspaceFolder}' } }),
      CONTEXT
    )

    expect(result).toEqual({
      ok: true,
      startup: {
        command: 'echo hello',
        env: { SLOT: 'slot2', WS: 'C:/Users/dev/projects/orca-x' }
      }
    })
  })

  it('refuses rather than launching a command with an unresolved token', () => {
    const result = resolveCommandProfileStartup(
      commandProfile({ command: 'run ${totallyUnknown}' }),
      CONTEXT
    )

    expect(result).toEqual({ ok: false, reason: 'unresolved-token', token: 'totallyUnknown' })
  })

  it('refuses when a known token has no value in this context', () => {
    const result = resolveCommandProfileStartup(
      commandProfile({ command: 'run ${workspaceFolderBasename}' }),
      { workspaceFolder: null, workspaceFolderBasename: null }
    )

    expect(result).toEqual({
      ok: false,
      reason: 'unresolved-token',
      token: 'workspaceFolderBasename'
    })
  })

  it('keeps the delivery mode the profile asked for', () => {
    const result = resolveCommandProfileStartup(
      commandProfile({ startupCommandDelivery: 'shell-ready' }),
      CONTEXT
    )

    expect(result).toEqual({
      ok: true,
      startup: { command: 'echo hello', startupCommandDelivery: 'shell-ready' }
    })
  })
})
