import { describe, expect, it } from 'vitest'
import {
  classifyGitRootProbe,
  GIT_ROOT_PROBE_ARGV,
  nextGitRootProbeStep,
  normalizeGitCommonDir,
  sanitizeGitRootIdentity,
  sanitizeGitRootIdentityNoneReason
} from './git-root-identity'

const SHA40 = 'a'.repeat(40)
const SHA64 = 'b'.repeat(64)
const ok = (stdout: string) => ({ ok: true as const, stdout })
const failed = { ok: false as const }

describe('classifyGitRootProbe', () => {
  it('resolves a 40-hex root with a normalized common dir', () => {
    expect(
      classifyGitRootProbe(
        { shallowAndCommonDir: ok('false\n.git\n'), firstParentRoot: ok(`${SHA40}\n`) },
        '/srv/r'
      )
    ).toEqual({
      status: 'resolved',
      identity: { rootCommit: SHA40, commonDir: '/srv/r/.git', shallow: false }
    })
  })

  it('resolves a 64-hex root', () => {
    const result = classifyGitRootProbe(
      { shallowAndCommonDir: ok('false\n.git\n'), firstParentRoot: ok(`${SHA64}\n`) },
      '/srv/r'
    )
    expect(result).toMatchObject({ status: 'resolved', identity: { rootCommit: SHA64 } })
  })

  it('settles shallow without consulting the root step', () => {
    expect(classifyGitRootProbe({ shallowAndCommonDir: ok('true\n.git\n') }, '/srv/r')).toEqual({
      status: 'settled-none',
      reason: 'shallow'
    })
    expect(nextGitRootProbeStep({ shallowAndCommonDir: ok('true\n.git\n') })).toBeNull()
  })

  it('settles malformed for two shas or a non-hex line', () => {
    const base = { shallowAndCommonDir: ok('false\n.git\n') }
    const two = classifyGitRootProbe({ ...base, firstParentRoot: ok(`${SHA40}\n${SHA64}\n`) }, '/r')
    expect(two).toEqual({ status: 'settled-none', reason: 'malformed' })
    const junk = classifyGitRootProbe({ ...base, firstParentRoot: ok('not-a-sha\n') }, '/r')
    expect(junk).toEqual({ status: 'settled-none', reason: 'malformed' })
    const empty = classifyGitRootProbe({ ...base, firstParentRoot: ok('') }, '/r')
    expect(empty).toEqual({ status: 'settled-none', reason: 'malformed' })
  })

  it('settles unborn only when the ref list is empty after git answered', () => {
    const base = { shallowAndCommonDir: ok('false\n.git\n'), firstParentRoot: failed }
    expect(classifyGitRootProbe({ ...base, anyRef: ok('') }, '/r')).toEqual({
      status: 'settled-none',
      reason: 'unborn'
    })
    expect(classifyGitRootProbe({ ...base, anyRef: ok(`${SHA40}\n`) }, '/r')).toEqual({
      status: 'unavailable'
    })
    expect(classifyGitRootProbe({ ...base, anyRef: failed }, '/r')).toEqual({
      status: 'unavailable'
    })
    expect(classifyGitRootProbe(base, '/r')).toEqual({ status: 'unavailable' })
  })

  it('is unavailable when the first step failed or was garbage', () => {
    expect(classifyGitRootProbe({ shallowAndCommonDir: failed }, '/r')).toEqual({
      status: 'unavailable'
    })
    expect(classifyGitRootProbe({ shallowAndCommonDir: ok('maybe\n.git\n') }, '/r')).toEqual({
      status: 'unavailable'
    })
    expect(classifyGitRootProbe({}, '/r')).toEqual({ status: 'unavailable' })
  })

  it('strips CRLF from every line', () => {
    const result = classifyGitRootProbe(
      { shallowAndCommonDir: ok('false\r\n.git\r\n'), firstParentRoot: ok(`${SHA40}\r\n`) },
      '/srv/r'
    )
    expect(result).toMatchObject({ status: 'resolved', identity: { commonDir: '/srv/r/.git' } })
  })

  it('walks the steps in order', () => {
    expect(nextGitRootProbeStep({})).toBe('shallowAndCommonDir')
    expect(nextGitRootProbeStep({ shallowAndCommonDir: ok('false\n.git\n') })).toBe(
      'firstParentRoot'
    )
    const second = { shallowAndCommonDir: ok('false\n.git\n'), firstParentRoot: failed }
    expect(nextGitRootProbeStep(second)).toBe('anyRef')
    expect(nextGitRootProbeStep({ ...second, anyRef: ok('') })).toBeNull()
  })
})

