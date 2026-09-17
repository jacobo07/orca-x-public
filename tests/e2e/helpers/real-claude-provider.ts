import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { freemem } from 'node:os'
import path from 'node:path'

// Preconditions and integrity evidence for opt-in tests that drive a real, already
// logged-in Claude Code. Nothing here writes to the provider's configuration.

export type RealClaudeConfig = {
  fixture: string
  home: string
  bin: string
  /** Fixture paths the user's own global hooks rewrite on every session start. */
  fixtureIgnore: ReadonlySet<string>
}

export type RealClaudePreflight =
  | { ready: true; config: RealClaudeConfig; version: string }
  | { ready: false; reason: string }

const MIN_FREE_BYTES = 1.5 * 1024 ** 3

function trustKey(folder: string): string {
  return path.resolve(folder).replace(/\\/g, '/')
}

function trustedFolders(home: string): string[] {
  const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as {
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>
  }
  return Object.entries(config.projects ?? {})
    .filter(([, project]) => project?.hasTrustDialogAccepted === true)
    .map(([folder]) => folder)
    .sort()
}

// Each blocker keeps its own name so a skipped run says which precondition was absent.
export function preflightRealClaude(env: NodeJS.ProcessEnv): RealClaudePreflight {
  if (env.ORCA_E2E_REAL_CLAUDE_RESUME !== '1') {
    return { ready: false, reason: 'NOT_OPTED_IN: set ORCA_E2E_REAL_CLAUDE_RESUME=1' }
  }
  const fixture = env.ORCA_E2E_REAL_CLAUDE_FIXTURE ?? ''
  const home = env.ORCA_E2E_REAL_CLAUDE_HOME ?? ''
  const bin = env.ORCA_E2E_REAL_CLAUDE_BIN ?? ''
  if (!bin || !existsSync(bin)) {
    return { ready: false, reason: 'CLAUDE_NOT_INSTALLED: ORCA_E2E_REAL_CLAUDE_BIN is not a file' }
  }
  if (!home || !existsSync(path.join(home, '.claude', '.credentials.json'))) {
    return { ready: false, reason: 'NOT_AUTHENTICATED: no Claude credentials under the given home' }
  }
  if (!fixture || !existsSync(fixture) || !trustedFolders(home).includes(trustKey(fixture))) {
    return { ready: false, reason: 'NO_TRUSTED_FOLDER: the fixture is not already trusted' }
  }
  if (freemem() < MIN_FREE_BYTES) {
    return { ready: false, reason: `RESOURCE: ${Math.round(freemem() / 1024 ** 2)} MB free` }
  }
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
  const fixtureIgnore = new Set(
    (env.ORCA_E2E_REAL_CLAUDE_FIXTURE_IGNORE ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/\\/g, '/'))
      .filter(Boolean)
  )
  return { ready: true, config: { fixture, home, bin, fixtureIgnore }, version }
}

function sha256(file: string): string {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent'
}

function listTree(root: string, ignored: ReadonlySet<string>, prefix = ''): string[] {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name)
    if (ignored.has(rel.replace(/\\/g, '/'))) {
      return [`${rel} (written by the user's own hooks; not compared)`]
    }
    return entry.isDirectory()
      ? [`${rel}/`, ...listTree(root, ignored, rel)]
      : [`${rel} ${statSync(path.join(root, rel)).size} ${sha256(path.join(root, rel))}`]
  })
}

function orcaHookEntries(home: string): string {
  const settings = JSON.parse(
    readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
  ) as {
    hooks?: Record<string, { hooks?: { args?: string[] }[] }[]>
  }
  return Object.entries(settings.hooks ?? {})
    .flatMap(([event, matchers]) =>
      matchers.flatMap((matcher) =>
        (matcher.hooks ?? [])
          .filter((hook) => (hook.args ?? []).some((arg) => arg.includes('.orca')))
          .map((hook) => `${event}:${JSON.stringify(hook.args)}`)
      )
    )
    .sort()
    .join('\n')
}

// Fields whose change would mean the test mutated the user's trust, login or hooks, or the
// fixture's files. Claude rewrites other ~/.claude.json fields on every start by design.
export function captureRealClaudeIntegrity(config: RealClaudeConfig): Record<string, string> {
  return {
    fixture: listTree(config.fixture, config.fixtureIgnore).join('\n'),
    trusted: trustedFolders(config.home).join('\n'),
    credentials: sha256(path.join(config.home, '.claude', '.credentials.json')),
    orcaHooks: orcaHookEntries(config.home)
  }
}

export function claudeTranscriptDir(config: RealClaudeConfig): string {
  const slug = path.resolve(config.fixture).replace(/[^A-Za-z0-9]/g, '-')
  return path.join(config.home, '.claude', 'projects', slug)
}

export function listTranscripts(config: RealClaudeConfig): string[] {
  const dir = claudeTranscriptDir(config)
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
    : []
}

export type ClaudeProcess = { pid: number; commandLine: string }

// Why CIM: the resumed provider's argv is the only direct evidence of which session was asked for.
export function listClaudeProcesses(bin: string): ClaudeProcess[] {
  const name = path.basename(bin).replace(/'/g, "''")
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
    ],
    { encoding: 'utf8' }
  )
  return out
    .split(/\r?\n/)
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [pid, ...rest] = line.split('\t')
      return { pid: Number(pid), commandLine: rest.join('\t') }
    })
}
