#!/usr/bin/env node
// D-10: "federation-owned" is DERIVED from git, never hand-typed: the union of paths changed by the
// first-parent, non-merge commits in <P0 merge>..<federation head>. This sweep proves this branch edited none.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from './check-mobile-capability-aperture.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_BASE = 'a97d3bcc0'
export const DEFAULT_HEAD = 'orca-x/agent-federation'
export const DEFAULT_ALLOW_LIST = 'docs/dws/phase-7-federation-shared-touches.json'
export const ALLOW_LIST_SCHEMA = 'orca.dws-federation-shared-touches/1'
// Measured 97 on 2026-09-30. Not pinned to 97 so a legitimate federation-side re-derivation does not
// spuriously BLOCK, while a blind sweep (0-5 paths) still does.
export const OWNED_PATH_FLOOR = 90
const MIN_REASON_LENGTH = 10

// Federation's orchestration reviews/approvals, conversation drivers, MCP bridge and codex/claude drivers.
export const SUBSYSTEM_PREFIXES = Object.freeze([
  'src/main/runtime/orchestration/',
  'src/main/conversation/',
  'src/main/claude/',
  'src/main/codex/',
  'src/main/ipc/agent-federation',
  'src/main/runtime/rpc/methods/orchestration'
])

export function createGitRunner(gitExe = process.env.GIT_EXE || 'git', cwd = process.cwd()) {
  return (args) =>
    execFileSync(gitExe, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

export function deriveFederationOwnedPaths({ runGit, base, head }) {
  const baseId = lines(runGit(['rev-parse', '--verify', `${base}^{commit}`]))[0]
  const headId = lines(runGit(['rev-parse', '--verify', `${head}^{commit}`]))[0]
  const commits = lines(runGit(['rev-list', '--first-parent', '--no-merges', `${baseId}..${headId}`]))
  const owned = new Set()
  for (const commit of commits) {
    for (const p of lines(runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', commit]))) {
      owned.add(p)
    }
  }
  return { paths: [...owned].sort(), commits }
}

// --no-renames is mandatory: rename detection would hide the OLD path of a moved federation file.
export function listChangedPaths({ runGit, head }) {
  return lines(runGit(['diff', '--no-renames', '--name-only', `${head}..HEAD`])).sort()
}

export function readChangedPathsFile(file) {
  return lines(readFileSync(file, 'utf8')).sort()
}

function shaMatches(a, b) {
  return a.startsWith(b) || b.startsWith(a)
}

export function validateAllowList(allowList) {
  for (const e of allowList) {
    if (!e || typeof e.path !== 'string' || !e.path) return `entry without a path`
    if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON_LENGTH) return `${e.path}: reason missing or shorter than ${MIN_REASON_LENGTH}`
    if (!Array.isArray(e.commits) || e.commits.length === 0 || e.commits.some((c) => typeof c !== 'string' || c.length < 7)) {
      return `${e.path}: commits must be a non-empty list of 7+ character shas`
    }
  }
  return null
}

export function judgeIntersection({ owned, changed, allowList, touchingCommitsByPath = {} }) {
  const malformed = validateAllowList(allowList)
  if (malformed) {
    return { verdict: 'BLOCKED', rung: 'allow-list-malformed', detail: malformed, intersect: [], allowed: [], violations: [] }
  }
  const ownedSet = new Set(owned)
  const intersect = changed.filter((p) => ownedSet.has(p))
  const allowed = []
  const violations = []
  for (const p of intersect) {
    const found = allowList.find((e) => e.path === p)
    if (!found) {
      violations.push({ path: p, reason: 'not-allow-listed' })
      continue
    }
    const unlisted = (touchingCommitsByPath[p] || []).filter((c) => !found.commits.some((l) => shaMatches(c, l)))
    if (unlisted.length) violations.push({ path: p, reason: 'unlisted-touching-commit' })
    else allowed.push({ path: p, commits: found.commits, reason: found.reason })
  }
  const intersectSet = new Set(intersect)
  for (const e of allowList) {
    if (!intersectSet.has(e.path)) violations.push({ path: e.path, reason: 'stale-allow-list-entry' })
  }
  for (const p of changed) {
    if (!ownedSet.has(p) && SUBSYSTEM_PREFIXES.some((prefix) => p.startsWith(prefix))) {
      violations.push({ path: p, reason: 'subsystem-prefix' })
    }
  }
  return { verdict: violations.length ? 'VIOLATION' : 'OK', intersect, allowed, violations }
}

function loadAllowList(spec) {
  if (spec === 'none') return []
  const file = spec || join(REPO, DEFAULT_ALLOW_LIST)
  // A missing default file is an empty allow-list, so every intersection is a violation (fail closed).
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed.schema !== ALLOW_LIST_SCHEMA || !Array.isArray(parsed.entries)) {
    return [{ path: '', reason: '', commits: [] }]
  }
  return parsed.entries
}

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, head: DEFAULT_HEAD, changedPathsFile: null, allowList: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') out.base = argv[++i]
    else if (a === '--head') out.head = argv[++i]
    else if (a === '--changed-paths-file') out.changedPathsFile = argv[++i]
    else if (a === '--allow-list') out.allowList = argv[++i]
  }
  return out
}

