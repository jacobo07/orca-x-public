import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../shared/tui-agent-detection-commands'
import { DEFAULT_DISABLED_TUI_AGENTS, filterEnabledTuiAgents } from '../shared/tui-agent-selection'
import type { TuiAgent } from '../shared/tui-agent'
import { PreflightHandler } from './preflight-handler'

// Measures the relay's agent detection as the SSH quick-launch menu sees it: real child processes,
// the real client command list, and a fake HOME whose bins hold executable stubs.
const ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'PNPM_HOME', 'XDG_DATA_HOME', 'npm_config_prefix']

let home: string
let savedEnv: Record<string, string | undefined>

function installStub(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
}

// Why: the relay always searches these system dirs, so a test host that already ships an agent there
// answers "found" regardless of the fixture; the negative controls compare against that station fact.
function systemFallbackHas(command: string): boolean {
  return ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].some((dir) =>
    existsSync(join(dir, command))
  )
}

async function detect(): Promise<string[]> {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  new PreflightHandler({
    onRequest: (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }
  } as never)
  const reply = (await handlers.get('preflight.detectAgents')!({
    commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS
  })) as { agents: string[] }
  return reply.agents
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  home = mkdtempSync(join(tmpdir(), 'orca-detect-agents-'))
  process.env.HOME = home
  // Why: the minimal environment an SSH exec channel gives the relay; no user bins on it.
  process.env.PATH = '/usr/bin:/bin'
  for (const key of ['SHELL', 'PNPM_HOME', 'XDG_DATA_HOME', 'npm_config_prefix']) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  rmSync(home, { recursive: true, force: true })
})

describe('relay agent detection on an SSH target', () => {
  it('reports codex when it sits in a user bin the relay adds to PATH, next to claude', async () => {
    installStub(join(home, '.local', 'bin'), 'codex')
    installStub(join(home, '.local', 'bin'), 'claude')

    const agents = await detect()

    expect(agents).toContain('codex')
    expect(agents).toContain('claude')
  })

  it('reports codex when only the login profile puts its directory on PATH', async () => {
    installStub(join(home, 'tools', 'bin'), 'codex')
    writeFileSync(join(home, '.profile'), `export PATH="${join(home, 'tools', 'bin')}:$PATH"\n`)

    expect(await detect()).toContain('codex')
  })

  it('control: a fixture without a codex binary reports codex only if the system dirs ship one', async () => {
    installStub(join(home, '.local', 'bin'), 'claude')

    const agents = await detect()

    expect(agents).toContain('claude')
    expect(agents.includes('codex')).toBe(systemFallbackHas('codex'))
  })

  it('control: codex in a directory no PATH, profile or fallback names is not found, same as any agent', async () => {
    installStub(join(home, 'elsewhere'), 'codex')
    installStub(join(home, 'elsewhere'), 'claude')

    const agents = await detect()

    expect(agents.includes('codex')).toBe(systemFallbackHas('codex'))
    expect(agents.includes('claude')).toBe(systemFallbackHas('claude'))
  })
})

describe('client side of the SSH New-tab menu', () => {
  it('keeps codex when the relay detected it: the default disabled list does not name it', () => {
    const detected: TuiAgent[] = ['claude', 'codex']

    expect(filterEnabledTuiAgents(detected, DEFAULT_DISABLED_TUI_AGENTS)).toEqual(detected)
  })

  it('control: a disabled codex is filtered, so the filter can drop it', () => {
    expect(filterEnabledTuiAgents(['claude', 'codex'] as TuiAgent[], ['codex'])).toEqual(['claude'])
  })
})
