import path from 'node:path'

/** Host-independent identity of a git repo that has no usable remote. */
export type GitRootIdentity = {
  rootCommit: string
  commonDir: string
  shallow: false
}

export type GitRootIdentityNoneReason = 'unborn' | 'shallow' | 'malformed'

// Why: every argv is accepted by the relay validator and runs on Git 2.25, so no
// capability cache or relay method is needed; order is the order they are tried.
export const GIT_ROOT_PROBE_ARGV = Object.freeze({
  shallowAndCommonDir: Object.freeze(['rev-parse', '--is-shallow-repository', '--git-common-dir']),
  firstParentRoot: Object.freeze([
    'log',
    '--first-parent',
    '--max-parents=0',
    '--format=%H',
    'HEAD'
  ]),
  anyRef: Object.freeze(['for-each-ref', '--count=1', '--format=%(objectname)'])
})

export type GitRootProbeStep = { ok: true; stdout: string } | { ok: false }

/** A step is absent when it was not consulted. */
export type GitRootProbeSteps = {
  shallowAndCommonDir?: GitRootProbeStep
  firstParentRoot?: GitRootProbeStep
  anyRef?: GitRootProbeStep
}

export type GitRootProbeResult =
  | { status: 'resolved'; identity: GitRootIdentity }
  | { status: 'settled-none'; reason: GitRootIdentityNoneReason }
  | { status: 'unavailable' }

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DRIVE_LETTER_SHAPE = /^[A-Za-z]:[\\/]/

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value)
}

export function sanitizeGitRootIdentity(value: unknown): GitRootIdentity | null | undefined {
  // Why: `null` is a settled "no usable root"; dropping it would make a settled repo
  // indistinguishable from one whose probe is pending.
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as { rootCommit?: unknown; commonDir?: unknown; shallow?: unknown }
  if (
    !isObjectId(candidate.rootCommit) ||
    typeof candidate.commonDir !== 'string' ||
    candidate.commonDir.length === 0 ||
    candidate.shallow !== false
  ) {
    return undefined
  }
  return { rootCommit: candidate.rootCommit, commonDir: candidate.commonDir, shallow: false }
}

export function sanitizeGitRootIdentityNoneReason(
  value: unknown
): GitRootIdentityNoneReason | undefined {
  return value === 'unborn' || value === 'shallow' || value === 'malformed' ? value : undefined
}

export function normalizeGitCommonDir(repoPath: string, raw: string): string {
  const cleaned = raw.replace(/\r$/, '')
  // Why: shape decides semantics because an SSH host may be Windows and a local host may be posix.
  if (DRIVE_LETTER_SHAPE.test(repoPath) || DRIVE_LETTER_SHAPE.test(cleaned)) {
    return path.win32.resolve(repoPath, cleaned).replace(/\//g, '\\').toLowerCase()
  }
  return path.posix.resolve(repoPath, cleaned)
}

function outputLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
}

type ParsedShallowAndCommonDir = { shallow: boolean; commonDir: string }

function parseShallowAndCommonDir(stdout: string): ParsedShallowAndCommonDir | null {
  const [shallow, commonDir] = outputLines(stdout)
  if ((shallow !== 'true' && shallow !== 'false') || !commonDir) {
    return null
  }
  return { shallow: shallow === 'true', commonDir }
}

/** The next step the probe must run, or null when the steps already decide. */
export function nextGitRootProbeStep(
  steps: GitRootProbeSteps
): keyof typeof GIT_ROOT_PROBE_ARGV | null {
  const first = steps.shallowAndCommonDir
  if (!first) {
    return 'shallowAndCommonDir'
  }
  if (!first.ok) {
    return null
  }
  const parsed = parseShallowAndCommonDir(first.stdout)
  if (!parsed || parsed.shallow) {
    return null
  }
  const root = steps.firstParentRoot
  if (!root) {
    return 'firstParentRoot'
  }
  if (root.ok) {
    return null
  }
  return steps.anyRef ? null : 'anyRef'
}

export function classifyGitRootProbe(
  steps: GitRootProbeSteps,
  repoPath: string
): GitRootProbeResult {
  const first = steps.shallowAndCommonDir
  if (!first?.ok) {
    return { status: 'unavailable' }
  }
  const parsed = parseShallowAndCommonDir(first.stdout)
  if (!parsed) {
    return { status: 'unavailable' }
  }
  if (parsed.shallow) {
    return { status: 'settled-none', reason: 'shallow' }
  }
  const root = steps.firstParentRoot
  if (root?.ok) {
    const lines = outputLines(root.stdout)
    const [only] = lines
    if (lines.length === 1 && isObjectId(only)) {
      return {
        status: 'resolved',
        identity: {
          rootCommit: only,
          commonDir: normalizeGitCommonDir(repoPath, parsed.commonDir),
          shallow: false
        }
      }
    }
    return { status: 'settled-none', reason: 'malformed' }
  }
  const anyRef = steps.anyRef
  // Why: only an empty ref list with exit 0 proves "no commits"; a ref that exists or a
  // failed read says nothing about the repo, so it stays pending.
  if (root && !root.ok && anyRef?.ok && anyRef.stdout.trim() === '') {
    return { status: 'settled-none', reason: 'unborn' }
  }
  return { status: 'unavailable' }
}
