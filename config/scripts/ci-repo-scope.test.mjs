import { describe, expect, it } from 'vitest'
import {
  SCOPE_SOURCE,
  describeScope,
  parseRepoFlag,
  repoFromRemoteUrl,
  resolveRepoScope
} from './ci-repo-scope.mjs'

// The defect this pins, measured 2026-09-22: this checkout has `origin` = jacobo07/orca-x and
// `upstream` = stablyai/orca. An unscoped `gh run list` here returns UPSTREAM's runs -- which were
// executing on real runners while this fork had been starved for nine days. A capacity question
// asked through the ambient default can therefore only ever answer "healthy", about another repo.
const ORIGIN_URL = 'https://github.com/jacobo07/orca-x.git'
const UPSTREAM_URL = 'https://github.com/stablyai/orca'

describe('a repository scope is stated or derived, never inherited', () => {
  it('reads --repo=owner/name', () => {
    expect(parseRepoFlag(['--repo=jacobo07/orca-x'])).toBe('jacobo07/orca-x')
    expect(parseRepoFlag([])).toBeNull()
  })

  it('refuses a malformed --repo rather than passing it to the API', () => {
    expect(() => parseRepoFlag(['--repo=not-a-repo'])).toThrow(/owner\/name/)
    expect(() => parseRepoFlag(['--repo='])).toThrow(/owner\/name/)
  })

  it('parses both remote URL forms git writes', () => {
    expect(repoFromRemoteUrl(ORIGIN_URL)).toBe('jacobo07/orca-x')
    expect(repoFromRemoteUrl('git@github.com:jacobo07/orca-x.git')).toBe('jacobo07/orca-x')
    expect(repoFromRemoteUrl('https://github.com/jacobo07/orca-x')).toBe('jacobo07/orca-x')
    expect(repoFromRemoteUrl('not a url')).toBeNull()
    expect(repoFromRemoteUrl(undefined)).toBeNull()
  })

  // The whole point. `origin` is the fork these gates protect; `upstream` is the busy repo whose
  // green runs belong to somebody else.
  it('derives the fork from origin, and never the upstream it is forked from', () => {
    const scope = resolveRepoScope({ argv: [], readOriginUrl: () => ORIGIN_URL })
    expect(scope.repo).toBe('jacobo07/orca-x')
    expect(scope.repo).not.toBe(repoFromRemoteUrl(UPSTREAM_URL))
    expect(scope.source).toBe(SCOPE_SOURCE.ORIGIN_REMOTE)
  })

  it('lets an explicit --repo win over the remote', () => {
    const scope = resolveRepoScope({ argv: ['--repo=other/repo'], readOriginUrl: () => ORIGIN_URL })
    expect(scope).toEqual({ repo: 'other/repo', source: SCOPE_SOURCE.FLAG })
  })

  // Fail CLOSED. The failure being guarded is not an error -- it is a confident answer about the
  // wrong repository, which is indistinguishable from a correct one.
  it('refuses when the scope cannot be resolved instead of falling back to a default', () => {
    const threw = () => {
      throw new Error('git not on PATH')
    }
    expect(() => resolveRepoScope({ argv: [], readOriginUrl: threw })).toThrow(/--repo=owner\/name/)
    expect(() => resolveRepoScope({ argv: [], readOriginUrl: () => '' })).toThrow(/--repo=owner\/name/)
    expect(() => resolveRepoScope({ argv: [] })).toThrow(/--repo=owner\/name/)
  })

  it('names the subject and how it was resolved, so a verdict is attributable', () => {
    expect(describeScope({ repo: 'jacobo07/orca-x', source: SCOPE_SOURCE.ORIGIN_REMOTE })).toBe(
      'repo jacobo07/orca-x (resolved from origin remote)'
    )
  })
})
