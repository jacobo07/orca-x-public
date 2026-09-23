import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

import {
  collectMobileProductionSources,
  evaluateSurface,
  referencedMethodNames,
  stripComments
} from './mobile-rpc-surface.mjs'
import {
  DEFAULT_MOBILE_ROOTS,
  DEFAULT_RPC_FILE,
  parseAllowlist
} from './check-mobile-capability-aperture.mjs'

const ALLOW = ['terminal.send', 'terminal.read', 'files.read']
const FLOOR = { referencedFloor: 1 }

describe('referencedMethodNames', () => {
  it('counts every quoting style a call site uses', () => {
    const found = referencedMethodNames(
      [`client.sendRequest('terminal.send')`, 'type M = "files.read" | `x.y`'],
      ALLOW
    )
    expect([...found].sort()).toEqual(['files.read', 'terminal.send'])
  })

  it('does not count a method named only in a comment', () => {
    const found = referencedMethodNames(
      ["// calls 'terminal.read' later\n/* 'files.read' */ const a = 1"],
      ALLOW
    )
    expect([...found]).toEqual([])
  })

  it('keeps a URL-bearing line from swallowing the code before it', () => {
    expect(stripComments(`fetch('https://x.test'); send('terminal.send')`)).toContain(
      "'terminal.send'"
    )
  })
})

describe('evaluateSurface', () => {
  it('green: every allowlisted method referenced or baselined', () => {
    const result = evaluateSurface({
      allowlist: ALLOW,
      referenced: new Set(['terminal.send', 'files.read']),
      baseline: new Set(['terminal.read']),
      ...FLOOR
    })
    expect(result.failures).toEqual([])
  })

  it('red: a newly unreferenced method is new debt', () => {
    const result = evaluateSurface({
      allowlist: ALLOW,
      referenced: new Set(['terminal.send']),
      baseline: new Set(['terminal.read']),
      ...FLOOR
    })
    expect(result.failures.map((f) => f.kind)).toEqual(['new-unsurfaced'])
    expect(result.newlyUnreferenced).toEqual(['files.read'])
  })

  it('red: a baselined method that gained a consumer is a stale entry', () => {
    const result = evaluateSurface({
      allowlist: ALLOW,
      referenced: new Set(ALLOW),
      baseline: new Set(['terminal.read']),
      ...FLOOR
    })
    expect(result.failures.map((f) => f.kind)).toEqual(['stale-surface-baseline'])
  })

  it('red: a sweep that matched nothing fails its floor instead of accusing everything', () => {
    const result = evaluateSurface({
      allowlist: ALLOW,
      referenced: new Set(),
      baseline: new Set(ALLOW),
      referencedFloor: 2
    })
    expect(result.failures.map((f) => f.kind)).toContain('surface-floor')
  })
})

describe('the real estate', () => {
  it('positive control: the sweep sees known consumers and the known unconsumed method', () => {
    const allowlist = parseAllowlist(fs.readFileSync(DEFAULT_RPC_FILE, 'utf8'))
    const texts = collectMobileProductionSources(DEFAULT_MOBILE_ROOTS).map((f) =>
      fs.readFileSync(f, 'utf8')
    )
    const referenced = referencedMethodNames(texts, allowlist)

    expect(texts.length).toBeGreaterThan(300)
    for (const method of [
      'terminal.subscribe',
      'terminal.unsubscribe',
      'terminal.send',
      'git.status'
    ]) {
      expect(referenced.has(method), method).toBe(true)
    }
    // Allowlisted with a host implementation, named by no mobile code (2026-09-18).
    expect(referenced.has('terminal.read')).toBe(false)
  })

  it('the CLI fails on reach-without-surface, so the verdict is wired and not only computed', () => {
    const emptyBaseline = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'surface-')), 'b.txt')
    fs.writeFileSync(emptyBaseline, '# nothing grandfathered\n')
    const script = path.join(import.meta.dirname, 'check-mobile-capability-aperture.mjs')

    const run = spawnSync(process.execPath, [script, '--surface-baseline', emptyBaseline], {
      encoding: 'utf8'
    })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('[new-unsurfaced]')
    expect(run.stderr).toContain('terminal.read')
    // Why: a real child process sweeping ~700 files; the default 30s tripped on a starved host.
  }, 120_000)

  it('never counts a test file as a consumer', () => {
    const files = collectMobileProductionSources(DEFAULT_MOBILE_ROOTS)
    expect(files.some((f) => /\.test\.|\.spec\./.test(path.basename(f)))).toBe(false)
  })
})
