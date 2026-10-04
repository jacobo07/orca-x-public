import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../shared/terminal-tab-types'
import { createStore, testState } from './persistence-test-harness'

// Why: historical sessions are written by each era's own Store (see the generator) and only COPIED here; the
// loaded content is judged against what the era's writer handed its Store, recorded in provenance.json.
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => [],
  sshConfigHostsToTargets: () => []
}))

// Why: minimum eras that can express terminal tabs across worktrees AND a split layout; raised with the corpus.
const FLOOR_ERAS = 1

type Expected = {
  repos: string[]
  terminalTabsByWorktree: Record<string, string[]>
  splitLeavesByTab: Record<string, number>
  editorFilesByWorktree: Record<string, string[]>
  active: { repoId: unknown; worktreeId: unknown; tabId: unknown }
}
type Provenance = {
  era: string
  sourceSha: string
  outputSha256: string
  outputBytes: number
  eraSelfRead: string
  expected: Expected
  invariantsExercised: string[]
  countsTowardFloor: boolean
}
type CorpusEra = { name: string; dir: string; provenance: Provenance }

// Why: CORPUS_DIR override lets a mutant point the test at a scratch copy with one byte changed.
const CORPUS_DIR =
  process.env.ORCA_PERSISTED_SESSION_CORPUS_DIR ??
  fileURLToPath(new URL('../../tests/fixtures/persisted-sessions', import.meta.url))

function listEras(): CorpusEra[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(CORPUS_DIR, entry.name, 'provenance.json'))
    )
    .map((entry) => {
      const dir = join(CORPUS_DIR, entry.name)
      return {
        name: entry.name,
        dir,
        provenance: JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf-8')) as Provenance
      }
    })
}

function holdsFloorContent(expected: Expected): boolean {
  const counts = Object.values(expected.terminalTabsByWorktree).map((tabs) => tabs.length)
  const tabs = counts.reduce((sum, n) => sum + n, 0)
  const worktrees = counts.filter((n) => n > 0).length
  const leaves = Math.max(0, ...Object.values(expected.splitLeavesByTab))
  return tabs >= 3 && worktrees >= 2 && leaves >= 2
}

function leafCount(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  return node.type === 'split' ? leafCount(node.first) + leafCount(node.second) : 1
}

const eras = listEras()

describe('persisted-session corpus', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-corpus-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('holds enough eras that express terminal tabs across worktrees and a split layout', () => {
    // Arrange
    const floorEras = eras.filter(
      (era) =>
        era.provenance.countsTowardFloor === true && holdsFloorContent(era.provenance.expected)
    )

    // Assert: counted from each era's `expected`, never from the flag alone.
    expect(floorEras.length).toBeGreaterThanOrEqual(FLOOR_ERAS)
  })

  it('never counts an era that cannot express tabs and splits toward the floor', () => {
    const bogus = eras.filter(
      (era) =>
        era.provenance.countsTowardFloor === true && !holdsFloorContent(era.provenance.expected)
    )
    expect(bogus.map((era) => era.name)).toEqual([])
  })

  describe.each(eras.map((era) => [era.name, era] as const))('%s', (_name, era) => {
    const { provenance } = era
    const exercised = new Set(provenance.invariantsExercised)

    it('keeps the bytes its provenance pinned', () => {
      const bytes = readFileSync(join(era.dir, 'orca-data.json'))
      expect(bytes.length).toBe(provenance.outputBytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.outputSha256)
      expect(provenance.eraSelfRead).toBe('ok')
    })

    it('loads through the current loader with its expected content', async () => {
      // Arrange: a copy, so the loader can rewrite its own file without touching the fixture
      mkdirSync(testState.dir, { recursive: true })
      copyFileSync(join(era.dir, 'orca-data.json'), join(testState.dir, 'orca-data.json'))

      // Act
      const store = await createStore()
      const repos = store.getRepos()
      const session = store.getWorkspaceSession()

      // Assert: only the invariants this era's own types let the writer express
      const expected = provenance.expected
      if (exercised.has('repos')) {
        expect(repos.map((r) => `${r.id}|${r.path}|${r.displayName}`).sort()).toEqual(
          expected.repos
        )
      }
      if (exercised.has('terminal-tabs')) {
        const tabs = Object.fromEntries(
          Object.entries(session.tabsByWorktree).map(([worktreeId, list]) => [
            worktreeId,
            list.map((t) => `${t.id}|${t.title}`)
          ])
        )
        expect(tabs).toEqual(expected.terminalTabsByWorktree)
      }
      if (exercised.has('split-layout')) {
        const leaves = Object.fromEntries(
          Object.keys(expected.splitLeavesByTab).map((tabId) => [
            tabId,
            leafCount(session.terminalLayoutsByTabId[tabId]?.root)
          ])
        )
        expect(leaves).toEqual(expected.splitLeavesByTab)
      }
      if (exercised.has('editor-tabs')) {
        const files = Object.fromEntries(
          Object.entries(session.openFilesByWorktree ?? {}).map(([worktreeId, list]) => [
            worktreeId,
            list.map((f) => f.filePath)
          ])
        )
        expect(files).toEqual(expected.editorFilesByWorktree)
      }
      if (exercised.has('active-selection')) {
        expect({
          repoId: session.activeRepoId,
          worktreeId: session.activeWorktreeId,
          tabId: session.activeTabId
        }).toEqual(expected.active)
      }
    })

    it('has no duplicate tab ids and no terminal tab without a pane binding', async () => {
      if (!exercised.has('terminal-tabs')) {
        return
      }
      mkdirSync(testState.dir, { recursive: true })
      copyFileSync(join(era.dir, 'orca-data.json'), join(testState.dir, 'orca-data.json'))

      const session = (await createStore()).getWorkspaceSession()

      const ids = Object.values(session.tabsByWorktree)
        .flat()
        .map((t) => t.id)
      expect(new Set(ids).size).toBe(ids.length)
      const unbound = ids.filter((id) => leafCount(session.terminalLayoutsByTabId[id]?.root) < 1)
      expect(unbound).toEqual([])
    })
  })
})
