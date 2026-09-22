import { execFileSync } from 'node:child_process'

// Which repository is a CI answer ABOUT?
//
// Measured 2026-09-22: this checkout has two remotes -- `origin` (jacobo07/orca-x, the fork these
// gates protect) and `upstream` (stablyai/orca). `gh` resolves an unscoped command to UPSTREAM, so
// `gh run list` here returns stablyai/orca's runs: different PR numbers, different workflows, and
// jobs actively executing on real runners. Asked "did our runners come back?", that instrument can
// only ever answer yes -- about somebody else's repository.
//
// So repository scope is never inherited from the tool's own default. It is stated (--repo=) or
// derived from `origin` explicitly, and the resolution is REPORTED beside every verdict, because a
// CI answer with no named subject is not attributable.

const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/
// Both forms git writes: https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
const REMOTE_URL = /(?:github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/

export const SCOPE_SOURCE = {
  FLAG: 'flag',
  ORIGIN_REMOTE: 'origin remote'
}

export function parseRepoFlag(argv) {
  const raw = (Array.isArray(argv) ? argv : []).find((arg) => arg.startsWith('--repo='))
  if (raw === undefined) {
    return null
  }
  const value = raw.slice('--repo='.length).trim()
  if (!OWNER_NAME.test(value)) {
    throw new Error(`--repo must be owner/name, got "${value}"`)
  }
  return value
}

export function repoFromRemoteUrl(url) {
  const match = REMOTE_URL.exec(typeof url === 'string' ? url.trim() : '')
  return match ? match[1] : null
}

/**
 * Resolve the repository this run is about, or refuse.
 *
 * There is deliberately NO fallback to the tool's ambient default. An unresolvable scope must stop
 * the command, because the failure mode it guards is not an error -- it is a confident answer about
 * the wrong repository, which reads exactly like a correct one.
 */
export function resolveRepoScope({ argv = [], readOriginUrl } = {}) {
  const flag = parseRepoFlag(argv)
  if (flag !== null) {
    return { repo: flag, source: SCOPE_SOURCE.FLAG }
  }
  let url = null
  try {
    url = typeof readOriginUrl === 'function' ? readOriginUrl() : null
  } catch {
    url = null
  }
  const derived = repoFromRemoteUrl(url)
  if (derived === null) {
    throw new Error(
      'cannot tell which repository this is about: pass --repo=owner/name. ' +
        'Refusing to fall back to the tool default, which resolves to `upstream` in a fork.'
    )
  }
  return { repo: derived, source: SCOPE_SOURCE.ORIGIN_REMOTE }
}

export function readOriginUrlFromGit(cwd = process.cwd()) {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' })
}

/** One line, printed beside every verdict, so an answer can never be misattributed. */
export function describeScope(scope) {
  return `repo ${scope.repo} (resolved from ${scope.source})`
}
