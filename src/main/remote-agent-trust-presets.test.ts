import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const consentDir = mkdtempSync(join(tmpdir(), 'remote-trust-consent-'))
const previousUserDataPath = process.env.ORCA_USER_DATA_PATH
process.env.ORCA_USER_DATA_PATH = consentDir

const mocks = vi.hoisted(() => ({
  getActiveMultiplexer: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./ipc/ssh', () => ({
  getActiveMultiplexer: mocks.getActiveMultiplexer
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

const { markRemoteAgentWorkspaceTrusted } = await import('./remote-agent-trust-presets')
const { workspaceConsentKey } = await import('./workspace-execution-consent')

// These cases exercise the remote artifact WRITER, which now requires workspace execution consent,
// so the harness supplies it. That makes this file unable to testify that consent is required —
// agent-trust-consent-characterization.test.ts owns that claim.
//
// Grants are recorded per (connection, canonical remote path, preset) rather than blanket, so the
// scoping stays observable: the final case proves a grant on one host does not reach another.
// The remote path is the one the remote filesystem provider returned, because that is the identity
// the artifact is written under.
function grantRemoteConsent(
  entries: { connectionId: string; workspacePath: string; preset: 'cursor' | 'copilot' | 'codex' }[]
): void {
  const grants: Record<string, { decision: string; at: string }> = {}
  for (const entry of entries) {
    grants[
      workspaceConsentKey({
        scope: { kind: 'ssh', connectionId: entry.connectionId },
        workspacePath: entry.workspacePath,
        preset: entry.preset
      })
    ] = { decision: 'granted', at: '2026-01-01T00:00:00.000Z' }
  }
  writeFileSync(
    join(consentDir, 'workspace-execution-consent.json'),
    `${JSON.stringify({ version: 1, grants }, null, 2)}\n`
  )
}

function makeFsProvider(overrides: Record<string, unknown> = {}) {
  return {
    realpath: vi.fn(async (path: string) => `/real${path}`),
    readFile: vi.fn(async () => ({ content: '', isBinary: false })),
    createDir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => {
      throw new Error('missing')
    }),
    ...overrides
  }
}

describe('markRemoteAgentWorkspaceTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: '/home/u/' }))
    })
    grantRemoteConsent([
      { connectionId: 'ssh-1', workspacePath: '/real/repo/worktree', preset: 'codex' },
      { connectionId: 'ssh-1', workspacePath: '/real/repo/worktree', preset: 'cursor' },
      { connectionId: 'ssh-1', workspacePath: '/real/repo/worktree', preset: 'copilot' },
      { connectionId: 'ssh-windows', workspacePath: 'C:/Users/alice/platform', preset: 'codex' },
      { connectionId: 'ssh-windows', workspacePath: 'C:/Users/alice/platform', preset: 'cursor' }
    ])
  })

  afterAll(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('writes Codex trust to the remote home and canonicalized workspace path', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(mocks.getActiveMultiplexer).toHaveBeenCalledWith('ssh-1')
    expect(fsProvider.realpath).toHaveBeenCalledWith('/repo/worktree')
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex/config.toml',
      expect.stringContaining('[projects."/real/repo/worktree"]')
    )
  })

  it('writes Codex trust when the remote home is a Windows absolute path', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:\\Users\\alice\\' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('C:/Users/alice/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.codex/config.toml',
      expect.stringContaining('[projects."C:/Users/alice/platform"]')
    )
  })

  it('writes Cursor trust marker on the remote host', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.cursor/projects/real-repo-worktree')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.cursor/projects/real-repo-worktree/.workspace-trusted',
      expect.stringContaining('"workspacePath": "/real/repo/worktree"')
    )
  })

  it('sanitizes Windows path characters in remote Cursor trust marker paths', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:/Users/alice/' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform/.workspace-trusted',
      expect.stringContaining('"workspacePath": "C:/Users/alice/platform"')
    )
  })

  it('appends Copilot trusted folder remotely without clobbering config keys', async () => {
    const writeFile = vi.fn(async (_filePath: string, _content: string) => undefined)
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ firstLaunchAt: '2026-01-01', trustedFolders: ['/old'] }),
        isBinary: false
      })),
      writeFile
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'copilot',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.copilot')
    const written = writeFile.mock.calls[0]?.[1]
    expect(typeof written).toBe('string')
    expect(JSON.parse(written as string)).toEqual({
      firstLaunchAt: '2026-01-01',
      trustedFolders: ['/old', '/real/repo/worktree']
    })
  })

  it('does not let a grant on one host authorize the same path on another', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    const outcome = await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-other',
      workspacePath: '/repo/worktree'
    })

    expect(outcome).toEqual({ written: false, refusedBecause: 'unrecorded' })
    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })

  it('does nothing when the SSH home cannot be resolved safely', async () => {
    const fsProvider = makeFsProvider()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'relative/home' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })
})
