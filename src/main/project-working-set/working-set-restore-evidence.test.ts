import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leafId, representativeManifest } from '../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'
import { makeTerminalScrollbackSnapshotRef } from '../terminal-scrollback-snapshots'
import {
  gatherWorkingSetRestoreEvidence,
  type RestoreEvidenceDeps
} from './working-set-restore-evidence'
import { sealWorkingSetScrollback } from './working-set-scrollback-seal'

describe('working-set restore evidence', () => {
  let base: string
  let root: string
  let worktree: string

  const deps = (overrides: Partial<RestoreEvidenceDeps> = {}): RestoreEvidenceDeps => ({
    statPath: (path) => stat(path),
    hostReadableTranscript: vi.fn(async () => null),
    findTranscript: vi.fn(async () => null),
    probeTimeoutMs: 200,
    platform: 'win32',
    ...overrides
  })

  function manifestAt(edit?: (m: ProjectWorkingSetManifest) => void): ProjectWorkingSetManifest {
    const manifest = representativeManifest()
    manifest.scope.location = { kind: 'repo-worktree', repoId: 'repo-1', worktreePath: worktree }
    manifest.entries.find((e) => e.tabId === 'tab-d')!.startupCwd = join(worktree, 'packages')
    edit?.(manifest)
    return manifest
  }

  const recordTranscript = (path: string) => (m: ProjectWorkingSetManifest) => {
    const resume = m.entries[0].panes[0].resume
    if (resume.kind === 'provider-session') {
      resume.providerSession = { ...resume.providerSession, transcriptPath: path }
    }
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orca-working-set-evidence-'))
    root = join(base, 'project-working-sets')
    worktree = join(base, 'worktree')
    mkdirSync(join(worktree, 'packages'), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('reports a local location and cwd as present or absent from the filesystem', async () => {
    const present = await gatherWorkingSetRestoreEvidence(root, manifestAt(), deps())
    expect(present.location).toBe('present')
    expect(present.startupCwdByTabId).toEqual({ 'tab-d': 'present' })
    rmSync(worktree, { recursive: true, force: true })
    const gone = await gatherWorkingSetRestoreEvidence(root, manifestAt(), deps())
    expect(gone.location).toBe('absent')
    expect(gone.startupCwdByTabId).toEqual({ 'tab-d': 'absent' })
  })

  it('never claims absence for a host this process cannot see', async () => {
    rmSync(worktree, { recursive: true, force: true })
    const remote = manifestAt((m) => {
      m.scope.executionHostId = 'ssh:target-1'
      recordTranscript(join(base, 'gone.jsonl'))(m)
    })
    const evidence = await gatherWorkingSetRestoreEvidence(root, remote, deps())
    expect(evidence.location).toBe('unknown')
    expect(evidence.startupCwdByTabId).toEqual({ 'tab-d': 'unknown' })
    expect(evidence.panes[`tab-a:${leafId(1)}`].transcript).toBe('unknown')
  })

  it('reads a refused or stalled probe as unknown, not absent', async () => {
    const refused = deps({
      statPath: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      }
    })
    expect((await gatherWorkingSetRestoreEvidence(root, manifestAt(), refused)).location).toBe(
      'unknown'
    )
    const stalled = deps({ statPath: () => new Promise(() => {}), probeTimeoutMs: 20 })
    expect((await gatherWorkingSetRestoreEvidence(root, manifestAt(), stalled)).location).toBe(
      'unknown'
    )
  })

  it('proves a recorded transcript gone only through a native path', async () => {
    const transcript = join(base, 'claude-session-a.jsonl')
    writeFileSync(transcript, '{}\n')
    const key = `tab-a:${leafId(1)}`
    const read = (m: ProjectWorkingSetManifest, d = deps()) =>
      gatherWorkingSetRestoreEvidence(root, m, d).then((e) => e.panes[key].transcript)
    expect(await read(manifestAt(recordTranscript(transcript)))).toBe('present')
    rmSync(transcript)
    expect(await read(manifestAt(recordTranscript(transcript)))).toBe('absent')
    // A WSL guest path on Windows is resolved through distro probing, where a miss proves nothing.
    expect(await read(manifestAt(recordTranscript('/home/me/.claude/x.jsonl')))).toBe('unknown')
    // On Linux the same shape is a native path and can be proven gone.
    expect(
      await read(
        manifestAt(recordTranscript(join(base, 'gone.jsonl'))),
        deps({ platform: 'linux' })
      )
    ).toBe('absent')
  })

  it('reads a search miss as unknown, because another account may hold the session', async () => {
    const key = `tab-a:${leafId(1)}`
    const miss = await gatherWorkingSetRestoreEvidence(root, manifestAt(), deps())
    expect(miss.panes[key].transcript).toBe('unknown')
    const hit = await gatherWorkingSetRestoreEvidence(
      root,
      manifestAt(),
      deps({ findTranscript: async () => 'C:/x.jsonl' })
    )
    expect(hit.panes[key].transcript).toBe('present')
    expect(hit.panes[`tab-c:${leafId(3)}`].transcript).toBeNull()
  })

  it('reports each pane’s sealed scrollback copy', async () => {
    const manifest = manifestAt()
    const live = join(base, 'terminal-scrollback')
    mkdirSync(live)
    writeFileSync(join(live, `${makeTerminalScrollbackSnapshotRef('tab-c', leafId(3))}.bin`), 'x')
    await sealWorkingSetScrollback(root, manifest, {
      snapshotRoot: live,
      fallbackSnapshotRoot: null
    })
    const evidence = await gatherWorkingSetRestoreEvidence(root, manifest, deps())
    expect(evidence.panes[`tab-c:${leafId(3)}`].sealedScrollback).toBe('present')
    expect(evidence.panes[`tab-a:${leafId(1)}`].sealedScrollback).toBe('absent')
    expect(Object.keys(evidence.panes)).toHaveLength(6)
  })
})
