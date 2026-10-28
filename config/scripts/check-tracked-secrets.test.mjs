import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  RULES,
  applyExemptions,
  drillSamples,
  findSecrets,
  fingerprint,
  main,
  selfTestFailures
} from './check-tracked-secrets.mjs'

// Every credential here is synthetic and assembled at runtime (drillSamples), so this file never
// carries a key-shaped literal of its own.

const samples = drillSamples()

describe('findSecrets', () => {
  it.each(RULES.map((rule) => rule.id))('catches a %s', (ruleId) => {
    // The RED half: a rule that silently stopped matching would report exactly what a clean tree does.
    const hits = findSecrets([{ path: 'src/leak.ts', source: `const k = "${samples[ruleId]}"` }])
    expect(hits.map((hit) => hit.rule)).toContain(ruleId)
  })

  it.each(RULES.map((rule) => rule.id).filter((id) => id !== 'private-key'))(
    'catches a %s glued to an identifier by an underscore',
    (ruleId) => {
      const hits = findSecrets([{ path: 'src/leak.ts', source: `TOKEN_${samples[ruleId]}.end` }])
      expect(hits.map((hit) => hit.rule)).toContain(ruleId)
    }
  )

  it('passes code that names credential formats without carrying one', () => {
    // The GREEN half, beside the red one: a gate that flagged everything would satisfy the cases above.
    const header = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
    const benign = [
      `if (text.startsWith('${header}')) return 'openssh'`,
      "const sessionId = 'sk-local-1'",
      "const prefix = 'AKIA'",
      "const short = 'ghp_abc'",
      "const tokenKind = 'xoxb'"
    ].join('\n')
    expect(findSecrets([{ path: 'src/ssh/identity.ts', source: benign }])).toEqual([])
  })

  it('reports the line and never the value, because CI logs are public', () => {
    const source = `line one\nline two\nconst k = "${samples['github-token']}"\n`
    const [hit] = findSecrets([{ path: 'src\\win\\leak.ts', source }])
    expect(hit).toMatchObject({ path: 'src/win/leak.ts', line: 3, rule: 'github-token' })
    expect(JSON.stringify(hit)).not.toContain(samples['github-token'])
  })
})

describe('applyExemptions', () => {
  const fixture = { path: 'src/redactor.test.ts', source: `"${samples['slack-token']}"` }
  const pinned = {
    path: 'src/redactor.test.ts',
    rule: 'slack-token',
    sha256: fingerprint(samples['slack-token']),
    reason: 'fake'
  }

  it('lets a pinned fake fixture through', () => {
    expect(applyExemptions(findSecrets([fixture]), [pinned])).toEqual({ offenders: [], stale: [] })
  })

  it('still fails a real key added to the same fixture file', () => {
    const real = `${samples['slack-token']}9`
    const file = { ...fixture, source: `${fixture.source}\n"${real}"` }
    const { offenders } = applyExemptions(findSecrets([file]), [pinned])
    expect(offenders.map((offender) => offender.sha256)).toEqual([fingerprint(real)])
  })

  it('fails an exemption whose fixture is gone, so the list cannot rot', () => {
    expect(applyExemptions([], [pinned]).stale).toEqual([pinned])
  })
})

describe('selfTestFailures', () => {
  it('is clean for the shipped rules', () => {
    expect(selfTestFailures()).toEqual([])
  })

  it('names a rule that stopped matching', () => {
    const broken = RULES.map((rule) =>
      rule.id === 'anthropic-key' ? { ...rule, re: /(?!)/g } : rule
    )
    expect(selfTestFailures(broken)).toEqual([
      'rule anthropic-key no longer matches its own drill sample'
    ])
  })
})

describe('main', () => {
  let repo

  afterEach(() => {
    if (repo) {
      rmSync(repo, { recursive: true, force: true })
    }
    repo = undefined
  })

  function seedRepo(files) {
    repo = mkdtempSync(path.join(tmpdir(), 'tracked-secrets-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(repo, name), content)
    }
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: repo })
    return repo
  }

  function capture() {
    const lines = []
    return { lines, log: { log: (line) => lines.push(line), error: (line) => lines.push(line) } }
  }

  it('fails a tracked key and keeps the value out of the output', async () => {
    const root = seedRepo({
      'clean.ts': 'export const a = 1\n',
      'leak.ts': `export const k = "${samples['npm-token']}"\n`
    })
    const { lines, log } = capture()
    expect(await main(root, log, { trackedFloor: 1, exemptions: [] })).toBe(1)
    expect(lines.join('\n')).toContain('leak.ts:1 looks like a npm-token')
    expect(lines.join('\n')).not.toContain(samples['npm-token'])
  })

  it('passes the same repo without the key', async () => {
    const root = seedRepo({ 'clean.ts': 'export const a = 1\n' })
    const { log } = capture()
    expect(await main(root, log, { trackedFloor: 1, exemptions: [] })).toBe(0)
  })

  it('ignores an untracked key: the gate judges what ships', async () => {
    const root = seedRepo({ 'clean.ts': 'export const a = 1\n' })
    writeFileSync(path.join(root, 'scratch.ts'), `"${samples['npm-token']}"`)
    const { log } = capture()
    expect(await main(root, log, { trackedFloor: 1, exemptions: [] })).toBe(0)
  })

  it('refuses a sweep that sees fewer files than the floor', async () => {
    const root = seedRepo({ 'clean.ts': 'export const a = 1\n' })
    const { lines, log } = capture()
    expect(await main(root, log, { trackedFloor: 2, exemptions: [] })).toBe(2)
    expect(lines.join('\n')).toContain('stopped seeing code')
  })
})
