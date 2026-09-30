// dws characterization (a), narrowed 2026-09-30 (dws Phase 3, CTX-DET-4 / ORC-5): a committed desktop
// quit kills every in-process local PTY it hosts via killAllPty() — that is Stop of LOCAL executions
// and stays pinned. A desktop that is a client of a remote runtime sends that runtime nothing on
// quit: neither before-quit nor will-quit calls a remote runtime or names a stop-class method, and
// no other src/main module outside the RPC server's own definitions names one. Daemon-backed PTYs
// survive via disconnectDaemon (already pinned in quit-path-resource-flow-isolation.test.ts — not
// re-asserted here). LIMITATION: a source slice proves the call is present in the handler, not that
// every quit path executes it — driving will-quit would need importing src/main/index.ts with
// app.on mocked wholesale, which is deliberately not done.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const WILL_QUIT_MIN_LENGTH = 1000
const BEFORE_QUIT_MIN_LENGTH = 200

const STOP_CLASS_LITERALS = [
  'terminal.close',
  'terminal.closeTab',
  'terminal.stop',
  'terminal.stopExact',
  'terminal.sleep',
  'worktree.sleep'
]
const REMOTE_CALL_TOKENS = ['callRuntimeEnvironment(', ...STOP_CLASS_LITERALS.map((m) => `'${m}'`)]

// Why: the only src/main files allowed to name a stop-class method literal — the RPC server's own
// definitions and allowlist, never a client-side caller. Every entry needs a reason.
const STOP_LITERAL_ALLOWLIST: Record<string, string> = {
  'runtime/rpc/methods/terminal.ts': 'server-side definitions of terminal.stop/sleep/stopExact/close/closeTab',
  'runtime/rpc/methods/worktree.ts': 'server-side definition of worktree.sleep',
  'runtime/runtime-rpc.ts': 'mobile RPC allowlist naming the methods a paired client may call on this host',
  'runtime/rpc/terminal-close-attribution.ts': 'server-side attribution of an inbound close, not an outbound call'
}

// Measured at authoring 2026-09-30: 2450 non-test .ts files under src/main; floor = 90% rounded down
// to a multiple of 50. A sweep that silently stopped matching cannot read as a clean bill.
const MAIN_FILE_POPULATION_FLOOR = 2200

type LocalTeardownVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'too-short' | 'local-pty-kill-missing' | 'kill-scope-changed' | 'remote-runtime-call'
      detail: string
    }

function sliceHandler(marker: string, label: string): string {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const start = source.indexOf(marker)
  const nextHandler = start === -1 ? -1 : source.indexOf('app.on(', start + marker.length)
  if (start === -1 || nextHandler === -1) {
    throw new Error(`${label} markers not found in index.ts — update this characterization, do not delete it`)
  }
  return source.slice(start, nextHandler)
}

function readWillQuitSource(): string {
  return sliceHandler("app.on('will-quit'", 'will-quit')
}

function readBeforeQuitSource(): string {
  return sliceHandler("app.on('before-quit'", 'before-quit')
}

function readKillAllPtySource(): string {
  const source = readFileSync(join(__dirname, 'ipc', 'pty.ts'), 'utf8')
  const marker = 'export function killAllPty'
  const start = source.indexOf(marker)
  if (start === -1) {
    throw new Error('killAllPty markers not found in pty.ts — update this characterization, do not delete it')
  }
  const rest = source.slice(start)
  // Why \r-strip: a CRLF checkout (Windows) leaves a trailing \r on every split line, so a strict
  // '}' equality never matches; LF checkouts (GEX44) are unaffected either way.
  const lines = rest.split('\n').map((line) => line.replace(/\r$/, ''))
  let closingLine = lines.length
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      closingLine = i + 1
      break
    }
  }
  if (closingLine === lines.length) {
    throw new Error('killAllPty markers not found in pty.ts — update this characterization, do not delete it')
  }
  return lines.slice(0, closingLine).join('\n')
}

function stripComments(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // CRLF-safe
    .filter((line) => !line.trim().startsWith('//'))
}

// Why line-stripped, not a bare substring: the handler's own "Why:" comment above the call also
// contains the literal text killAllPty() — .includes() alone is satisfied by the comment even
// after the real call is deleted. Requiring a statement-position match closes that gap.
function hasLocalPtyKillCall(willQuit: string): boolean {
  return stripComments(willQuit).some((line) => /^\s*killAllPty\(\);?\s*$/.test(line))
}

function findRemoteCallToken(handler: string): string | null {
  const lines = stripComments(handler)
  for (const token of REMOTE_CALL_TOKENS) {
    if (lines.some((line) => line.includes(token))) {
      return token
    }
  }
  return null
}

function judgeNoRemoteStopOnQuit(handler: string): LocalTeardownVerdict {
  const token = findRemoteCallToken(handler)
  return token === null ? { ok: true } : { ok: false, reason: 'remote-runtime-call', detail: token }
}

function judgeLocalTeardown(willQuit: string, killAll: string): LocalTeardownVerdict {
  if (willQuit.length < WILL_QUIT_MIN_LENGTH) {
    return { ok: false, reason: 'too-short', detail: `${willQuit.length} chars` }
  }
  if (!hasLocalPtyKillCall(willQuit)) {
    return { ok: false, reason: 'local-pty-kill-missing', detail: 'killAllPty()' }
  }
  if (
    !killAll.includes('localProvider instanceof LocalPtyProvider') ||
    !killAll.includes('localProvider.killAll()')
  ) {
    return {
      ok: false,
      reason: 'kill-scope-changed',
      detail: 'localProvider instanceof LocalPtyProvider / localProvider.killAll()'
    }
  }
  return judgeNoRemoteStopOnQuit(willQuit)
}

function listMainSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listMainSources(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function filesNamingStopLiterals(files: Map<string, string>): string[] {
  const hits: string[] = []
  for (const [file, text] of files) {
    const lines = stripComments(text)
    if (STOP_CLASS_LITERALS.some((m) => lines.some((line) => line.includes(`'${m}'`) || line.includes(`"${m}"`)))) {
      hits.push(file)
    }
  }
  return hits.sort()
}

function readMainSources(): Map<string, string> {
  const files = new Map<string, string>()
  for (const full of listMainSources(__dirname)) {
    files.set(relative(__dirname, full).split(sep).join('/'), readFileSync(full, 'utf8'))
  }
  return files
}

describe('dws characterization (a), narrowed 2026-09-30: a desktop quit kills only the LOCAL PTYs it hosts and calls no remote runtime', () => {
  it('will-quit calls killAllPty(), which kills only the in-process LocalPtyProvider', () => {
    expect(judgeLocalTeardown(readWillQuitSource(), readKillAllPtySource())).toEqual({ ok: true })
  })

  // Positive control: a failed extraction must not pass vacuously.
  it('extracts a will-quit handler big enough to be the real one', () => {
    expect(readWillQuitSource().length).toBeGreaterThan(WILL_QUIT_MIN_LENGTH)
  })

  it('rejects a will-quit handler that no longer kills local PTYs', () => {
    // Why replaceAll: the handler's own "Why:" comment above the call also says `killAllPty()`.
    const withoutKill = readWillQuitSource().replaceAll('killAllPty()', '')
    expect(judgeLocalTeardown(withoutKill, readKillAllPtySource())).toEqual({
      ok: false,
      reason: 'local-pty-kill-missing',
      detail: 'killAllPty()'
    })
  })

  it('rejects a will-quit handler where only the real call was removed, leaving the explanatory comment', () => {
    const source = readWillQuitSource()
    const withoutRealCallOnly = source.replace(/^\s*killAllPty\(\);?\s*$/m, '')
    // Sanity: the comment's mention of killAllPty() must still be present — this drill is narrower
    // than the total-removal drill above, and would pass vacuously if it accidentally matched both.
    expect(withoutRealCallOnly).toContain('killAllPty()')
    expect(judgeLocalTeardown(withoutRealCallOnly, readKillAllPtySource())).toEqual({
      ok: false,
      reason: 'local-pty-kill-missing',
      detail: 'killAllPty()'
    })
  })

  it('rejects a killAllPty that stops scoping to the local provider', () => {
    const widenedKillAll = readKillAllPtySource().replaceAll('localProvider.killAll()', '')
    expect(judgeLocalTeardown(readWillQuitSource(), widenedKillAll)).toEqual({
      ok: false,
      reason: 'kill-scope-changed',
      detail: 'localProvider instanceof LocalPtyProvider / localProvider.killAll()'
    })
  })

  it('rejects a truncated extraction', () => {
    expect(judgeLocalTeardown('app.on(', readKillAllPtySource())).toEqual({
      ok: false,
      reason: 'too-short',
      detail: '7 chars'
    })
  })

  it('before-quit extracts a real handler and calls no remote runtime or stop method', () => {
    const beforeQuit = readBeforeQuitSource()
    expect(beforeQuit.length).toBeGreaterThan(BEFORE_QUIT_MIN_LENGTH)
    expect(judgeNoRemoteStopOnQuit(beforeQuit)).toEqual({ ok: true })
  })

  it('rejects a will-quit handler that calls a remote runtime stop', () => {
    const injected = readWillQuitSource().replace(
      /^(\s*)killAllPty\(\);?\s*$/m,
      (line) => `${line}\n  void callRuntimeEnvironment(env, 'terminal.stop', {})`
    )
    expect(injected).toContain("'terminal.stop'")
    expect(judgeLocalTeardown(injected, readKillAllPtySource())).toEqual({
      ok: false,
      reason: 'remote-runtime-call',
      detail: 'callRuntimeEnvironment('
    })
  })

  it('accepts the same text when it appears only as a comment line', () => {
    const commented = readWillQuitSource().replace(
      /^(\s*)killAllPty\(\);?\s*$/m,
      (line) => `${line}\n  // callRuntimeEnvironment(env, 'terminal.stop', {})`
    )
    expect(commented).toContain("// callRuntimeEnvironment(env, 'terminal.stop', {})")
    expect(judgeLocalTeardown(commented, readKillAllPtySource())).toEqual({ ok: true })
  })

  it('no src/main module outside the RPC server definitions names a stop-class method literal', () => {
    const files = readMainSources()
    expect(files.size).toBeGreaterThanOrEqual(MAIN_FILE_POPULATION_FLOOR)
    const hits = filesNamingStopLiterals(files)
    expect(hits).toEqual(Object.keys(STOP_LITERAL_ALLOWLIST).sort())
  })

  it('every allowlist entry has a reason and still names a stop-class literal', () => {
    const files = readMainSources()
    const hits = new Set(filesNamingStopLiterals(files))
    for (const [file, reason] of Object.entries(STOP_LITERAL_ALLOWLIST)) {
      expect(reason.trim().length, file).toBeGreaterThan(0)
      expect(hits.has(file), `${file} is stale: no stop-class literal left`).toBe(true)
    }
  })

  it('the sweep reports a quit helper that names a stop-class method', () => {
    const fake = new Map([
      ['runtime/rpc/methods/terminal.ts', "name: 'terminal.stop'"],
      ['quit-helper.ts', "await call(env, 'terminal.stop', {})"],
      ['clean.ts', "// 'terminal.stop' only in a comment\nexport const x = 1"]
    ])
    expect(filesNamingStopLiterals(fake)).toEqual(['quit-helper.ts', 'runtime/rpc/methods/terminal.ts'])
  })
})
