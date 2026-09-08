import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCliCommands } from './node-cli-command-resolution'

/**
 * The install-dir fallback is the only thing standing between "the user installed an agent a
 * minute ago" and "Orca says it isn't there". A GUI-launched Orca holds the environment block it
 * inherited at launch, so a native installer that writes the persisted user PATH is invisible to
 * it — the process never re-reads the registry on its own.
 */

const CODEX_BIN_SEGMENTS = ['AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin']

let homePath: string

function installFakeExecutable(segments: readonly string[], fileName: string): string {
  const directory = join(homePath, ...segments)
  mkdirSync(directory, { recursive: true })
  const executable = join(directory, fileName)
  writeFileSync(executable, '')
  return executable
}

beforeEach(() => {
  homePath = mkdtempSync(join(tmpdir(), 'orca-cli-resolution-'))
})

afterEach(() => {
  rmSync(homePath, { recursive: true, force: true })
})

describe('resolveCliCommands install-dir fallback on Windows', () => {
  it('finds a standalone-installed Codex that the inherited PATH cannot see', () => {
    const executable = installFakeExecutable(CODEX_BIN_SEGMENTS, 'codex.exe')

    const resolved = resolveCliCommands(['codex'], {
      platform: 'win32',
      homePath,
      // The launch-time PATH, which predates the install.
      pathEnv: 'C:\\Windows\\System32'
    })

    expect(resolved.get('codex')).toBe(executable)
  })

  it('still reports the bare name when the agent really is absent', () => {
    // Without this the test above would pass against a fallback that returns any path it composed,
    // installed or not — the assertion has to be able to come back negative.
    const resolved = resolveCliCommands(['codex'], {
      platform: 'win32',
      homePath,
      pathEnv: 'C:\\Windows\\System32'
    })

    expect(resolved.get('codex')).toBe('codex')
  })

  it('keeps Claude resolving from its own install dir', () => {
    const executable = installFakeExecutable(['.local', 'bin'], 'claude.exe')

    const resolved = resolveCliCommands(['claude'], {
      platform: 'win32',
      homePath,
      pathEnv: 'C:\\Windows\\System32'
    })

    expect(resolved.get('claude')).toBe(executable)
  })

  it('prefers PATH over the fallback so an explicit install wins', () => {
    installFakeExecutable(CODEX_BIN_SEGMENTS, 'codex.exe')
    const onPath = installFakeExecutable(['custom', 'bin'], 'codex.exe')

    const resolved = resolveCliCommands(['codex'], {
      platform: 'win32',
      homePath,
      pathEnv: join(homePath, 'custom', 'bin')
    })

    expect(resolved.get('codex')).toBe(onPath)
  })
})
