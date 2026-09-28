// dws characterization (a), local-quit half: a committed desktop quit kills every in-process local
// PTY it hosts via killAllPty(); daemon-backed PTYs survive via disconnectDaemon (already pinned in
// quit-path-resource-flow-isolation.test.ts — not re-asserted here). Phase 3 inverts for a desktop
// that is a client of a remote runtime. LIMITATION: a source slice proves the call is present in the
// handler, not that every quit path executes it — driving will-quit would need importing
// src/main/index.ts with app.on mocked wholesale, which is deliberately not done.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WILL_QUIT_MIN_LENGTH = 1000

type LocalTeardownVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'too-short' | 'local-pty-kill-missing' | 'kill-scope-changed'
      detail: string
    }

function readWillQuitSource(): string {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const marker = "app.on('will-quit'"
  const start = source.indexOf(marker)
  const nextHandler = start === -1 ? -1 : source.indexOf('app.on(', start + marker.length)
  if (start === -1 || nextHandler === -1) {
    throw new Error('will-quit markers not found in index.ts — update this characterization, do not delete it')
  }
  return source.slice(start, nextHandler)
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

// Why line-stripped, not a bare substring: the handler's own "Why:" comment above the call also
// contains the literal text killAllPty() — .includes() alone is satisfied by the comment even
// after the real call is deleted. Requiring a statement-position match closes that gap.
function hasLocalPtyKillCall(willQuit: string): boolean {
  const withoutComments = willQuit
    .split('\n')
    .map((line) => line.replace(/\r$/, '')) // CRLF-safe, mirrors readKillAllPtySource
    .filter((line) => !line.trim().startsWith('//'))
  return withoutComments.some((line) => /^\s*killAllPty\(\);?\s*$/.test(line))
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
  return { ok: true }
}

describe('dws characterization (a): a committed desktop quit kills the local PTYs it hosts — Phase 3 inverts', () => {
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
})
