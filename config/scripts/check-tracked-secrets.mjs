import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)

// No credential ships in a tracked file.
//
// Until this gate the only secret control was the operator's own pre-commit hook, which lives
// outside the repo and outside CI, so a key pasted into evidence, a fixture or a log copy reached a
// PR with nothing to stop it (threat model T5/D6, docs/dws/threat-model-2026-10-18.md).
//
// The rules are prefix-anchored provider formats on purpose. src/main/observability/redactor.ts
// over-matches (any `sk-` run, any JWT) because a scrubber that redacts too much loses nothing;
// a gate that flags too much gets switched off. Tracked files only: a tracked file is what ships.
// History is out of scope — a key that ever landed must be rotated, not scanned for.

// Assembled so this file carries no key-shaped literal for secret scanners (this one included).
const PEM_HEADER = ['-----BEGIN', '(?:[A-Z0-9]+ )*PRIVATE', 'KEY-----'].join(' ')

export const RULES = [
  {
    id: 'private-key',
    // Header plus body, real or `\n`-escaped: code that DETECTS a key names the header alone.
    re: new RegExp(`${PEM_HEADER}(?:\\r?\\n|\\\\n)[A-Za-z0-9+/=]{40,}`, 'g')
  },
  // Alphanumeric lookarounds, not `\b`: `\b` counts `_` as a word character, so `TOKEN_ghp_…` escaped it.
  { id: 'aws-access-key-id', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  {
    id: 'github-token',
    re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g
  },
  { id: 'gitlab-token', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'anthropic-key', re: /(?<![A-Za-z0-9])sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{60,}/g },
  // `T3BlbkFJ` is base64 "OpenAI", embedded in every issued key; it keeps arbitrary `sk-` ids out.
  { id: 'openai-key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]{10,}/g },
  { id: 'slack-token', re: /(?<![A-Za-z0-9])xox[abposr]-\d{6,}-[0-9A-Za-z-]{10,}/g },
  { id: 'google-api-key', re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { id: 'stripe-live-key', re: /(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{20,}/g },
  { id: 'npm-token', re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g }
]

const REDACTOR_TEST = 'src/main/observability/redactor.test.ts'

/** Known fake credentials, pinned to the exact value. Keyed by fingerprint rather than path so a
 *  real key added next to a fixture still fails; an entry that no longer matches fails as stale. */
export const EXEMPTIONS = [
  {
    path: REDACTOR_TEST,
    rule: 'private-key',
    sha256: '76e2d5c8a97fb640',
    reason: 'redactor input'
  },
  {
    path: REDACTOR_TEST,
    rule: 'aws-access-key-id',
    sha256: '1a5d44a2dca19669',
    reason: "AWS's documented example key, redactor input"
  },
  {
    path: REDACTOR_TEST,
    rule: 'github-token',
    sha256: 'f6b0ec10912857ef',
    reason: 'redactor input'
  },
  {
    path: REDACTOR_TEST,
    rule: 'slack-token',
    sha256: '9787577eb430f396',
    reason: 'redactor input'
  },
  {
    path: 'tests/e2e/helpers/local-https-test-certificate.ts',
    rule: 'private-key',
    sha256: 'bf98aa778bdf08d4',
    reason: 'self-signed localhost identity for e2e, see the file header'
  }
]

// Above every tracked text file today (largest: a 7 MB vendored xterm patch); a skip is a blind spot.
const MAX_BYTES = 32 * 1024 * 1024
const TRACKED_FLOOR = 10_000

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Files are `{ path, source }`. Findings never carry the value, only its fingerprint: CI logs are public. */
export function findSecrets(files) {
  const findings = []
  for (const file of files) {
    const filePath = file.path.split(path.sep).join('/')
    for (const rule of RULES) {
      for (const match of file.source.matchAll(rule.re)) {
        findings.push({
          path: filePath,
          line: file.source.slice(0, match.index).split('\n').length,
          rule: rule.id,
          sha256: fingerprint(match[0]),
          preview: `${match[0].slice(0, 6)}…`
        })
      }
    }
  }
  return findings
}

export function applyExemptions(findings, exemptions = EXEMPTIONS) {
  const key = (entry) => `${entry.path}|${entry.rule}|${entry.sha256}`
  const exempt = new Set(exemptions.map(key))
  const seen = new Set(findings.map(key))
  return {
    offenders: findings.filter((finding) => !exempt.has(key(finding))),
    stale: exemptions.filter((entry) => !seen.has(key(entry)))
  }
}

/** One synthetic credential per rule, assembled at runtime so no source file matches itself. */
export function drillSamples() {
  const pad = (n, c) => c.repeat(n)
  const header = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
  return {
    'private-key': `${header}\n${pad(64, 'M')}`,
    'aws-access-key-id': `AK${'IA'}${pad(16, 'Q')}`,
    'github-token': `gh${'p_'}${pad(36, 'x')}`,
    'gitlab-token': `gl${'pat-'}${pad(20, 'x')}`,
    'anthropic-key': `sk-${'ant-'}api03-${pad(80, 'x')}`,
    'openai-key': `sk-${'proj-'}${pad(20, 'x')}T3Blbk${'FJ'}${pad(20, 'y')}`,
    'slack-token': `xo${'xb-'}1234567890-${pad(12, 'x')}`,
    'google-api-key': `AI${'za'}${pad(35, 'x')}`,
    'stripe-live-key': `sk${'_live_'}${pad(24, 'x')}`,
    'npm-token': `np${'m_'}${pad(36, 'x')}`
  }
}

/** Positive control on every rule: a rule that stopped matching reports what a clean tree reports. */
export function selfTestFailures(rules = RULES) {
  const samples = drillSamples()
  const failures = []
  for (const rule of rules) {
    const sample = samples[rule.id] ?? ''
    if (![...sample.matchAll(rule.re)].length) {
      failures.push(`rule ${rule.id} no longer matches its own drill sample`)
    }
  }
  return failures
}

function readTracked(root, relative) {
  const full = path.join(root, relative)
  try {
    if (statSync(full).size > MAX_BYTES) {
      return { skipped: 'large' }
    }
    const buffer = readFileSync(full)
    if (buffer.subarray(0, 8000).includes(0)) {
      return { skipped: 'binary' }
    }
    return { source: buffer.toString('utf8') }
  } catch {
    // Deleted in the working tree but still in the index: nothing on disk to ship.
    return { skipped: 'unreadable' }
  }
}

export async function main(
  root = process.cwd(),
  log = console,
  { trackedFloor = TRACKED_FLOOR, exemptions = EXEMPTIONS } = {}
) {
  const drill = selfTestFailures()
  if (drill.length > 0) {
    log.error('❌  check-tracked-secrets: the instrument is broken:')
    for (const failure of drill) {
      log.error(`    - ${failure}`)
    }
    return 2
  }

  let tracked
  try {
    const { stdout } = await run('git', ['ls-files', '-z'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024
    })
    tracked = stdout.split('\0').filter(Boolean)
  } catch (error) {
    log.error(`❌  check-tracked-secrets: could not list tracked files: ${error?.message ?? error}`)
    return 2
  }
  if (tracked.length < trackedFloor) {
    log.error(
      `❌  check-tracked-secrets: git lists ${tracked.length} tracked files, expected at least ${trackedFloor}; the sweep may have stopped seeing code`
    )
    return 2
  }

  const files = []
  const skipped = { large: 0, binary: 0, unreadable: 0 }
  for (const relative of tracked) {
    const result = readTracked(root, relative)
    if (result.skipped) {
      skipped[result.skipped] += 1
    } else {
      files.push({ path: relative, source: result.source })
    }
  }

  const { offenders, stale } = applyExemptions(findSecrets(files), exemptions)
  const aperture = `${files.length} tracked text files read (skipped ${skipped.binary} binary, ${skipped.large} over ${MAX_BYTES / 1024 / 1024} MB, ${skipped.unreadable} missing)`
  if (offenders.length > 0 || stale.length > 0) {
    log.error(`❌  check-tracked-secrets (${aperture}):`)
    for (const offender of offenders) {
      log.error(
        `    - ${offender.path}:${offender.line} looks like a ${offender.rule} (${offender.preview} sha256:${offender.sha256}). Remove and rotate it; a fake fixture needs an EXEMPTIONS entry with a reason.`
      )
    }
    for (const entry of stale) {
      log.error(
        `    - stale exemption ${entry.path} ${entry.rule} sha256:${entry.sha256} matches nothing; delete the entry`
      )
    }
    return 1
  }
  log.log(
    `✅  check-tracked-secrets: no credential in ${aperture}; ${RULES.length} rules drilled, ${exemptions.length} pinned fixtures.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