describe('normalizeGitCommonDir', () => {
  it('gives one key for a Windows main worktree and a linked worktree', () => {
    const main = normalizeGitCommonDir('C:\\x\\Repo', '.git')
    expect(normalizeGitCommonDir('C:\\x\\Repo', 'C:/x/Repo/.git')).toBe(main)
    expect(normalizeGitCommonDir('c:\\X\\repo\\sub', 'C:/x/Repo/.git')).toBe(main)
    expect(main).toBe('c:\\x\\repo\\.git')
  })

  it('gives one key for a posix main worktree and a linked worktree', () => {
    expect(normalizeGitCommonDir('/srv/r', '.git')).toBe(
      normalizeGitCommonDir('/srv/r/wt', '/srv/r/.git')
    )
  })

  it('keeps posix paths case-sensitive', () => {
    expect(normalizeGitCommonDir('/srv/r', '.git')).not.toBe(
      normalizeGitCommonDir('/srv/R', '.git')
    )
  })

  it('strips a trailing carriage return', () => {
    expect(normalizeGitCommonDir('/srv/r', '.git\r')).toBe('/srv/r/.git')
  })
})

describe('root identity sanitizers', () => {
  const valid = { rootCommit: SHA40, commonDir: '/x/.git', shallow: false as const }

  it('keeps null and a valid object', () => {
    expect(sanitizeGitRootIdentity(null)).toBeNull()
    expect(sanitizeGitRootIdentity(valid)).toEqual(valid)
    expect(sanitizeGitRootIdentity({ ...valid, rootCommit: SHA64 })).toMatchObject({
      rootCommit: SHA64
    })
  })

  it.each([
    ['missing commonDir', { rootCommit: SHA40, shallow: false }],
    ['empty commonDir', { ...valid, commonDir: '' }],
    ['shallow true', { ...valid, shallow: true }],
    ['short sha', { ...valid, rootCommit: 'abc1234' }],
    ['uppercase sha', { ...valid, rootCommit: 'A'.repeat(40) }],
    ['non-hex sha', { ...valid, rootCommit: 'g'.repeat(40) }],
    ['string', 'not-an-object'],
    ['number', 42],
    ['undefined', undefined]
  ])('drops %s', (_name, value) => {
    expect(sanitizeGitRootIdentity(value)).toBeUndefined()
  })

  it('keeps known reasons and drops the rest', () => {
    for (const reason of ['unborn', 'shallow', 'malformed'] as const) {
      expect(sanitizeGitRootIdentityNoneReason(reason)).toBe(reason)
    }
    expect(sanitizeGitRootIdentityNoneReason('exploded')).toBeUndefined()
    expect(sanitizeGitRootIdentityNoneReason(null)).toBeUndefined()
  })
})

describe('GIT_ROOT_PROBE_ARGV', () => {
  it('spells the three baseline argv exactly', () => {
    expect(GIT_ROOT_PROBE_ARGV.shallowAndCommonDir).toEqual([
      'rev-parse',
      '--is-shallow-repository',
      '--git-common-dir'
    ])
    expect(GIT_ROOT_PROBE_ARGV.firstParentRoot).toEqual([
      'log',
      '--first-parent',
      '--max-parents=0',
      '--format=%H',
      'HEAD'
    ])
    expect(GIT_ROOT_PROBE_ARGV.anyRef).toEqual([
      'for-each-ref',
      '--count=1',
      '--format=%(objectname)'
    ])
  })
})
