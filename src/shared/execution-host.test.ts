import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  parseExecutionHostId,
  requestedExecutionHostScope,
  resolveExecutionHostScope,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from './execution-host'

describe('execution host identity', () => {
  // Why: the navigator cases below replace globalThis.navigator; restore it after
  // each test so the stub can't bleed into the rest of the suite.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes local, SSH, and runtime host ids', () => {
    expect(parseExecutionHostId('local')).toEqual({ kind: 'local', id: 'local' })
    expect(parseExecutionHostId(toSshExecutionHostId('win vm'))).toEqual({
      kind: 'ssh',
      id: 'ssh:win%20vm',
      targetId: 'win vm'
    })
    expect(parseExecutionHostId(toRuntimeExecutionHostId('prod/server'))).toEqual({
      kind: 'runtime',
      id: 'runtime:prod%2Fserver',
      environmentId: 'prod/server'
    })
  })

  it('labels the local host by platform and by navigator detection', () => {
    expect(getLocalExecutionHostLabel('darwin')).toBe('Local Mac')
    expect(getLocalExecutionHostLabel('win32')).toBe('Local Windows')
    expect(getLocalExecutionHostLabel('linux')).toBe('Local Linux')
    expect(getLocalExecutionHostLabel('freebsd')).toBe('This computer')

    // With no explicit platform, the label is derived from navigator.userAgent
    // (the path the live host-selector dialog uses).
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Windows')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Linux')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(getLocalExecutionHostLabel()).toBe('Local Mac')

    // Non-matching userAgent falls through to process.platform; compare against the
    // explicit-platform label so the assertion is deterministic on any CI OS.
    vi.stubGlobal('navigator', { userAgent: 'totally-unknown-agent' })
    expect(getLocalExecutionHostLabel()).toBe(getLocalExecutionHostLabel(process.platform))
  })

  // Superseded characterization: until 2026-09-20 an unresolvable value fell back to
  // the all-hosts scope, so a stale or corrupt host id widened a one-host request into
  // a fan-out. Absence still defaults; a parse failure now refuses.
  it('separates an absent scope from one that cannot be resolved', () => {
    expect(resolveExecutionHostScope(null)).toEqual({ kind: 'absent' })
    expect(resolveExecutionHostScope('   ')).toEqual({ kind: 'absent' })
    expect(resolveExecutionHostScope('all')).toEqual({
      kind: 'scope',
      scope: ALL_EXECUTION_HOSTS_SCOPE
    })
    expect(resolveExecutionHostScope('ssh:dev%20box')).toEqual({
      kind: 'scope',
      scope: 'ssh:dev%20box'
    })
    expect(resolveExecutionHostScope('bogus')).toEqual({ kind: 'unresolvable', value: 'bogus' })
    expect(resolveExecutionHostScope('ssh:')).toEqual({ kind: 'unresolvable', value: 'ssh:' })
    // An incomplete percent escape makes decodeURIComponent throw.
    expect(resolveExecutionHostScope('ssh:%E0%A4%A')).toEqual({
      kind: 'unresolvable',
      value: 'ssh:%E0%A4%A'
    })
  })

  it('never widens an unresolvable scope to all hosts', () => {
    // Absence is the listing default and stays the all-hosts view.
    expect(normalizeExecutionHostScope(null)).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    // Explicitly asking for every host still works — that is the path this guards.
    expect(normalizeExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(normalizeExecutionHostScope('ssh:dev%20box')).toBe('ssh:dev%20box')
    // A value that is not a host is refused, never upgraded.
    expect(normalizeExecutionHostScope('bogus')).toBeNull()
    expect(normalizeExecutionHostScope('ssh:')).toBeNull()
    expect(normalizeExecutionHostScope('ssh:%E0%A4%A')).toBeNull()
  })

  it('defaults an omitted scope request to this host, not a fan-out', () => {
    expect(requestedExecutionHostScope(undefined)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(requestedExecutionHostScope(null)).toBe(LOCAL_EXECUTION_HOST_ID)
    // An empty string carries no host, so it is absence and not a request to fan out.
    expect(requestedExecutionHostScope('')).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(requestedExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE)
    expect(requestedExecutionHostScope('ssh:dev%20box')).toBe('ssh:dev%20box')
    expect(requestedExecutionHostScope('bogus')).toBeNull()
  })

  it('normalizes visible host id arrays', () => {
    expect(normalizeVisibleExecutionHostIds(null)).toBeNull()
    expect(normalizeVisibleExecutionHostIds([])).toBeNull()
    expect(normalizeVisibleExecutionHostIds(['local', 'bogus', 'ssh:win%20vm', 'local'])).toEqual([
      'local',
      'ssh:win%20vm'
    ])
  })

  it('normalizes host order arrays', () => {
    expect(normalizeExecutionHostOrder(null)).toEqual([])
    expect(normalizeExecutionHostOrder([])).toEqual([])
    expect(normalizeExecutionHostOrder(['ssh:win%20vm', 'bogus', 'local', 'ssh:win%20vm'])).toEqual(
      ['ssh:win%20vm', 'local']
    )
  })

  it('derives repo ownership from SSH connection ids', () => {
    expect(getRepoExecutionHostId({ connectionId: null })).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(getRepoExecutionHostId({ connectionId: 'ssh-target-1' })).toBe('ssh:ssh-target-1')
  })

  it('prefers explicit worktree ownership before repo and focused-host fallbacks', () => {
    expect(
      getWorktreeExecutionHostId(
        { hostId: 'runtime:workspace-owner' },
        { connectionId: 'repo-owner' },
        'runtime:focused-host'
      )
    ).toBe('runtime:workspace-owner')
    expect(
      getWorktreeExecutionHostId({}, { connectionId: 'repo-owner' }, 'runtime:focused-host')
    ).toBe('ssh:repo-owner')
    expect(getWorktreeExecutionHostId({}, {}, 'runtime:focused-host')).toBe('runtime:focused-host')
  })

  it('derives focused host compatibility from active runtime settings', () => {
    expect(getSettingsFocusedExecutionHostId(null)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(getSettingsFocusedExecutionHostId({ activeRuntimeEnvironmentId: 'runtime-1' })).toBe(
      'runtime:runtime-1'
    )
  })
})