function informational({ runGit, base, head, changed, ownedSet }) {
  const out = []
  let p0 = []
  try {
    p0 = lines(runGit(['diff-tree', '--cc', '--no-commit-id', '--name-only', '-r', base]))
  } catch {
    p0 = []
  }
  out.push(`INFO p0-conflict-resolutions ${p0.length}`)
  for (const p of p0) out.push(`INFO p0-conflict ${p}`)
  let wide = new Set()
  try {
    wide = new Set(lines(runGit(['diff', '--no-renames', '--name-only', base, head])))
  } catch {
    wide = new Set()
  }
  for (const p of changed) {
    if (wide.has(p) && !ownedSet.has(p)) out.push(`INFO wider-shared-not-federation-owned ${p}`)
  }
  return out
}

export function runOwnershipSweep({ runGit, argv, floor = OWNED_PATH_FLOOR }) {
  const args = parseArgs(argv)
  const out = []
  const blocked = (rung, reason) => {
    out.push('OWNERSHIP owned=0 changed=0 intersect=0 allowed=0 violations=0 verdict=BLOCKED')
    out.push(`BLOCKED ${rung} ${reason}`)
    return { code: 2, out, rung }
  }
  try {
    runGit(['rev-parse', '--verify', `${args.head}^{commit}`])
  } catch {
    return blocked('head-unresolvable', args.head)
  }
  try {
    runGit(['merge-base', '--is-ancestor', args.base, 'HEAD'])
  } catch {
    return blocked('base-not-ancestor', `${args.base} is not an ancestor of HEAD`)
  }
  const { paths: owned } = deriveFederationOwnedPaths({ runGit, base: args.base, head: args.head })
  if (owned.length < floor) {
    return blocked('owned-below-floor', `${owned.length} < ${floor}`)
  }
  const changed = args.changedPathsFile ? readChangedPathsFile(args.changedPathsFile) : listChangedPaths({ runGit, head: args.head })
  const touchingCommitsByPath = {}
  if (!args.changedPathsFile) {
    const ownedSet = new Set(owned)
    for (const p of changed.filter((c) => ownedSet.has(c))) {
      touchingCommitsByPath[p] = lines(runGit(['log', '--format=%h', `${args.head}..HEAD`, '--', p]))
    }
  } else {
    // Synthetic changed set: no commits exist to name, so sha keying cannot apply to it.
    for (const e of loadAllowList(args.allowList)) touchingCommitsByPath[e.path] = []
  }
  const judged = judgeIntersection({ owned, changed, allowList: loadAllowList(args.allowList), touchingCommitsByPath })
  if (judged.verdict === 'BLOCKED') return blocked(judged.rung, judged.detail)
  out.push(
    `OWNERSHIP owned=${owned.length} changed=${changed.length} intersect=${judged.intersect.length} allowed=${judged.allowed.length} violations=${judged.violations.length} verdict=${judged.verdict}`
  )
  for (const a of judged.allowed) out.push(`ALLOWED ${a.path} ${a.commits.join(',')} ${a.reason}`)
  for (const v of judged.violations) {
    const shas = (touchingCommitsByPath[v.path] || []).join(',') || '-'
    out.push(`VIOLATION ${v.path} ${shas} ${v.reason}`)
  }
  out.push(...informational({ runGit, base: args.base, head: args.head, changed, ownedSet: new Set(owned) }))
  return { code: judged.verdict === 'OK' ? 0 : 1, out }
}

export function main(argv = process.argv.slice(2)) {
  const { code, out } = runOwnershipSweep({ runGit: createGitRunner(), argv })
  process.stdout.write(out.join('\n') + '\n')
  return code
}

if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
